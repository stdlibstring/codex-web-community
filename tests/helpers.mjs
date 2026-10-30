import { readFile } from 'node:fs/promises';
import { request } from 'playwright';
import { loadConfig, state } from '../shared/config.mjs';
import { resolve } from 'node:path';

export const config = await loadConfig();
export const baseURL = `https://127.0.0.1:${config.port}`;
export const { password } = JSON.parse(await readFile(resolve(state, 'access.json'), 'utf8'));
export const newClient = () => request.newContext({ baseURL, ignoreHTTPSErrors: true });
export async function login(client) {
  const response = await client.post('/api/login', { data: { password } });
  if (!response.ok()) throw new Error(`登录失败：${response.status()} ${await response.text()}`);
  return response;
}
export async function json(response) {
  if (!response.ok()) throw new Error(`接口失败：${response.status()} ${await response.text()}`);
  return response.json();
}
