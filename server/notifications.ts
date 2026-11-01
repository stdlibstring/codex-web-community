import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { z } from 'zod';
import { createQuestionHistory } from '../shared/question-history.mjs';
import { loadConfig } from '../shared/config.mjs';

const config = await loadConfig();

const threadPage = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string().nullable(), preview: z.string(),
    cwd: z.string(), updatedAt: z.number(), parentThreadId: z.string().nullable().optional() })),
  nextCursor: z.string().nullable(),
});
const turnPage = z.object({
  data: z.array(z.object({ id: z.string(), status: z.string(), completedAt: z.number().nullable() })),
  nextCursor: z.string().nullable(),
});
const liveThread = threadPage.shape.data.element.extend({
  source: z.unknown(), status: z.object({ type: z.string() }),
});
const liveThreadPage = z.object({ data: z.array(liveThread), nextCursor: z.string().nullable() });
const attentionRequest = z.object({
  id: z.union([z.string(), z.number()]), method: z.string(),
  params: z.object({ threadId: z.string(), turnId: z.string().nullable().optional(),
    itemId: z.string().optional(), startedAtMs: z.number().optional(), message: z.string().optional(),
    questions: z.array(z.object({ id: z.string(), question: z.string(), isSecret: z.boolean(),
      options: z.array(z.object({ label: z.string(), description: z.string() })).nullable() })).optional() }),
});
const attentionKinds = new Map([
  ['item/commandExecution/requestApproval', 'approval'],
  ['item/fileChange/requestApproval', 'approval'],
  ['item/permissions/requestApproval', 'approval'],
  ['item/tool/requestUserInput', 'question'],
  ['mcpServer/elicitation/request', 'question'],
]);
const questionItem = z.object({ type: z.string(), id: z.string() }).passthrough();
const questionMessage = z.object({
  questions: z.array(z.object({ title: z.string(), options: z.array(z.string()).nullable().optional() })).nullable().optional(),
});
const answerMessage = z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) });
const questionTurnPage = z.object({ data: z.array(z.object({ id: z.string(), rootTurnId: z.string().nullable(), status: z.string(),
  startedAt: z.number().nullable(), items: z.array(questionItem) })), nextCursor: z.string().nullable() });
const questionReply = z.object({ questionItemId: z.string(), answer: z.string() });
const questionReplies = z.union([z.array(questionReply), questionReply.transform(value => [value])]);
type QuestionNotification = { id: string; threadId: string; kind: string; createdAt: number; title: string; cwd: string;
  question: string; options: string[]; canReply: boolean; questionItemId?: string; turnId?: string; rootTurnId?: string;
  requestKey?: string; questionKey?: string };
type Attention = { id: string; threadId: string; kind: string; createdAt: number; request: z.infer<typeof attentionRequest> };

export class NotificationAnswerError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}

