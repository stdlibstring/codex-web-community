import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { state } from '../shared/config.mjs';
import { withDeployment } from './with-deployment.mjs';

await withDeployment(async (config) => {
  const { password } = JSON.parse(await readFile(resolve(state, 'access.json'), 'utf8'));
  const proxyURL = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BINARY,
    proxy: proxyURL ? { server: proxyURL, bypass: '127.0.0.1,localhost' } : undefined,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const record = { checks: [], completed: false };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.setDefaultTimeout(30_000);
  try {
    await page.goto(`https://127.0.0.1:${config.port}/`);
    await page.getByLabel('访问密码').waitFor();
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const field = await page.getByLabel('访问密码').boundingBox();
      assert.ok(field && field.width >= 100 && field.x >= 0 && field.x + field.width <= width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    record.checks.push('手机与电脑宽度的登录表单');
    for (const theme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    }
    await page.getByRole('button', { name: '开启黑夜模式', exact: true }).click();
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    record.checks.push('系统主题、手动切换与刷新保存');
    await page.getByLabel('访问密码').fill(password);
    await page.getByRole('button', { name: '使用访问密码登录', exact: true }).click();
    await page.waitForURL('**/workbench/');
    await page.goto(`https://127.0.0.1:${config.port}/account/security`);
    await page.getByRole('heading', { name: '登录与安全', exact: true }).waitFor();
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    await page.getByRole('dialog', { name: '验证身份', exact: true }).waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '配置邮件服务', exact: true }).waitFor();
    record.checks.push('真实账户设置与身份验证窗口');
    await page.goto(`https://127.0.0.1:${config.port}/workbench/`);
    await page.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
    record.checks.push('登录后加载真实官方工作台');
    const manage = page.getByRole('banner').getByRole('button', { name: 'Manage', exact: true });
    const trust = page.getByRole('button', { name: 'Trust Folder & Continue', exact: true });
    await manage.or(trust).or(page.locator('iframe[src*="extensionId=openai.chatgpt"]')).first().waitFor({ timeout: 60_000 });
    if (await trust.isVisible()) await trust.click();
    else if (await manage.isVisible()) {
      await manage.click();
      await page.getByRole('button', { name: 'Trust', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.locator('.monaco-modal-editor-block').waitFor({ state: 'hidden' });
    }
    const frame = page.frameLocator('iframe[src*="extensionId=openai.chatgpt"]').frameLocator('iframe#active-frame');
    await frame.getByRole('button').first().waitFor({ timeout: 90_000 });
    const text = await frame.locator('body').innerText();
    assert.ok(text.trim().length > 0);
    record.checks.push('加载官方 Codex 插件界面');
    const signIn = frame.getByRole('button', { name: 'Sign in with ChatGPT', exact: true });
    if (await signIn.count()) {
      await signIn.waitFor();
      record.checks.push('独立 Codex 账户的登录入口');
    } else {
      const next = frame.getByRole('button', { name: 'Next', exact: true });
      if (await next.count()) {
        for (const title of ['Codex in your IDE', 'Hand off to Codex in the cloud', 'Turn TODOs into Codex tasks']) {
          await frame.getByRole('heading', { name: title, exact: true }).waitFor();
          await page.waitForTimeout(600);
          await next.click();
        }
        await frame.getByText('Decide how much autonomy you want to grant', { exact: true }).waitFor();
        await page.waitForTimeout(600);
        await next.click();
      }
      await frame.locator('[contenteditable="true"]').first().waitFor({ timeout: 60_000 });
      record.checks.push('完成官方引导后显示对话输入区域');
    }
    record.completed = true;
    console.log(JSON.stringify(record, null, 2));
  } finally {
    const frames = await Promise.allSettled(page.frames().map(async (frame) => ({
      url: frame.url(), text: await frame.locator('body').innerText({ timeout: 2000 }),
    })));
    await writeFile(resolve(state, 'browser-dom.json'), JSON.stringify(frames, null, 2), { mode: 0o600 });
    await writeFile(resolve(state, 'browser-console.json'), JSON.stringify(errors, null, 2), { mode: 0o600 });
    await writeFile(resolve(state, 'browser-verification.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
    await browser.close();
  }
});
