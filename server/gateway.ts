import Fastify, { type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import secureSession from '@fastify/secure-session';
import serveStatic from '@fastify/static';
import httpProxy from '@fastify/http-proxy';
import { createProxyServer } from 'http-proxy-3';
import { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { Duplex } from 'node:stream';
import { answerNotification, closeNotifications, NotificationAnswerError, readNotifications } from './notifications.js';
import { PasskeyError, registerPasskeys } from './passkeys.js';
import { registerVoice } from './voice.js';
import { AccountError, AccountStore } from './account-store.js';
import { registerAccount } from './account-routes.js';
import { loadConfig, root, state } from '../shared/config.mjs';

declare module '@fastify/secure-session' {
  interface SessionData { authenticated: boolean; loginAt: number; id: string; accountRevision: number }
}

const config = await loadConfig();
const upstream = `http://127.0.0.1:${config.workbenchPort}`;
const cookieName = `__Host-codex_web_${config.port}`;
const workbenchToken = (await readFile(resolve(state, 'workbench.token'), 'utf8')).trim();
const engineToken = (await readFile(resolve(state, 'engine.token'), 'utf8')).trim();
const workbenchSecretKey = await readFile(resolve(state, 'workbench-secret.key'));
if (workbenchSecretKey.length !== 32) throw new Error('工作台凭据加密密钥长度错误。');
const account = new AccountStore(state);
let accountRevision = account.account().revision;
const sessions = new Map<string, number>();
const credentialSessions = new Map<string, string>();
const sockets = new Map<string, Set<Duplex>>();
function revoke(id: string) {
  sessions.delete(id);
  credentialSessions.delete(id);
  for (const socket of sockets.get(id) || []) socket.destroy();
  sockets.delete(id);
}
function authenticated(request: FastifyRequest) {
  return Boolean(request.session.get('authenticated')) && request.session.get('accountRevision') === account.account().revision
    && (sessions.get(request.session.get('id') || '') || 0) > Date.now();
}
function revokeAll() {
  for (const id of sessions.keys()) revoke(id);
  accountRevision = account.account().revision;
}
function establishSession(request: FastifyRequest, passkeyId?: string, revision = account.account().revision) {
  if (revision !== account.account().revision) throw new AccountError('账户已变更，请重新登录。', 401);
  const previous = request.session.get('id');
  if (previous) revoke(previous);
  request.session.regenerate();
  request.session.set('authenticated', true);
  request.session.set('loginAt', Date.now());
  request.session.set('accountRevision', revision);
  const id = randomUUID();
  request.session.set('id', id);
  for (const [key, expires] of sessions) if (expires <= Date.now()) revoke(key);
  sessions.set(id, Date.now() + 7 * 24 * 3600_000);
  if (passkeyId) credentialSessions.set(id, passkeyId);
}
const server = Fastify({
  https: { key: await readFile(config.tlsKey), cert: await readFile(config.tlsCert) },
  bodyLimit: 16 * 1024 * 1024,
  logger: {
    level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    serializers: { req: (request) => ({ method: request.method, path: new URL(request.url, 'https://localhost').pathname, host: request.headers.host }) },
  },
});
await server.register(helmet, { contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
  objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
  upgradeInsecureRequests: null,
} }, crossOriginEmbedderPolicy: false });
await server.register(rateLimit, { global: false });
await server.register(secureSession, {
  key: await readFile(resolve(state, 'session.key')), cookieName, expiry: 7 * 24 * 3600,
  cookie: { path: '/', secure: true, httpOnly: true, sameSite: 'strict', maxAge: 7 * 24 * 3600 },
});
server.addHook('onRequest', async (request, reply) => {
  if (accountRevision !== account.account().revision) revokeAll();
  const origin = request.headers.origin;
  if (origin && origin !== `https://${request.headers.host}`) return reply.code(403).send({ message: '请求来源与当前网站不同。' });
  const documentNavigation = request.method === 'GET' && request.headers['sec-fetch-mode'] === 'navigate'
    && request.headers['sec-fetch-dest'] === 'document';
  if (request.headers['sec-fetch-site'] === 'cross-site' && !documentNavigation) return reply.code(403).send({ message: '不允许跨站访问。' });
  const browserWorkbench = documentNavigation && /^\/workbench(?:\/|\?|$)/.test(request.url)
    && !request.headers['user-agent']?.includes('CodexRemote/');
  if (browserWorkbench && process.env.CODEX_PASSKEY_APP_ORIGIN && `https://${request.headers.host}` === process.env.CODEX_PASSKEY_WEB_ORIGIN
    && process.env.CODEX_PASSKEY_APP_ORIGIN !== process.env.CODEX_PASSKEY_WEB_ORIGIN) {
    return reply.header('Cache-Control', 'no-store').redirect(`${process.env.CODEX_PASSKEY_APP_ORIGIN}/#passkeyStart`);
  }
  if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  const protectedRoute = request.url.startsWith('/workbench') || request.url === '/api/logout' || request.url.startsWith('/api/voice/')
    || request.url.startsWith('/api/workbench/')
    || request.url.split('?')[0] === '/api/notifications' || request.url.split('?')[0] === '/api/notifications/answer';
  if (!protectedRoute) return;
  if (!authenticated(request)) {
    if (request.headers['sec-fetch-mode'] === 'navigate') return reply.redirect('/');
    return reply.code(401).send({ message: '请先登录。' });
  }
});
server.addHook('onSend', async (request, reply, payload) => {
  const path = request.url.split('?')[0];
  if (path.startsWith('/workbench/') && (path.endsWith('/workbench.js') || /\/codex-web-[^/]+\.js$/.test(path))) {
    reply.header('Cache-Control', 'no-cache');
  }
  if ((path === '/workbench' || path === '/workbench/') && reply.statusCode === 200
    && String(reply.getHeader('content-type')).startsWith('text/html')) {
    reply.header('Cache-Control', 'no-store');
    reply.setCookie('vscode-secret-key-path', '/api/workbench/secret-key', {
      path: '/workbench', secure: true, sameSite: 'strict', maxAge: 7 * 24 * 3600,
    });
  }
  return payload;
});
server.setErrorHandler((error, request, reply) => {
  if (error instanceof NotificationAnswerError) return reply.code(error.statusCode).send({ message: error.message });
  if (error instanceof PasskeyError || error instanceof AccountError) return reply.code(error.statusCode).send({ message: error.message });
  if (error instanceof ZodError) return reply.code(400).send({ message: '请求参数格式错误。' });
  const failure = error as { statusCode?: number };
  if (failure.statusCode && failure.statusCode < 500) return reply.code(failure.statusCode).send({ message: '请求无法执行。' });
  request.log.error(error);
  return reply.code(500).send({ message: '连接服务执行失败，请检查本机日志。' });
});
server.get('/api/session', async (request) => ({ authenticated: authenticated(request) }));
server.post('/api/workbench/secret-key', async (_request, reply) => {
  return reply.type('application/octet-stream').send(workbenchSecretKey);
});
registerAccount(server, account, { authenticated, revokeAll });
await registerVoice(server, root);
registerPasskeys(server, state, {
  authenticated,
  login: establishSession,
  revision: () => account.account().revision,
  credentialId: request => credentialSessions.get(request.session.get('id') || ''),
  revokeCredential: (credentialId) => {
    for (const [id, key] of credentialSessions) if (key === credentialId) revoke(id);
  },
});
server.get('/api/notifications', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async request => {
  const { since, after } = z.object({ since: z.coerce.number().int().min(0).optional(), after: z.coerce.number().int().min(0).optional() }).parse(request.query);
  const now = Math.floor(Date.now() / 1000);
  if ((since !== undefined && since > now) || (after !== undefined && (after < (since ?? now) || after > now))) throw new ZodError([]);
  const notifications = await readNotifications(engineToken, since ?? now, after ?? since ?? now);
  if (since === undefined) notifications.replies = [];
  return notifications;
});
server.post('/api/notifications/answer', { bodyLimit: 64 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async request => {
  const { id, answer } = z.object({ id: z.string().min(1).max(4096), answer: z.string().trim().min(1).max(8000) }).strict().parse(request.body);
  return answerNotification(engineToken, id, answer);
});
server.get('/appearance.js', async (_request, reply) => reply.type('application/javascript').header('Cache-Control', 'no-cache')
  .send(await readFile(resolve(root, 'shared/appearance.js'), 'utf8')));
server.get('/workbench/codex-appearance.mjs', async (_request, reply) => reply.type('application/javascript').header('Cache-Control', 'no-cache')
  .send(await readFile(resolve(root, 'workbench-extension/appearance.mjs'), 'utf8')));
server.get('/certificate.crt', async (_request, reply) => {
  return reply.type('application/x-x509-ca-cert')
    .header('Content-Disposition', 'attachment; filename="codex-web.crt"')
    .header('Cache-Control', 'no-store')
    .send(await readFile(config.tlsCert));
});
server.get('/downloads/codex-remote.apk', async (_request, reply) => {
  return reply.type('application/vnd.android.package-archive')
    .header('Content-Disposition', 'attachment; filename="codex-remote.apk"')
    .header('Cache-Control', 'no-store')
    .sendFile('codex-remote.apk', resolve(state, 'android-download'));
});
server.get('/downloads/codex-remote.apk.sha256', async (_request, reply) => {
  return reply.type('text/plain').header('Cache-Control', 'no-store')
    .send(await readFile(resolve(state, 'android-download/codex-remote.apk.sha256'), 'utf8'));
});
server.post('/api/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
  const { password } = z.object({ password: z.string().min(1).max(512) }).parse(request.body);
  const revision = await account.verify(password);
  if (revision === null) return reply.code(401).send({ message: '密码错误。' });
  establishSession(request, undefined, revision);
  return { ok: true };
});
server.post('/api/logout', async (request) => {
  const id = request.session.get('id')!;
  revoke(id);
  request.session.delete();
  return { ok: true };
});
await server.register(httpProxy, {
  upstream, prefix: '/workbench', rewritePrefix: '/workbench',
  config: { helmet: { skipRoute: true } },
  replyOptions: {
    rewriteRequestHeaders: (request, headers) => ({ ...headers, cookie: `vscode-tkn=${workbenchToken}`, host: request.headers.host!, 'x-forwarded-host': request.headers.host!, 'x-forwarded-proto': 'https' }),
  },
});
const streamProxy = createProxyServer({ target: upstream, ws: true, xfwd: true, xfwdWsProtoAsHttp: true, headers: { cookie: `vscode-tkn=${workbenchToken}` } });
streamProxy.on('error', (error, _request, connection) => {
  connection.destroy();
  server.log.warn({ message: error.message }, '工作台连接已关闭');
});
server.server.on('upgrade', (request, socket, head) => {
  const reject = (status: number) => {
    const reply = new ServerResponse(request);
    reply.assignSocket(request.socket);
    reply.writeHead(status, { Connection: 'close' });
    reply.end();
  };
  const path = new URL(request.url!, 'https://localhost').pathname;
  if (path !== '/workbench' && !path.startsWith('/workbench/')) return reject(404);
  if (request.headers.origin && request.headers.origin !== `https://${request.headers.host}`) return reject(403);
  if (request.headers['sec-fetch-site'] === 'cross-site') return reject(403);
  const cookie = server.parseCookie(request.headers.cookie || '')[cookieName];
  const session = cookie ? server.decodeSecureSession(cookie) : null;
  const id = session?.get('id');
  if (!id || !session?.get('authenticated') || session.get('accountRevision') !== account.account().revision
    || (sessions.get(id) || 0) <= Date.now()) return reject(401);
  const connections = sockets.get(id) || new Set<Duplex>();
  connections.add(socket);
  sockets.set(id, connections);
  socket.once('close', () => {
    connections.delete(socket);
    if (!connections.size) sockets.delete(id);
  });
  streamProxy.ws(request, socket, head, {}, (error) => {
    server.log.error({ message: error.message }, '工作台连接终止');
    socket.destroy();
  });
});
const expiryTimer = setInterval(() => {
  if (accountRevision !== account.account().revision) revokeAll();
  for (const [id, expires] of sessions) {
    if (expires > Date.now()) continue;
    revoke(id);
  }
}, 500);
await server.register(serveStatic, { root: resolve(root, 'dist/portal'), index: 'portal.html', cacheControl: false });
server.get('/account', async (_request, reply) => reply.sendFile('portal.html'));
server.get('/account/security', async (_request, reply) => reply.sendFile('portal.html'));
for (const path of ['/forgot-password', '/recover', '/verify-email']) {
  server.get(path, async (_request, reply) => reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').sendFile('portal.html'));
}
server.setNotFoundHandler((_request, reply) => reply.code(404).send({ message: '页面不存在。' }));
server.server.on('tlsClientError', (error) => server.log.warn({ message: error.message }, 'TLS 连接未完成'));
process.on('SIGHUP', () => {
  void Promise.all([readFile(config.tlsKey), readFile(config.tlsCert)]).then(([key, cert]) => {
    server.server.setSecureContext({ key, cert });
    server.log.info('TLS 证书已重新加载');
  });
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  clearInterval(expiryTimer);
  closeNotifications();
  for (const id of sockets.keys()) revoke(id);
  void server.close();
});
await server.listen({ host: config.host, port: config.port });
