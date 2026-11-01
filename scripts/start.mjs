import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { loadConfig, childEnvironment, root, state } from '../shared/config.mjs';
import killTree from 'tree-kill';

const config = await loadConfig();
const env = childEnvironment(config);
await access(resolve(root, 'dist/server/server/gateway.js'));
await access(config.server);
for (const port of [config.port, config.workbenchPort, config.enginePort]) {
  const probe = createServer();
  probe.listen(port, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
}
const children = new Set();
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) killTree(child.pid, 'SIGTERM', error => { if (error) throw error; });
  if (!children.size) process.exit(code);
  const timer = setTimeout(() => {
    for (const child of children) killTree(child.pid, 'SIGKILL', error => { if (error) throw error; });
  }, 10_000);
  timer.unref();
  process.exitCode = code;
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop(0));
process.once('SIGHUP', () => {
  for (const child of children) if (child.spawnfile === process.execPath) child.kill('SIGHUP');
});
function launch(command, args, label) {
  if (stopping) throw new Error('启动过程已终止。');
  const child = spawn(command, args, { cwd: config.project, env, stdio: 'inherit' });
  children.add(child);
  child.once('error', (error) => { console.error(`${label}: ${error.message}`); stop(1); });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${label} 已退出：${signal || code}`);
      stop(1);
    }
  });
}
async function ready(port) {
  const deadline = Date.now() + 60_000;
  while (!stopping && Date.now() < deadline) {
    const available = await new Promise((done) => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.setTimeout(1000, () => socket.destroy());
      socket.once('connect', () => { socket.destroy(); done(true); });
      socket.once('error', () => { socket.destroy(); done(false); });
      socket.once('timeout', () => done(false));
    });
    if (available) return;
    await new Promise((done) => setTimeout(done, 200));
  }
  stop(1);
  throw new Error(`服务未能启动，端口 ${port}。`);
}
launch(config.codex, ['app-server', '--listen', `ws://127.0.0.1:${config.enginePort}`,
  '--ws-auth', 'capability-token', '--ws-token-file', resolve(state, 'engine.token')], 'Codex');
await ready(config.enginePort);
launch(config.server, ['--host', '127.0.0.1', '--port', String(config.workbenchPort),
  '--server-base-path', '/workbench', '--server-data-dir', resolve(state, 'workbench'),
  '--user-data-dir', resolve(state, 'workbench/data'), '--extensions-dir', resolve(state, 'workbench/extensions'),
  '--default-folder', config.project, '--connection-token-file', resolve(state, 'workbench.token'),
  '--accept-server-license-terms', '--disable-telemetry'], 'VS Code Server');
await ready(config.workbenchPort);
launch(process.execPath, [resolve(root, 'dist/server/server/gateway.js')], 'HTTPS');
await ready(config.port);
console.log(`Codex Web: https://${config.hostname}:${config.port}/`);
