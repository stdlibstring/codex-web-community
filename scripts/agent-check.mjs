import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { root, state, childEnvironment } from '../shared/config.mjs';
import { withDeployment } from './with-deployment.mjs';

await withDeployment(async (config) => {
  const child = spawn(resolve(root, 'scripts/codex-client.sh'), ['app-server'], {
    cwd: config.project, env: childEnvironment(config), stdio: ['pipe', 'pipe', 'inherit'],
  });
  child.on('error', (error) => { throw error; });
  const closed = once(child, 'exit');
  const disconnected = closed.then(() => { throw new Error('模型请求完成前，Codex 连接已经关闭。'); });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let next = 0;
  let complete;
  const finished = new Promise((done) => { complete = done; });
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  let timer;
  const timeout = new Promise((_done, reject) => {
    timer = setTimeout(() => reject(new Error('真实模型验证超过 240 秒。')), 240_000);
  });
  const call = (method, params) => Promise.race([disconnected, timeout, new Promise((done, reject) => {
    const id = ++next;
    pending.set(id, { done, reject });
    send({ id, method, params });
  })]);
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.done(message.result);
    } else if (message.method === 'turn/completed') {
      complete(message.params.turn);
    }
  });
  try {
    await call('initialize', { clientInfo: { name: 'codex_web_community_agent_check',
      title: 'Codex Web Community Agent Check', version: '1.0.0' } });
    send({ method: 'initialized' });
    const { thread } = await call('thread/start', {
      cwd: config.project, approvalPolicy: 'never', sandbox: 'workspace-write',
      model: process.env.CODEX_TEST_MODEL,
    });
    const marker = `codex-web-community-${randomUUID()}`;
    const file = resolve(config.project, `proof-${marker}.txt`);
    await call('turn/start', { threadId: thread.id, input: [{ type: 'text',
      text: `请使用命令工具执行 pwd，然后使用文件编辑工具创建 ${file}，内容只有一行 ${marker}。只操作这个文件，不读写其他文件，不访问 /tmp，不执行 Git 操作。最后报告实际命令输出和文件路径。`,
    }] });
    const turn = await Promise.race([finished, disconnected, timeout]);
    assert.equal(turn.status, 'completed', JSON.stringify(turn.error));
    assert.equal((await readFile(file, 'utf8')).trim(), marker);
    const result = await call('thread/read', { threadId: thread.id, includeTurns: true });
    assert.ok(result.thread.turns.length >= 1);
    const record = { completed: true, model: process.env.CODEX_TEST_MODEL || 'configured default',
      checks: ['真实模型完成请求', '指定项目目录内的真实文件逐字验证', '官方会话历史读取'],
      threadId: thread.id };
    await writeFile(resolve(state, 'agent-verification.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(record, null, 2));
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    await closed;
  }
});
