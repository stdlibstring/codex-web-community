import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { root, state } from '../shared/config.mjs';

const runtime = resolve(state, 'runtime');
await mkdir(runtime, { recursive: true, mode: 0o700 });
const env = { ...process.env, TMPDIR: runtime, TMP: runtime, TEMP: runtime,
  HF_HOME: resolve(state, 'huggingface'), UV_CACHE_DIR: resolve(state, 'uv-cache'),
  UV_PYTHON_INSTALL_DIR: resolve(state, 'python') };
function run(command, args) {
  const child = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`语音组件安装失败：${command}，退出状态 ${child.status}。`);
}
const venv = resolve(state, 'voice-venv');
run('uv', ['venv', '--python', '3.12', '--allow-existing', venv]);
run('uv', ['pip', 'install', '--python', resolve(venv, 'bin/python'), '-r', resolve(root, 'voice/requirements.txt')]);
run(resolve(venv, 'bin/python'), [resolve(root, 'scripts/voice-model-setup.py')]);
console.log('语音识别依赖与固定版本模型安装完成。');
