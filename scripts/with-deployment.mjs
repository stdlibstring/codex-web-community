import { spawn } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { request } from 'playwright';
import { resolve } from 'node:path';
import { loadConfig, root, state, childEnvironment } from '../shared/config.mjs';

export async function withDeployment(run) {
  const config = await loadConfig();
  const log = await open(resolve(state, 'tests-server.log'), 'w', 0o600);
  const server = spawn(process.execPath, [resolve(root, 'scripts/start.mjs')], {
    cwd: root, env: childEnvironment(config), stdio: ['ignore', log.fd, log.fd],
  });
  server.on('error', (error) => { throw error; });
  const closed = once(server, 'exit');
  const client = await request.newContext({ ignoreHTTPSErrors: true });
  try {
    const deadline = Date.now() + 60_000;
    let available = false;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(await readFile(resolve(state, 'tests-server.log'), 'utf8'));
      available = await client.get(`https://127.0.0.1:${config.port}/api/session`, { timeout: 1000 })
        .then((response) => response.ok(), () => false);
      if (available) break;
      await new Promise((done) => setTimeout(done, 200));
    }
    if (!available) throw new Error('测试服务启动超时。');
    await run(config);
  } finally {
    await client.dispose();
    server.kill('SIGTERM');
    await closed;
    await log.close();
  }
}
