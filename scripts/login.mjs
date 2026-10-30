import { spawn } from 'node:child_process';
import { loadConfig, childEnvironment } from '../shared/config.mjs';

const config = await loadConfig();
const args = process.argv.slice(2);
const child = spawn(config.codex, ['login', ...args], {
  env: childEnvironment(config), stdio: 'inherit',
});
child.on('error', (error) => { throw error; });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
child.once('exit', (code) => process.exit(code ?? 1));
