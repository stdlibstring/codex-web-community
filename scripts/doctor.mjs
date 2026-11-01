import { execFileSync } from 'node:child_process';
import { access, stat, readFile, readdir } from 'node:fs/promises';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, childEnvironment, root, state } from '../shared/config.mjs';

const config = await loadConfig();
await access(config.codex, constants.X_OK);
await access(config.server, constants.X_OK);
await access(config.project, constants.R_OK | constants.W_OK | constants.X_OK);
const files = await readdir(state);
if (!files.includes('account.sqlite') && !files.includes('auth.json')) throw new Error('账户尚未初始化。');
for (const path of ['session.key', 'engine.token', 'workbench.token', 'workbench-secret.key',
  ...['auth.json', 'access.json', 'account.sqlite', 'account.key'].filter(name => files.includes(name))]) {
  const info = await stat(resolve(state, path));
  if (info.mode & 0o077) throw new Error(`${path} 需要仅允许当前用户读取。`);
}
await access(resolve(root, 'scripts/codex-client.sh'), constants.X_OK);
const cert = new X509Certificate(await readFile(config.tlsCert));
if (Date.parse(cert.validTo) <= Date.now()) throw new Error('TLS 证书已过期。');
const key = createPrivateKey(await readFile(config.tlsKey));
if (!cert.checkPrivateKey(key)) throw new Error('TLS 证书与私钥不匹配。');
const settings = JSON.parse(await readFile(resolve(state, 'workbench/data/Machine/settings.json'), 'utf8'));
if (settings['chatgpt.cliExecutable'] !== resolve(root, 'scripts/codex-client.sh')) {
  throw new Error('工作台中的 Codex 入口路径与安装目录不同，请更新 settings.json。');
}
const env = childEnvironment(config);
console.log(execFileSync(config.codex, ['--version'], { env, encoding: 'utf8' }).trim());
execFileSync(config.codex, ['login', 'status'], { env, stdio: 'inherit' });
console.log(`配置与权限检查通过：https://${config.hostname}:${config.port}/`);
