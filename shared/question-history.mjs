import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import JSONLModule from 'jsonl-parse-stringify';
import { z } from 'zod';

const JSONL = JSONLModule.default;
const questions = z.array(z.object({ title: z.string(), options: z.array(z.string()).nullish().transform(value => value ?? []) }));
const questionCall = z.object({ call_id: z.string(), arguments: z.string(),
  internal_chat_message_metadata_passthrough: z.object({ turn_id: z.string() }) });
const replyId = z.tuple([z.literal('request_user_input_async'), z.string(), z.number().int().nonnegative()]);
const reply = z.object({ questionItemId: z.string(), question: z.string(), answer: z.string() });
const replies = z.union([z.array(reply), reply]);
const start = '<send_user_message_question_reply>';
const end = '</send_user_message_question_reply>';

function normalizeAnswers(contents, itemAliases) {
  if (!itemAliases) return;
  for (const content of contents) {
    if (content?.length !== 1 || content[0].type !== 'text') continue;
    const text = content[0].text.trim();
    if (!text.startsWith(start) || !text.endsWith(end)) continue;
    const value = replies.parse(JSON.parse(text.slice(start.length, -end.length)));
    let changed = false;
    for (const answer of Array.isArray(value) ? value : [value]) {
      const id = replyId.parse(JSON.parse(answer.questionItemId));
      if (!itemAliases.has(id[1]) || itemAliases.get(id[1]) === id[1]) continue;
      id[1] = itemAliases.get(id[1]);
      answer.questionItemId = JSON.stringify(id);
      changed = true;
    }
    if (changed) content[0].text = `${start}\n${JSON.stringify(value)}\n${end}`;
  }
}

export function createQuestionHistory(readHistory) {
  const threads = new Map();
  const histories = new Map();
  const aliases = new Map();
  async function callsFor(path) {
    const info = await stat(path);
    const cached = histories.get(path);
    if (cached?.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.turns;
    const records = JSONL.parse(await readFile(path, 'utf8'));
    const turns = new Map();
    const seen = new Set();
    for (const { type, payload } of records) {
      if (type !== 'response_item' || payload.type !== 'function_call' || payload.name !== 'request_user_input_async') continue;
      const call = questionCall.parse(payload);
      if (seen.has(call.call_id)) continue;
      seen.add(call.call_id);
      const turnId = call.internal_chat_message_metadata_passthrough.turn_id;
      if (!turns.has(turnId)) turns.set(turnId, []);
      turns.get(turnId).push({ id: call.call_id, questions: questions.parse(JSON.parse(call.arguments).questions) });
    }
    histories.set(path, { size: info.size, mtimeMs: info.mtimeMs, turns });
    return turns;
  }
  return async function normalize(method, params, result) {
    if (method === 'turn/input') {
      normalizeAnswers([result.input], aliases.get(params.threadId));
      return result;
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (result.item.type === 'userMessage') normalizeAnswers([result.item.content], aliases.get(params.threadId));
      if (result.item.type === 'steeringUserMessage') normalizeAnswers([result.item.input], aliases.get(params.threadId));
      return result;
    }
    if (result?.thread?.path) threads.set(result.thread.id, { path: result.thread.path, historyMode: result.thread.historyMode });
    if (method === 'thread/list') {
      for (const thread of result.data) if (thread.path) threads.set(thread.id, { path: thread.path, historyMode: thread.historyMode });
    }
    const turns = method === 'thread/turns/list' ? result?.data
      : [...(result?.thread?.turns ?? []), ...(result?.initialTurnsPage?.data ?? [])];
    if (!turns?.length) return result;
    const threadId = params.threadId ?? result.thread.id;
    const contents = turns.flatMap(turn => turn.items ?? []).map(item => item.type === 'userMessage' ? item.content
      : item.type === 'steeringUserMessage' ? item.input : undefined);
    if (!turns.some(turn => turn.items?.some(item => item.type === 'agentMessage' && item.questions?.length))) {
      normalizeAnswers(contents, aliases.get(threadId));
      return result;
    }
    if (!threads.has(threadId)) {
      const response = await readHistory('thread/read', { threadId, includeTurns: false });
      threads.set(threadId, response.thread);
    }
    const thread = threads.get(threadId);
    if (thread.historyMode !== 'legacy') return result;
    const calls = await callsFor(thread.path);
    if (!aliases.has(threadId)) aliases.set(threadId, new Map());
    const itemAliases = aliases.get(threadId);
    // 历史重建产生的 item 编号需要恢复为原始提问工具的 call_id。
    for (const turn of turns) {
      const messages = turn.items?.filter(item => item.type === 'agentMessage' && item.questions?.length) ?? [];
      for (const [index, message] of messages.entries()) {
        const call = calls.get(turn.id)?.[index];
        assert.ok(call, `会话 ${threadId} 的提问缺少原始工具记录：${turn.id}/${index}`);
        assert.deepEqual(questions.parse(message.questions), call.questions, '历史提问与原始工具参数需要一致。');
        itemAliases.set(message.id, call.id);
        itemAliases.set(call.id, call.id);
        message.id = call.id;
      }
    }
    // 已经通过历史页面提交的答案也使用同一个原始提问编号。
    normalizeAnswers(contents, itemAliases);
    return result;
  };
}