let database: Database.Database | undefined;
function answers() {
  if (!database) {
    const path = resolve(process.env.CODEX_WEB_ROOT || process.cwd(), '.artifacts/notification-answers.sqlite');
    database = new Database(path);
    chmodSync(path, 0o600);
    database.pragma('journal_mode = WAL');
    database.exec(`CREATE TABLE IF NOT EXISTS answers (
      id TEXT PRIMARY KEY, answer TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
  }
  return database;
}
function receipt(id: string) {
  return answers().prepare('SELECT answer, status FROM answers WHERE id = ?').get(id) as { answer: string; status: string } | undefined;
}
const answerQueues = new Map<string, Promise<void>>();

let connection: ReturnType<typeof connectNotifications> | undefined;

function connectNotifications(token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${config.enginePort}`, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 10_000 });
  let sequence = 0;
  const attention = new Map<string, Attention>();
  const threads = new Map<string, z.infer<typeof liveThread>>();
  const subscribed = new Set<string>();
  const questionCache = new Map<string, { updatedAt: number; questions: QuestionNotification[] }>();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const fail = (error: Error) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  socket.on('error', fail);
  socket.on('close', () => {
    if (connection?.socket === socket) connection = undefined;
    fail(new Error('通知服务与引擎的连接已关闭。'));
  });
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.method) {
      if (attentionKinds.has(message.method)) {
        const request = attentionRequest.parse(message);
        const { threadId, turnId, itemId, startedAtMs } = request.params;
        const key = JSON.stringify([threadId, request.id]);
        attention.set(key, { id: JSON.stringify([threadId, turnId, itemId, request.id]), threadId,
          kind: attentionKinds.get(request.method)!, createdAt: Math.floor((startedAtMs ?? Date.now()) / 1000), request });
      } else if (message.method === 'serverRequest/resolved') {
        attention.delete(JSON.stringify([message.params.threadId, message.params.requestId]));
      } else if (message.method === 'thread/closed') {
        subscribed.delete(message.params.threadId);
        threads.delete(message.params.threadId);
        questionCache.delete(message.params.threadId);
        for (const [key, request] of attention) {
          if (request.threadId === message.params.threadId) attention.delete(key);
        }
      }
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const normalize = createQuestionHistory((method, params) => request(method, params));
  const call = async (method: string, params: { threadId?: string; [key: string]: unknown }): Promise<unknown> => normalize(method, params, await request(method, params));
  const request = (method: string, params: { threadId?: string; [key: string]: unknown }): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`通知接口超时：${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const ready = (async () => {
    await once(socket, 'open');
    await call('initialize', { clientInfo: { name: 'codex_remote_notifications', version: '1.4.0' }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: 'initialized', params: {} }));
  })();
  return { socket, ready, call, attention, threads, subscribed, questionCache };
}

export function closeNotifications() {
  connection?.socket.close();
  connection = undefined;
  database?.close();
  database = undefined;
}

export async function readNotifications(token: string, since: number, after: number) {
  const cursor = Math.floor(Date.now() / 1000);
  const lower = Math.max(since, after - 60);
  const client = connection ??= connectNotifications(token);
  await client.ready;
  const { call, attention, threads, subscribed, questionCache } = client;
  const replies: { id: string; threadId: string; title: string; cwd: string; completedAt: number }[] = [];
  const questions = new Map<string, QuestionNotification>();
  const visited = new Set<string>();
  {
    const visible = new Map<string, z.infer<typeof liveThread>>();
    let loadedCursor: string | null = null;
    do {
      const page = liveThreadPage.parse(await call('thread/list', { cursor: loadedCursor, limit: 100, sortKey: 'updated_at', sortDirection: 'desc', sourceKinds: ['vscode'] }));
      for (const thread of page.data) {
        if (!thread.parentThreadId) visible.set(thread.id, thread);
      }
      loadedCursor = page.nextCursor;
    } while (loadedCursor);
    for (const threadId of questionCache.keys()) {
      if (!visible.has(threadId)) questionCache.delete(threadId);
    }
    for (const [threadId, thread] of visible) {
        threads.set(threadId, thread);
        const active = thread.status.type === 'active';
        const cached = questionCache.get(threadId);
        if (!active && cached?.updatedAt === thread.updatedAt) {
          for (const question of cached.questions) questions.set(question.id, question);
          continue;
        }
        if (active && !subscribed.has(threadId)) {
          // 保持订阅以接收异步重发的请求和处理结果。
          await call('thread/resume', { threadId, excludeTurns: true });
          subscribed.add(threadId);
        }
        const threadQuestions = new Map<string, QuestionNotification>();
        const currentTurns: z.infer<typeof questionTurnPage>['data'] = [];
        let turnsCursor: string | null = null;
        let rootTurnId: string | undefined;
        do {
          const turns = questionTurnPage.parse(await call('thread/turns/list', { threadId, cursor: turnsCursor, limit: active ? 10 : 1, sortDirection: 'desc', itemsView: 'full' }));
          if (!active && rootTurnId === undefined && turns.data[0]?.status !== 'completed') break;
          rootTurnId ??= turns.data[0]?.rootTurnId ?? turns.data[0]?.id;
          currentTurns.push(...turns.data.filter(turn => (turn.rootTurnId ?? turn.id) === rootTurnId));
          if (turns.data.some(turn => (turn.rootTurnId ?? turn.id) !== rootTurnId)) break;
          turnsCursor = turns.nextCursor;
        } while (turnsCursor);
        for (const turn of currentTurns.reverse()) {
          for (const item of turn.items) {
            if (item.type === 'agentMessage') {
              const message = questionMessage.parse(item);
              for (const [index, question] of (message.questions ?? []).entries()) {
                const questionId = JSON.stringify(['request_user_input_async', item.id, index]);
                const id = JSON.stringify([threadId, questionId]);
                threadQuestions.set(id, { id, threadId, kind: 'question', createdAt: turn.startedAt ?? cursor,
                  title: (thread.name || thread.preview || 'Codex').slice(0, 120), cwd: thread.cwd,
                  question: question.title, options: question.options ?? [], canReply: true,
                  questionItemId: questionId, turnId: turn.id, rootTurnId: turn.rootTurnId ?? turn.id });
              }
            } else if (item.type === 'userMessage') {
              const { content } = answerMessage.parse(item);
              if (content.length !== 1 || content[0].type !== 'text') continue;
              // 官方客户端的回答使用固定文本标记包裹 JSON；内容交给标准 JSON 解析器。
              const text = content[0].text!.trim();
              const start = '<send_user_message_question_reply>';
              const end = '</send_user_message_question_reply>';
              if (!text.startsWith(start) || !text.endsWith(end)) continue;
              for (const reply of questionReplies.parse(JSON.parse(text.slice(start.length, -end.length)))) {
                threadQuestions.delete(JSON.stringify([threadId, reply.questionItemId]));
              }
            }
          }
        }
        for (const question of threadQuestions.values()) questions.set(question.id, question);
        if (active) questionCache.delete(threadId);
        else questionCache.set(threadId, { updatedAt: thread.updatedAt, questions: [...threadQuestions.values()] });
    }
    let next: string | null = null;
    do {
      const page = threadPage.parse(await call('thread/list', { cursor: next, limit: 100, sortKey: 'updated_at', sortDirection: 'desc', sourceKinds: ['vscode'] }));
      for (const thread of page.data) {
        if (thread.updatedAt < lower || thread.parentThreadId || visited.has(thread.id)) continue;
        visited.add(thread.id);
        let turnsCursor: string | null = null;
        do {
          const turns = turnPage.parse(await call('thread/turns/list', { threadId: thread.id, cursor: turnsCursor, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded' }));
          for (const turn of turns.data) {
            if (turn.status !== 'completed' || turn.completedAt === null || turn.completedAt < lower) continue;
            replies.push({ id: `${thread.id}:${turn.id}`, threadId: thread.id,
              title: (thread.name || thread.preview || 'Codex').slice(0, 120), cwd: thread.cwd, completedAt: turn.completedAt });
          }
          turnsCursor = turns.nextCursor;
          if (turns.data.some(turn => turn.completedAt !== null && turn.completedAt < lower)) break;
        } while (turnsCursor);
      }
      next = page.nextCursor;
      if (page.data.some(thread => thread.updatedAt < lower)) break;
    } while (next);
    return { cursor, replies: replies.sort((a, b) => a.completedAt - b.completedAt || a.id.localeCompare(b.id)),
      attention: [...questions.values(), ...[...attention.entries()].flatMap(([key, request]): QuestionNotification[] => {
        const thread = threads.get(request.threadId);
        if (!thread) return [];
        const base = { id: request.id, threadId: thread.id, kind: request.kind, createdAt: request.createdAt,
          title: (thread.name || thread.preview || 'Codex').slice(0, 120), cwd: thread.cwd };
        if (request.request.method === 'item/tool/requestUserInput') {
          return request.request.params.questions!.flatMap(question => {
            const id = JSON.stringify([request.id, question.id]);
            if (receipt(id)?.status === 'sent') return [];
            return [{ ...base, id, question: question.isSecret ? '此问题需要在应用内回答。' : question.question,
              options: question.isSecret ? [] : (question.options ?? []).map(option => option.label),
              canReply: !question.isSecret, requestKey: key, questionKey: question.id }];
          });
        }
        return [{ ...base, question: request.request.params.message ?? '', options: [], canReply: false }];
      })] };
  }
}

export async function answerNotification(token: string, id: string, answer: string) {
  const previous = answerQueues.get(id);
  let release!: () => void;
  const queued = new Promise<void>(resolve => { release = resolve; });
  answerQueues.set(id, queued);
  await previous;
  try {
    const saved = receipt(id);
    if (saved && saved.answer !== answer) throw new NotificationAnswerError('此问题已经提交了其他答案，请打开会话查看。');
    if (saved?.status === 'sent') return { ok: true, alreadyAnswered: true };
    const now = Math.floor(Date.now() / 1000);
    const batch = await readNotifications(token, now, now);
    const question = batch.attention.find(item => item.id === id);
    if (!question?.canReply) throw new NotificationAnswerError('此问题已处理或已过期，请打开会话查看。');
    const client = connection!;
    if (!client.subscribed.has(question.threadId)) {
      await client.call('thread/resume', { threadId: question.threadId, excludeTurns: true });
      client.subscribed.add(question.threadId);
    }
    answers().prepare("INSERT INTO answers VALUES (?, ?, 'pending', ?) ON CONFLICT(id) DO NOTHING").run(id, answer, Date.now());
    if (question.questionItemId) {
      const text = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: question.questionItemId,
        question: question.question, answer }])}\n</send_user_message_question_reply>`;
      // turn/start 同时支持向正在执行的回复提交输入，避免检查状态与发送之间的竞争。
      await client.call('turn/start', { threadId: question.threadId,
        clientUserMessageId: createHash('sha256').update(id).digest('hex'),
        parentTurnId: question.turnId, rootTurnId: question.rootTurnId, input: [{ type: 'text', text }] });
      client.questionCache.delete(question.threadId);
    } else {
      const request = client.attention.get(question.requestKey!);
      if (!request) throw new NotificationAnswerError('此问题已处理或已过期，请打开会话查看。');
      // 同一请求中的问题分别保存，收齐全部答案后提交原始请求。
      answers().prepare("UPDATE answers SET status = 'sent' WHERE id = ?").run(id);
      const result: Record<string, { answers: string[] }> = {};
      for (const item of request.request.params.questions!) {
        const savedAnswer = receipt(JSON.stringify([request.id, item.id]));
        if (!savedAnswer || savedAnswer.status !== 'sent') return { ok: true, alreadyAnswered: false };
        result[item.id] = { answers: [savedAnswer.answer] };
      }
      client.socket.send(JSON.stringify({ id: request.request.id, result: { answers: result } }));
      client.attention.delete(question.requestKey!);
    }
    answers().prepare("UPDATE answers SET status = 'sent' WHERE id = ?").run(id);
    return { ok: true, alreadyAnswered: false };
  } finally {
    release();
    if (answerQueues.get(id) === queued) answerQueues.delete(id);
  }
}
