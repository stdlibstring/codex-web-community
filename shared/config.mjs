import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { z } from 'zod';

const port = z.number().int().min(1024).max(65535);
const absolutePath = z.string().min(1).refine(isAbsolute, '需要绝对路径');
export const configSchema = z.object({
  project: absolutePath,
  codex: absolutePath,
  codexHome: absolutePath,
  server: absolutePath,
  host: z.enum(['127.0.0.1', '0.0.0.0']),
  hostname: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/),
  port,
  workbenchPort: port,
  enginePort: port,
  tlsCert: absolutePath,
  tlsKey: absolutePath,
}).strict().refine((value) => new Set([
  value.port, value.workbenchPort, value.enginePort,
]).size === 3, '三个监听端口必须不同');

export const root = resolve(process.env.CODEX_WEB_ROOT || process.cwd());
export const state = resolve(root, '.artifacts');
export const configFile = resolve(root, 'config.json');

export async function loadConfig() {
  return configSchema.parse(JSON.parse(await readFile(configFile, 'utf8')));
}

export function childEnvironment(config) {
  return {
    ...process.env,
    CODEX_WEB_ROOT: root,
    CODEX_HOME: config.codexHome,
    TMPDIR: resolve(state, 'runtime'),
    TMP: resolve(state, 'runtime'),
    TEMP: resolve(state, 'runtime'),
  };
}
