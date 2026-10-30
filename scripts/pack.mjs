import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { root, state } from '../shared/config.mjs';

const files = [
  '.gitignore', '.npmrc', '.github', 'LICENSE', 'README.md', 'PLAN.md', 'VERIFICATION.md',
  'package.json', 'package-lock.json', 'portal.html', 'tsconfig.json',
  'tsconfig.server.json', 'vite.portal.config.ts', 'public', 'src', 'server',
  'shared', 'scripts', 'tests', 'workbench-extension',
];
const output = resolve(state, 'output');
await mkdir(output, { recursive: true, mode: 0o700 });
const archive = resolve(output, 'codex-web-community-1.0.0.tar.gz');
execFileSync('tar', ['--create', '--gzip', '--file', archive, '--', ...files], { cwd: root, stdio: 'inherit' });
console.log(archive);
