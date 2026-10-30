import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import WebSocket from 'ws';

process.env.CODEX_WEB_ROOT ||= fileURLToPath(new URL('../', import.meta.url));
const { loadConfig, childEnvironment, state } = await import('../shared/config.mjs');
const config = await loadConfig();
const args = process.argv.slice(2);
if (!args.includes('app-server')) {
  const child = spawn(config.codex, args, { env: childEnvironment(config), stdio: 'inherit' });
  child.on('error', (error) => { throw error; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
  child.once('exit', (code) => process.exit(code ?? 1));
} else {
  const token = (await readFile(resolve(state, 'engine.token'), 'utf8')).trim();
  const socket = new WebSocket(`ws://127.0.0.1:${config.enginePort}`, {
    headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 10_000,
  });
  socket.on('error', (error) => { throw error; });
  socket.on('message', (data) => { process.stdout.write(data); process.stdout.write('\n'); });
  socket.on('close', (code) => process.exit(code === 1000 ? 0 : 1));
  await once(socket, 'open');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => socket.send(line));
  input.on('close', () => socket.close(1000));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => socket.close(1000));
}
