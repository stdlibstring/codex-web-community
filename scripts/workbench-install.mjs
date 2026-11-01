import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { applyPatch, parsePatch, reversePatch } from 'diff';
import { root } from '../shared/config.mjs';

export async function installWorkbench(config, extensions) {
  const patches = new Map();
  const modules = [];
  const source = resolve(root, 'workbench-extension');
  async function patch(base, name) {
    for (const change of parsePatch(await readFile(resolve(source, name), 'utf8'))) {
      const path = resolve(base, change.oldFileName.slice(2));
      if (!path.startsWith(base + sep)) throw new Error('组件补丁包含无效路径。');
      const changes = patches.get(path) ?? [];
      changes.push(change);
      patches.set(path, changes);
    }
  }
  const server = dirname(dirname(config.server));
  await patch(server, 'titlebar-menu.patch');
  const workbench = resolve(server, 'out/vs/code/browser/workbench');
  for (const [name, alias] of [
    ['controls', 'controls'], ['indexed-db-lifetime', 'database'], ['microphone', 'microphone'],
    ['tabs', 'tabs'], ['dialogs', 'dialogs'],
  ]) modules.push([resolve(source, `${name}.mjs`), resolve(workbench, `codex-web-${alias}.js`)]);

  for (const folder of await readdir(extensions, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const base = resolve(extensions, folder.name);
    const manifest = JSON.parse(await readFile(resolve(base, 'package.json'), 'utf8'));
    const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
    if (id === 'openai.chatgpt') {
      if (manifest.version !== '26.51007.21434') throw new Error('Codex 插件版本需要为 26.51007.21434。');
      for (const name of ['webview-theme', 'image-upload', 'input-selection', 'navigation', 'microphone']) {
        await patch(base, `${name}.patch`);
      }
      for (const [name, alias] of [['image-upload', 'images'], ['input-selection', 'input-selection'], ['navigation', 'navigation'], ['microphone', 'microphone']]) {
        modules.push([resolve(source, `${name}.mjs`), resolve(base, 'webview/assets', `codex-web-${alias}.js`)]);
      }
    } else if (id === 'anthropic.claude-code') {
      if (manifest.version !== '2.1.314') throw new Error('Claude Code 插件版本需要为 2.1.314。');
      await patch(base, 'claude-webview-theme.patch');
    } else if (id === 'alibaba-cloud.tongyi-lingma') {
      if (manifest.version !== '2.6.10') throw new Error('Qoder CN 插件版本需要为 2.6.10。');
      await patch(base, 'qoder-sidebar.patch');
      await patch(base, 'qoder-webview-theme.patch');
    }
  }
  const updates = new Map();
  for (const [path, changes] of patches) {
    const original = await readFile(path, 'utf8');
    let restored = original;
    for (const change of changes.toReversed()) {
      restored = applyPatch(restored, reversePatch(change));
      if (restored === false) break;
    }
    if (restored !== false) continue;
    let updated = original;
    for (const change of changes) {
      updated = applyPatch(updated, change);
      if (updated === false) throw new Error(`组件补丁无法应用：${path}，请检查官方组件版本。`);
    }
    updates.set(path, updated);
  }
  for (const [path, content] of updates) await writeFile(path, content);
  for (const [from, to] of modules) await copyFile(from, to);
  console.log('工作台主题、手机操作、附件、录音和导航组件安装完成。');
}
