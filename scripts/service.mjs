import { loadConfig, root, state } from '../shared/config.mjs';
import { resolve, dirname } from 'node:path';
import { writeFile } from 'node:fs/promises';

await loadConfig();
if (/[\r\n]/.test(root)) throw new Error('服务安装目录不能包含换行。');
const quote = (value) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
const service = [
  '[Unit]', 'Description=Codex Web Community', 'After=network-online.target',
  'Wants=network-online.target', '', '[Service]', 'Type=simple',
  `WorkingDirectory=${root.replaceAll('%', '%%')}`,
  `ExecStart=${quote(process.execPath)} ${quote(resolve(root, 'scripts/start.mjs'))}`,
  'ExecReload=/bin/kill -HUP $MAINPID',
  `Environment=${quote(`PATH=${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`)}`,
  `Environment=${quote(`TMPDIR=${resolve(state, 'runtime')}`)}`,
  `EnvironmentFile=-${resolve(root, '.env').replaceAll('%', '%%')}`,
  'UMask=0077', 'Restart=on-failure', 'RestartSec=5', 'TimeoutStopSec=20',
  'KillMode=control-group', '', '[Install]', 'WantedBy=default.target', '',
].join('\n');
const output = resolve(state, 'codex-web-community.service');
await writeFile(output, service, { mode: 0o600 });
console.log(`服务配置已生成：${output}`);
