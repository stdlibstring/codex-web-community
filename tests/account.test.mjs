import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { request } from 'playwright';
import { root, state, childEnvironment } from '../shared/config.mjs';
import { config } from './helpers.mjs';

test('独立真实账户完成迁移、密码修改、会话撤销和进程重启', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(resolve(state, 'account-check-'));
  const storage = resolve(directory, '.artifacts');
  await mkdir(storage, { mode: 0o700 });
  for (const name of ['dist', 'shared', 'workbench-extension']) await symlink(resolve(root, name), resolve(directory, name));
  const password = randomBytes(32).toString('base64url');
  const salt = randomBytes(32).toString('hex');
  await writeFile(resolve(storage, 'auth.json'), JSON.stringify({ salt, hash: scryptSync(password, salt, 64).toString('hex') }), { mode: 0o600 });
  for (const name of ['session.key', 'workbench-secret.key']) await writeFile(resolve(storage, name), randomBytes(32), { mode: 0o600 });
  for (const name of ['workbench.token', 'engine.token']) await writeFile(resolve(storage, name), randomBytes(32).toString('base64url'), { mode: 0o600 });
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((done, reject) => listener.close(error => error ? reject(error) : done()));
  await writeFile(resolve(directory, 'config.json'), JSON.stringify({ ...config, port }), { mode: 0o600 });
  const baseURL = `https://127.0.0.1:${port}`;
  const client = await request.newContext({ baseURL, ignoreHTTPSErrors: true, extraHTTPHeaders: { Origin: baseURL } });
  const device = await request.newContext({ baseURL, ignoreHTTPSErrors: true });
  t.after(async () => { await client.dispose(); await device.dispose(); });
  let server;
  let closed;
  let log = '';
  async function start() {
    server = spawn(process.execPath, [resolve(root, 'dist/server/server/gateway.js')], {
      cwd: root, env: { ...childEnvironment(config), CODEX_WEB_ROOT: directory,
        CODEX_PASSKEY_RP_ID: '', SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.on('error', error => { throw error; });
    server.stdout.on('data', data => { log += data; });
    server.stderr.on('data', data => { log += data; });
    closed = once(server, 'exit');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      assert.equal(server.exitCode, null, log);
      const available = await client.get('/api/session', { timeout: 1000 }).then(response => response.ok(), () => false);
      if (available) return;
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`账户服务启动超时：${log}`);
  }
  async function stop() { if (server.exitCode === null) { server.kill('SIGTERM'); await closed; } }
  t.after(stop);
  await start();
  assert.equal((await client.post('/api/login', { data: { password } })).status(), 200);
  assert.equal((await device.post('/api/login', { data: { password } })).status(), 200);
  const next = randomBytes(32).toString('base64url');
  assert.equal((await client.post('/api/account/password', { data: { password: next, confirmation: next } })).status(), 200);
  assert.equal((await device.get('/api/account/security')).status(), 401);
  assert.equal((await client.get('/api/account/security')).status(), 401);
  assert.equal((await client.post('/api/login', { data: { password } })).status(), 401);
  assert.equal((await client.post('/api/login', { data: { password: next } })).status(), 200);
  const database = await readFile(resolve(storage, 'account.sqlite-wal'));
  assert.equal(database.includes(Buffer.from(password)), false);
  assert.equal(database.includes(Buffer.from(next)), false);
  await stop();
  await start();
  assert.equal((await client.get('/api/account/security')).status(), 401);
  assert.equal((await client.post('/api/login', { data: { password: next } })).status(), 200);
});
