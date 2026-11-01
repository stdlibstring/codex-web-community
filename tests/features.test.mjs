import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { state } from '../shared/config.mjs';
import { baseURL, newClient, login, json } from './helpers.mjs';

test('账户、通知、主题和工作台凭据接口使用真实部署', { timeout: 60_000 }, async t => {
  const client = await newClient();
  t.after(() => client.dispose());
  await t.test('账户管理和通知接口要求登录', async () => {
    for (const path of ['/api/account/security', '/api/notifications']) {
      assert.equal((await client.get(path)).status(), 401);
    }
    assert.equal((await client.post('/api/workbench/secret-key')).status(), 401);
    assert.equal((await client.post('/api/voice/transcribe', { data: Buffer.alloc(0), headers: { 'Content-Type': 'audio/webm' } })).status(), 401);
    for (const path of ['/account', '/account/security', '/forgot-password', '/recover', '/verify-email']) {
      assert.equal((await client.get(path)).status(), 200);
    }
    const source = await client.get('/appearance.js');
    assert.equal(await source.text(), await readFile(resolve(state, '../shared/appearance.js'), 'utf8'));
  });
  await login(client);
  await t.test('账户设置读取和跨站修改限制', async () => {
    const settings = await json(await client.get('/api/account/security'));
    assert.equal(typeof settings.recentAuthentication, 'boolean');
    assert.equal(typeof settings.mail.configured, 'boolean');
    assert.equal((await client.post('/api/account/password', { data: { password: '密码验证', confirmation: '密码验证' } })).status(), 403);
    assert.equal((await client.post('/api/account/password', {
      headers: { Origin: baseURL }, data: { password: '密码验证', confirmation: '密码验证' },
    })).status(), 400);
  });
  await t.test('凭据加密密钥只向登录会话提供', async () => {
    const response = await client.post('/api/workbench/secret-key');
    assert.equal(response.status(), 200);
    assert.deepEqual(await response.body(), await readFile(resolve(state, 'workbench-secret.key')));
    assert.equal(response.headers()['cache-control'], 'no-store');
  });
  await t.test('通过配置端口读取真实引擎的通知和会话状态', async () => {
    const batch = await json(await client.get('/api/notifications'));
    assert.ok(Number.isInteger(batch.cursor));
    assert.deepEqual(batch.replies, []);
    assert.ok(Array.isArray(batch.attention));
    assert.equal((await client.get(`/api/notifications?since=${batch.cursor + 86400}`)).status(), 400);
  });
  await t.test('退出登录撤销账户、通知和凭据访问', async () => {
    await json(await client.post('/api/logout', { data: {} }));
    assert.equal((await client.get('/api/account/security')).status(), 401);
    assert.equal((await client.get('/api/notifications')).status(), 401);
    assert.equal((await client.post('/api/workbench/secret-key')).status(), 401);
  });
});
