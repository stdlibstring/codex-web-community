import { access, chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { isIP } from 'node:net';
import { resolve, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { configSchema, root, state, configFile, childEnvironment } from '../shared/config.mjs';

const { values } = parseArgs({ options: {
  project: { type: 'string' }, codex: { type: 'string' }, server: { type: 'string' },
  'codex-home': { type: 'string' }, hostname: { type: 'string', default: 'localhost' },
  host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '8443' },
  'workbench-port': { type: 'string', default: '8444' },
  'engine-port': { type: 'string', default: '8446' },
  'tls-cert': { type: 'string' }, 'tls-key': { type: 'string' },
  'accept-server-license-terms': { type: 'boolean', default: false },
} });
if (!values['accept-server-license-terms']) {
  throw new Error('请阅读 README 中的 VS Code Server 许可说明，再传入 --accept-server-license-terms。');
}
if (!values.project) throw new Error('需要 --project 指定项目目录。');
if (Boolean(values['tls-cert']) !== Boolean(values['tls-key'])) {
  throw new Error('--tls-cert 和 --tls-key 必须同时提供。');
}
if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error('支持 Linux x64/arm64；Windows 请在 WSL2 中运行。');
}
const codex = values.codex || execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
const config = configSchema.parse({
  project: resolve(values.project), codex: resolve(codex),
  codexHome: resolve(values['codex-home'] || join(state, 'codex-home')),
  server: resolve(values.server || join(state, 'vscode', 'bin', 'code-server')),
  hostname: values.hostname, host: values.host, port: Number(values.port),
  workbenchPort: Number(values['workbench-port']), enginePort: Number(values['engine-port']),
  tlsCert: resolve(values['tls-cert'] || join(state, 'tls.crt')),
  tlsKey: resolve(values['tls-key'] || join(state, 'tls.key')),
});
await access(config.project, constants.R_OK | constants.X_OK);
await access(config.codex, constants.X_OK);
await mkdir(state, { recursive: true, mode: 0o700 });
await chmod(state, 0o700);
await mkdir(join(state, 'runtime'), { recursive: true, mode: 0o700 });
await mkdir(config.codexHome, { recursive: true, mode: 0o700 });
const files = await readdir(root);
if (files.includes('config.json')) {
  const existing = configSchema.parse(JSON.parse(await readFile(configFile, 'utf8')));
  if (JSON.stringify(existing) !== JSON.stringify(config)) {
    throw new Error('现有 config.json 与参数不同；请明确编辑配置，安装程序不会覆盖它。');
  }
}
const env = childEnvironment(config);
const help = execFileSync(config.codex, ['app-server', '--help'], { env, encoding: 'utf8' });
for (const flag of ['--ws-auth', '--ws-token-file']) {
  if (!help.includes(flag)) throw new Error(`Codex 缺少 ${flag}，请更新 Codex CLI。`);
}
const privateFiles = new Set(await readdir(state));
async function createPrivate(name, content) {
  if (!privateFiles.has(name)) {
    await writeFile(join(state, name), content, { flag: 'wx', mode: 0o600 });
  }
}
if (!privateFiles.has('auth.json')) {
  if (privateFiles.has('access.json')) throw new Error('access.json 已存在且 auth.json 缺失，请检查运行目录。');
  const password = randomBytes(24).toString('base64url');
  const salt = randomBytes(32).toString('hex');
  await createPrivate('auth.json', JSON.stringify({ salt, hash: scryptSync(password, salt, 64).toString('hex') }));
  await createPrivate('access.json', JSON.stringify({ password }));
}
await createPrivate('session.key', randomBytes(32));
await createPrivate('engine.token', randomBytes(32).toString('base64url'));
await createPrivate('workbench.token', randomBytes(32).toString('base64url'));
if (!values['tls-cert']) {
  if (privateFiles.has('tls.crt') !== privateFiles.has('tls.key')) {
    throw new Error('TLS 证书和私钥必须成对存在。');
  }
  if (!privateFiles.has('tls.crt')) {
    const host = isIP(config.hostname) ? `IP:${config.hostname}` : `DNS:${config.hostname}`;
    const san = [...new Set(['DNS:localhost', 'IP:127.0.0.1', 'IP:::1', host])].join(',');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '365', '-nodes',
      '-keyout', config.tlsKey, '-out', config.tlsCert, '-subj', '/CN=Codex Web',
      '-addext', `subjectAltName=${san}`], { env, stdio: 'pipe' });
    await chmod(config.tlsKey, 0o600);
  }
}
await access(config.tlsCert, constants.R_OK);
await access(config.tlsKey, constants.R_OK);
if (!values.server && !privateFiles.has('vscode')) {
  const archive = join(state, 'runtime', 'vscode.tar.gz');
  const platform = `server-linux-${process.arch}-web`;
  execFileSync('curl', ['--fail', '--location', '--retry', '2', '--max-time', '300',
    `https://update.code.visualstudio.com/1.143.1/${platform}/stable`, '--output', archive], { env, stdio: 'inherit' });
  const unpack = join(state, 'runtime', `vscode-${randomUUID()}`);
  await mkdir(unpack, { mode: 0o700 });
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', unpack], { env, stdio: 'inherit' });
  await rename(unpack, join(state, 'vscode'));
}
await access(config.server, constants.X_OK);
const data = join(state, 'workbench', 'data');
const extensions = join(state, 'workbench', 'extensions');
await mkdir(join(data, 'Machine'), { recursive: true, mode: 0o700 });
await mkdir(extensions, { recursive: true, mode: 0o700 });
const settingsPath = join(data, 'Machine', 'settings.json');
const existingSettings = (await readdir(dirname(settingsPath))).includes('settings.json');
if (!existingSettings) await writeFile(settingsPath, JSON.stringify({
  'chatgpt.cliExecutable': join(root, 'scripts', 'codex-client.sh'),
  'chatgpt.openOnStartup': true,
  'workbench.startupEditor': 'none',
  'workbench.activityBar.location': 'hidden',
  'workbench.statusBar.visible': false,
  'window.menuBarVisibility': 'hidden',
  'window.commandCenter': false,
  'window.layoutControl.enabled': false,
  'telemetry.telemetryLevel': 'off',
}, null, 2), { flag: 'wx', mode: 0o600 });
const extensionArgs = ['--accept-server-license-terms', '--user-data-dir', data, '--extensions-dir', extensions];
const installed = execFileSync(config.server, [...extensionArgs, '--list-extensions', '--show-versions'], { env, encoding: 'utf8' });
if (!installed.split(/\r?\n/).includes('openai.chatgpt@26.51007.21434')) {
  execFileSync(config.server, [...extensionArgs, '--install-extension', 'openai.chatgpt@26.51007.21434'], { env, stdio: 'inherit' });
}
const layout = join(state, 'runtime', 'codex-web-layout.vsix');
execFileSync(process.execPath, [join(root, 'node_modules', '@vscode', 'vsce', 'vsce'),
  'package', '--no-dependencies', '--allow-missing-repository', '--out', layout], {
  cwd: join(root, 'workbench-extension'), env, stdio: 'inherit',
});
execFileSync(config.server, [...extensionArgs, '--install-extension', layout, '--force'], { env, stdio: 'inherit' });
await chmod(join(root, 'scripts', 'codex-client.sh'), 0o755);
if (!files.includes('config.json')) {
  await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
console.log('安装完成。执行 npm run login 登录自己的 Codex，然后执行 npm run build 和 npm start。');
console.log('网站访问密码保存在 .artifacts/access.json。配置保存在 config.json。');
