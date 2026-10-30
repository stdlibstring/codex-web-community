import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { root, childEnvironment } from '../shared/config.mjs';
import { config, newClient } from './helpers.mjs';

test('重复启动在端口占用时终止，已运行的服务保持可访问', { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, [resolve(root, 'scripts/start.mjs')], {
    cwd: root, env: childEnvironment(config), stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.on('error', (error) => { throw error; });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(stderr, /EADDRINUSE/);
  const client = await newClient();
  try { assert.equal((await client.get('/api/session')).status(), 200); }
  finally { await client.dispose(); }
});
