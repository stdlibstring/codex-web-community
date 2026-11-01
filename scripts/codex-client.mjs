import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { createQuestionHistory } from '../shared/question-history.mjs';

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
  const requests = new Map();
  const lookups = new Map();
  const normalize = createQuestionHistory((method, params) => new Promise((resolve, reject) => {
    const id = `codex-web-question-history:${randomUUID()}`;
    const timer = setTimeout(() => { lookups.delete(id); reject(new Error('读取提问历史路径超时。')); }, 15_000);
    lookups.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  }));
  let output = Promise.resolve();
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    const lookup = lookups.get(message.id);
    if (lookup && !message.method) {
      lookups.delete(message.id);
      clearTimeout(lookup.timer);
      if (message.error) lookup.reject(new Error(message.error.message));
      else lookup.resolve(message.result);
      return;
    }
    output = output.then(async () => {
      const request = !message.method && requests.get(message.id);
      if (request) {
        requests.delete(message.id);
        if (!message.error) message.result = await normalize(request.method, request.params ?? {}, message.result);
      }
      if (message.method === 'item/started' || message.method === 'item/completed') {
        message.params = await normalize(message.method, message.params, message.params);
      }
      process.stdout.write(`${JSON.stringify(message)}\n`);
    });
  });
  socket.on('close', (code) => process.exit(code === 1000 ? 0 : 1));
  await once(socket, 'open');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let incoming = Promise.resolve();
  input.on('line', line => {
    incoming = incoming.then(async () => {
      const message = JSON.parse(line);
      if (message.method === 'turn/start' || message.method === 'turn/steer') {
        message.params = await normalize('turn/input', message.params, message.params);
      }
      if (message.method && message.id !== undefined) requests.set(message.id, message);
      socket.send(JSON.stringify(message));
    });
  });
  input.on('close', () => socket.close(1000));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => socket.close(1000));
}
