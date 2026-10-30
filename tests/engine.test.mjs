import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { config, newClient } from './helpers.mjs';
import { childEnvironment, root } from '../shared/config.mjs';
import { resolve } from 'node:path';

test('官方工作台拒绝缺少令牌的直接访问', async () => {
  const client = await newClient();
  try {
    assert.equal((await client.get(`http://127.0.0.1:${config.workbenchPort}/workbench/`)).status(), 403);
  } finally { await client.dispose(); }
});

test('官方引擎拒绝缺少令牌的连接', { timeout: 10_000 }, async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${config.enginePort}`);
  const response = await new Promise((done, reject) => {
    socket.once('unexpected-response', (_request, incoming) => { incoming.resume(); done(incoming); });
    socket.once('open', () => reject(new Error('没有令牌的引擎连接被接受')));
    socket.once('error', reject);
  });
  assert.equal(response.statusCode, 401);
  socket.terminate();
});

test('插件入口通过真实引擎协议完成初始化', { timeout: 20_000 }, async (t) => {
  const child = spawn(resolve(root, 'scripts/codex-client.sh'), ['app-server'], {
    cwd: config.project, env: childEnvironment(config), stdio: ['pipe', 'pipe', 'inherit'],
  });
  child.on('error', (error) => { throw error; });
  t.after(async () => {
    const closed = once(child, 'exit');
    child.stdin.end();
    await closed;
  });
  const lines = createInterface({ input: child.stdout });
  child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: {
    clientInfo: { name: 'codex_web_community_tests', title: 'Codex Web Community Tests', version: '1.0.0' },
  } }) + '\n');
  for await (const line of lines) {
    const response = JSON.parse(line);
    if (response.id !== 1) continue;
    assert.equal(response.error, undefined);
    assert.ok(response.result.userAgent);
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    lines.close();
    break;
  }
});
