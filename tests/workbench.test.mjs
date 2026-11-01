import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { installWorkbench } from '../scripts/workbench-install.mjs';
import { config } from './helpers.mjs';
import { state } from '../shared/config.mjs';

test('重复安装保留真实组件内容，插件脚本通过语法检查', { timeout: 60_000 }, async () => {
  const extensions = resolve(state, 'workbench/extensions');
  const codex = (await readdir(extensions)).find(name => name.startsWith('openai.chatgpt-26.51007.21434-'));
  assert.ok(codex);
  const scripts = [
    resolve(dirname(dirname(config.server)), 'out/vs/code/browser/workbench/workbench.js'),
    resolve(extensions, codex, 'webview/assets/app-initial-fee819fe4f22.js'),
    resolve(extensions, codex, 'webview/assets/app-initial-41ab338a184f.js'),
    resolve(extensions, codex, 'webview/assets/header-4afcdefd370e.js'),
  ];
  const before = await Promise.all(scripts.map(path => readFile(path)));
  await installWorkbench(config, extensions);
  await installWorkbench(config, extensions);
  for (const [index, path] of scripts.entries()) {
    assert.deepEqual(await readFile(path), before[index], `重复安装需要保留 ${path} 的内容。`);
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
  }
});
