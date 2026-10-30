import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { load } from 'cheerio';
import WebSocket from 'ws';
import { baseURL, newClient, login, json, config } from './helpers.mjs';

test('官方插件入口的 HTTPS、HTTP 与 WebSocket 身份验证', { timeout: 30_000 }, async (t) => {
  const client = await newClient();
  t.after(() => client.dispose());
  let configuration;
  await t.test('证书与登录页面响应头有效', async () => {
    const ca = await readFile(config.tlsCert);
    const response = await new Promise((resolve, reject) => {
      https.get(baseURL, { ca, rejectUnauthorized: true }, (incoming) => { incoming.resume(); resolve(incoming); }).on('error', reject);
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    const certificate = await client.get('/certificate.crt');
    assert.equal(certificate.status(), 200);
    assert.match(certificate.headers()['content-type'], /application\/x-x509-ca-cert/);
    assert.match(certificate.headers()['content-disposition'], /attachment; filename="codex-web.crt"/);
    assert.equal(await certificate.text(), ca.toString());
  });
  await t.test('未登录时无法读取工作台和主机文件', async () => {
    for (const path of ['/workbench/', `/workbench/stable-version/vscode-remote-resource?path=${encodeURIComponent(config.codexHome + '/auth.json')}`]) {
      assert.equal((await client.get(path)).status(), 401);
    }
    for (const path of ['/.artifacts/access.json', '/.artifacts/tls.key', '/config.json', '/server/gateway.ts', '/api/rpc']) assert.equal((await client.get(path)).status(), 404);
  });
  await t.test('未登录时 WebSocket 连接也被拒绝', async () => {
    const socket = new WebSocket(`${baseURL.replace('https:', 'wss:')}/workbench/`, { rejectUnauthorized: false });
    const response = await new Promise((resolve, reject) => {
      socket.once('unexpected-response', (_request, incoming) => { incoming.resume(); resolve(incoming); });
      socket.once('open', () => reject(new Error('未登录的 WebSocket 被接受')));
      socket.once('error', reject);
    });
    assert.equal(response.statusCode, 401);
    socket.terminate();
  });
  await t.test('登录校验与安全 Cookie 有效', async () => {
    assert.equal((await client.post('/api/login', { data: {} })).status(), 400);
    assert.equal((await client.post('/api/login', { data: { password: 'invalid-password-check' } })).status(), 401);
    const response = await login(client);
    assert.match(response.headers()['set-cookie'], /HttpOnly/);
    assert.match(response.headers()['set-cookie'], /Secure/);
    assert.match(response.headers()['set-cookie'], /SameSite=Strict/i);
    assert.equal((await json(await client.get('/api/session'))).authenticated, true);
  });
  await t.test('转发官方页面并保留外部地址及原有内容限制', async () => {
    const response = await client.get('/workbench/');
    assert.equal(response.status(), 200);
    const html = load(await response.text());
    configuration = JSON.parse(html('#vscode-workbench-web-configuration').attr('data-settings'));
    assert.equal(configuration.remoteAuthority, new URL(baseURL).host);
    assert.equal(configuration.serverBasePath, '/workbench');
    assert.ok(response.headers()['content-security-policy']);
    const asset = html('link[rel="stylesheet"]').first().attr('href');
    assert.ok(asset);
    assert.equal((await client.get(asset)).status(), 200);
    const worker = new URL('../../../workbench/services/extensions/worker/webWorkerExtensionHostIframe.html', new URL(asset, baseURL));
    const resource = await client.get(worker.href);
    assert.equal(resource.status(), 200);
    assert.doesNotMatch(resource.headers()['content-security-policy'] || '', /frame-ancestors 'none'/);
  });
  await t.test('跨站访问被拒绝', async () => {
    assert.equal((await client.get('/workbench/', { headers: { Origin: 'https://untrusted.invalid' } })).status(), 403);
    assert.equal((await client.get('/workbench/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status(), 403);
  });
  await t.test('错误 Cookie 无法获得工作台访问权限', async () => {
    const anonymous = await newClient();
    try {
      const response = await anonymous.get('/workbench/', {
        headers: { Cookie: `__Host-codex_web_${config.port}=invalid-cookie` },
      });
      assert.equal(response.status(), 401);
    } finally { await anonymous.dispose(); }
  });
  await t.test('退出登录会关闭已连接的官方 WebSocket，并撤销 Cookie', async () => {
    const session = (await client.storageState()).cookies.find((cookie) => cookie.name.startsWith('__Host-codex_web_'));
    const url = new URL(configuration.callbackRoute, baseURL);
    url.protocol = 'wss:';
    url.pathname = url.pathname.slice(0, -'/callback'.length);
    url.searchParams.set('reconnectionToken', randomUUID());
    url.searchParams.set('reconnection', 'false');
    url.searchParams.set('skipWebSocketFrames', 'false');
    const socket = new WebSocket(url, { rejectUnauthorized: false, headers: { Cookie: `${session.name}=${session.value}`, Origin: baseURL } });
    await once(socket, 'open');
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(10_000) });
    await json(await client.post('/api/logout', { data: {} }));
    await closed;
    assert.equal(socket.readyState, WebSocket.CLOSED);
    assert.equal((await client.get('/workbench/')).status(), 401);
    assert.equal((await client.get('/workbench/', { headers: { Cookie: `${session.name}=${session.value}` } })).status(), 401);
  });
});
