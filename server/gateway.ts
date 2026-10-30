import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import secureSession from '@fastify/secure-session';
import serveStatic from '@fastify/static';
import httpProxy from '@fastify/http-proxy';
import { createProxyServer } from 'http-proxy-3';
import { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z, ZodError } from 'zod';
import type { Duplex } from 'node:stream';
import { loadConfig, root, state } from '../shared/config.mjs';

declare module '@fastify/secure-session' {
  interface SessionData { authenticated: boolean; loginAt: number; id: string }
}

const config = await loadConfig();
const upstream = `http://127.0.0.1:${config.workbenchPort}`;
const cookieName = `__Host-codex_web_${config.port}`;
const workbenchToken = (await readFile(resolve(state, 'workbench.token'), 'utf8')).trim();
const auth = z.object({ salt: z.string().regex(/^[a-f0-9]{64}$/), hash: z.string().regex(/^[a-f0-9]{128}$/) }).parse(JSON.parse(await readFile(resolve(state, 'auth.json'), 'utf8')));
const sessions = new Map<string, number>();
const sockets = new Map<string, Set<Duplex>>();
const deriveKey = promisify(scrypt);
function revoke(id: string) {
  sessions.delete(id);
  for (const socket of sockets.get(id) || []) socket.destroy();
  sockets.delete(id);
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
  const origin = request.headers.origin;
  if (origin && origin !== `https://${request.headers.host}`) return reply.code(403).send({ message: '请求来源与当前网站不同。' });
  if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ message: '不允许跨站访问。' });
  if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  const protectedRoute = request.url.startsWith('/workbench') || request.url === '/api/logout';
  if (!protectedRoute) return;
  const expires = sessions.get(request.session.get('id') || '') || 0;
  if (!request.session.get('authenticated') || expires <= Date.now()) {
    if (request.headers['sec-fetch-mode'] === 'navigate') return reply.redirect('/');
    return reply.code(401).send({ message: '请先登录。' });
  }
});
server.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ message: '请求参数格式错误。' });
  const failure = error as { statusCode?: number };
  if (failure.statusCode && failure.statusCode < 500) return reply.code(failure.statusCode).send({ message: '请求无法执行。' });
  request.log.error(error);
  return reply.code(500).send({ message: '连接服务执行失败，请检查本机日志。' });
});
server.get('/api/session', async (request) => ({ authenticated: Boolean(request.session.get('authenticated')) && (sessions.get(request.session.get('id') || '') || 0) > Date.now() }));
server.get('/certificate.crt', async (_request, reply) => {
  return reply.type('application/x-x509-ca-cert')
    .header('Content-Disposition', 'attachment; filename="codex-web.crt"')
    .header('Cache-Control', 'no-store')
    .send(await readFile(config.tlsCert));
});
server.post('/api/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
  const { password } = z.object({ password: z.string().min(1).max(512) }).parse(request.body);
  const candidate = await deriveKey(password, auth.salt, 64) as Buffer;
  if (!timingSafeEqual(candidate, Buffer.from(auth.hash, 'hex'))) return reply.code(401).send({ message: '密码错误。' });
  request.session.regenerate();
  request.session.set('authenticated', true);
  request.session.set('loginAt', Date.now());
  const id = randomUUID();
  request.session.set('id', id);
  for (const [key, expires] of sessions) if (expires <= Date.now()) revoke(key);
  sessions.set(id, Date.now() + 7 * 24 * 3600_000);
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
  if (!id || !session?.get('authenticated') || (sessions.get(id) || 0) <= Date.now()) return reject(401);
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
  for (const [id, expires] of sessions) {
    if (expires > Date.now()) continue;
    revoke(id);
  }
}, 30_000);
await server.register(serveStatic, { root: resolve(root, 'dist/portal'), index: 'portal.html', cacheControl: false });
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
  for (const id of sockets.keys()) revoke(id);
  void server.close();
});
await server.listen({ host: config.host, port: config.port });
