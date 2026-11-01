import type { FastifyInstance, FastifyRequest } from 'fastify';
import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON,
  type AuthenticatorTransport,
} from '@simplewebauthn/server';

declare module '@fastify/secure-session' {
  interface SessionData { passkeyFlow: string; passkeyRevision: number; passkeyReturnId: string; passkeyReturnProof: string }
}

type Credential = {
  id: string; name: string; public_key: Buffer; counter: number; transports: string;
  device_type: string; backed_up: number; created_at: number; last_used_at: number | null;
};
type Challenge = {
  id: string; kind: string; challenge: string; session_id: string | null;
  name: string | null; expires_at: number;
};
type SessionAccess = {
  authenticated: (request: FastifyRequest) => boolean;
  login: (request: FastifyRequest, passkeyId?: string, revision?: number) => void;
  revision: () => number;
  revokeCredential: (id: string) => void;
  credentialId: (request: FastifyRequest) => string | undefined;
};

export class PasskeyError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

const credentialId = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/);
const responseSchema = z.object({
  id: credentialId, rawId: credentialId, type: z.literal('public-key'),
  response: z.object({ clientDataJSON: z.string().min(1).max(16384) }).passthrough(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
}).passthrough();
const registrationSchema = responseSchema.extend({ response: responseSchema.shape.response.extend({
  attestationObject: z.string().min(1).max(60000),
}) });
const authenticationSchema = responseSchema.extend({ response: responseSchema.shape.response.extend({
  authenticatorData: z.string().min(1).max(16384), signature: z.string().min(1).max(16384),
  userHandle: z.string().min(1).max(256),
}) });
const challengeLifetime = 5 * 60_000;

export function registerPasskeys(server: FastifyInstance, state: string, access: SessionAccess) {
  const rpID = process.env.CODEX_PASSKEY_RP_ID;
  if (!rpID) {
    server.get('/api/passkeys/status', async () => ({ enabled: false, nativeOnly: false }));
    return;
  }
  const configuredOrigin = z.string().parse(process.env.CODEX_PASSKEY_APP_ORIGIN);
  const url = new URL(configuredOrigin);
  if (url.protocol !== 'https:' || url.origin !== configuredOrigin || url.username || url.password) {
    throw new Error('CODEX_PASSKEY_APP_ORIGIN 必须是 HTTPS origin，不能包含路径。');
  }
  if (isIP(rpID) || new URL(`https://${rpID}`).hostname !== rpID || !rpID.includes('.')) throw new Error('CODEX_PASSKEY_RP_ID 必须是固定域名。');
  const certificate = z.string().regex(/^(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/)
    .parse(process.env.CODEX_ANDROID_CERTIFICATE_SHA256).toUpperCase();
  const browserOrigin = process.env.CODEX_PASSKEY_WEB_ORIGIN || (url.hostname === rpID ? configuredOrigin : null);
  if (browserOrigin) {
    const browserURL = new URL(browserOrigin);
    if (browserURL.protocol !== 'https:' || browserURL.origin !== browserOrigin || browserURL.hostname !== rpID
      || browserURL.username || browserURL.password) throw new Error('CODEX_PASSKEY_WEB_ORIGIN 必须是通行密钥域名下的 HTTPS origin。');
  }
  const allowedOrigins = new Set([configuredOrigin, ...(browserOrigin ? [browserOrigin] : [])]);
  const expectedOrigins = [`android:apk-key-hash:${Buffer.from(certificate.replaceAll(':', ''), 'hex').toString('base64url')}`];
  if (browserOrigin) expectedOrigins.push(browserOrigin);
  const databasePath = resolve(state, 'passkeys.sqlite');
  const database = new Database(databasePath);
  chmodSync(databasePath, 0o600);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id = 1), user_id BLOB NOT NULL, rp_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key BLOB NOT NULL,
      counter INTEGER NOT NULL, transports TEXT NOT NULL, device_type TEXT NOT NULL,
      backed_up INTEGER NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS challenges (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, challenge TEXT NOT NULL,
      session_id TEXT, name TEXT, expires_at INTEGER NOT NULL
    );
  `);
  database.prepare('INSERT OR IGNORE INTO identity VALUES (1, ?, ?)').run(randomBytes(32), rpID);
  const identity = database.prepare('SELECT user_id, rp_id FROM identity WHERE id = 1').get() as { user_id: Buffer; rp_id: string };
  if (identity.rp_id !== rpID) throw new Error('通行密钥数据库绑定的域名与当前配置不同。');
  const userID = new Uint8Array(identity.user_id);
  const userHandle = Buffer.from(userID).toString('base64url');
  const credentials = () => database.prepare('SELECT * FROM passkeys ORDER BY created_at DESC').all() as Credential[];
  const secureRoute = (request: FastifyRequest) => {
    const origin = `https://${request.headers.host}`;
    if (!allowedOrigins.has(origin) || request.headers.origin !== origin) {
      throw new PasskeyError('请从通行密钥登录地址执行此操作。', 403);
    }
  };
  const manage = (request: FastifyRequest, recent = true) => {
    if (!access.authenticated(request)) throw new PasskeyError('请先登录。', 401);
    if (recent && Date.now() - (request.session.get('loginAt') || 0) > challengeLifetime) {
      throw new PasskeyError('请重新验证身份后管理通行密钥。', 403);
    }
  };
  const saveChallenge = (request: FastifyRequest, kind: string, challenge: string, name?: string) => {
    const id = randomUUID();
    database.transaction(() => {
      database.prepare('DELETE FROM challenges WHERE expires_at <= ? OR id = ?').run(Date.now(), request.session.get('passkeyFlow') || '');
      database.prepare('INSERT INTO challenges VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, kind, challenge, kind === 'registration' ? request.session.get('id') : null, name || null, Date.now() + challengeLifetime);
    })();
    request.session.set('passkeyFlow', id);
    request.session.set('passkeyRevision', access.revision());
  };
  const consumeChallenge = (request: FastifyRequest, kind: string) => {
    const challenge = database.prepare('DELETE FROM challenges WHERE id = ? RETURNING *')
      .get(request.session.get('passkeyFlow') || '') as Challenge | undefined;
    request.session.set('passkeyFlow', '');
    if (!challenge || request.session.get('passkeyRevision') !== access.revision() || challenge.kind !== kind || challenge.expires_at <= Date.now()
      || (kind === 'registration' && challenge.session_id !== request.session.get('id'))) {
      throw new PasskeyError('本次验证已失效，请重新操作。');
    }
    return challenge;
  };
  const rateLimit = { max: 10, timeWindow: '1 minute' };
  const returns = new Map<string, {
    proof: string; revision: number; expires: number; approved: boolean; credentialId?: string;
  }>();
  const returnIdSchema = z.object({ id: z.uuid() });
  const returnFlow = (id: string) => {
    const flow = returns.get(id);
    if (!flow || flow.expires <= Date.now() || flow.revision !== access.revision()) {
      returns.delete(id);
      throw new PasskeyError('本次登录已失效，请从直连地址重新登录。');
    }
    return flow;
  };
  const requireOrigin = (request: FastifyRequest, origin: string | null) => {
    secureRoute(request);
    if (`https://${request.headers.host}` !== origin) throw new PasskeyError('请从指定的登录地址执行此操作。', 403);
  };
  const approveReturn = (request: FastifyRequest, id: string) => {
    const flow = returnFlow(id);
    if (flow.approved) throw new PasskeyError('本次登录已经验证，请返回直连地址。');
    flow.approved = true;
    flow.credentialId = access.credentialId(request);
    flow.expires = Date.now() + 60_000;
    return { returnUrl: `${configuredOrigin}/#passkeyReturn=${id}` };
  };

  server.post('/api/passkeys/return/start', { config: { rateLimit } }, async request => {
    requireOrigin(request, configuredOrigin);
    if (!browserOrigin || browserOrigin === configuredOrigin) throw new PasskeyError('此地址无需转移登录。');
    for (const [id, flow] of returns) if (flow.expires <= Date.now() || id === request.session.get('passkeyReturnId')) returns.delete(id);
    if (returns.size >= 1000) throw new PasskeyError('登录请求过多，请稍后重试。', 429);
    const id = randomUUID();
    const proof = randomBytes(32).toString('base64url');
    returns.set(id, { proof, revision: access.revision(), expires: Date.now() + challengeLifetime, approved: false });
    request.session.set('passkeyReturnId', id);
    request.session.set('passkeyReturnProof', proof);
    return { authorizeUrl: `${browserOrigin}/#passkeyReturn=${id}` };
  });
  server.post('/api/passkeys/return/approve', { config: { rateLimit } }, async request => {
    requireOrigin(request, browserOrigin);
    manage(request);
    const { id } = returnIdSchema.parse(request.body);
    return approveReturn(request, id);
  });
  server.post('/api/passkeys/return/prepare', { config: { rateLimit } }, async request => {
    requireOrigin(request, browserOrigin);
    const { id } = returnIdSchema.parse(request.body);
    returnFlow(id);
    if (!access.authenticated(request) || Date.now() - (request.session.get('loginAt') || 0) > challengeLifetime) {
      return { verificationRequired: true };
    }
    return { verificationRequired: false, ...approveReturn(request, id) };
  });
  server.post('/api/passkeys/return/finish', { config: { rateLimit } }, async request => {
    requireOrigin(request, configuredOrigin);
    const { id } = returnIdSchema.parse(request.body);
    const flow = returnFlow(id);
    if (request.session.get('passkeyReturnId') !== id || request.session.get('passkeyReturnProof') !== flow.proof) {
      throw new PasskeyError('请使用发起本次登录的浏览器完成登录。', 403);
    }
    if (!flow.approved) throw new PasskeyError('请先完成身份验证。');
    if (flow.credentialId && !database.prepare('SELECT id FROM passkeys WHERE id = ?').get(flow.credentialId)) {
      returns.delete(id);
      throw new PasskeyError('通行密钥已删除，请重新登录。', 401);
    }
    returns.delete(id);
    access.login(request, flow.credentialId, flow.revision);
    return { ok: true };
  });

  server.get('/api/passkeys/status', async (request) => ({
    enabled: allowedOrigins.has(`https://${request.headers.host}`),
    nativeOnly: new URL(`https://${request.headers.host}`).hostname !== rpID,
    browserOrigin,
    loginOrigin: configuredOrigin,
  }));
  server.get('/.well-known/assetlinks.json', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return [{ relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'], target: {
      namespace: 'android_app', package_name: 'dev.stdlibstring.codexremote.community', sha256_cert_fingerprints: [certificate],
    } }];
  });
  server.get('/api/passkeys', async (request) => {
    manage(request, false);
    return { recentAuthentication: Date.now() - (request.session.get('loginAt') || 0) <= challengeLifetime,
      credentials: credentials().map(key => ({ id: key.id, name: key.name, createdAt: key.created_at, lastUsedAt: key.last_used_at })) };
  });
  server.post('/api/passkeys/register/options', { config: { rateLimit } }, async (request) => {
    secureRoute(request);
    manage(request);
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(request.body);
    const existing = credentials();
    if (existing.length >= 20) throw new PasskeyError('最多保存 20 个通行密钥，请先删除不再使用的密钥。');
    const options = await generateRegistrationOptions({
      rpName: 'Codex', rpID, userID, userName: 'Codex', userDisplayName: 'Codex 主机',
      attestationType: 'none', timeout: challengeLifetime,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      preferredAuthenticatorType: request.headers.origin === browserOrigin ? 'localDevice' : undefined,
      supportedAlgorithmIDs: [-7, -257],
      excludeCredentials: existing.map(key => ({ id: key.id, transports: JSON.parse(key.transports) as AuthenticatorTransport[] })),
    });
    saveChallenge(request, 'registration', options.challenge, name);
    return options;
  });
  server.post('/api/passkeys/register/verify', { bodyLimit: 65536, config: { rateLimit } }, async (request) => {
    secureRoute(request);
    manage(request);
    const challenge = consumeChallenge(request, 'registration');
    const response = registrationSchema.parse(request.body) as RegistrationResponseJSON;
    const verification = await verifyRegistrationResponse({
      response, expectedChallenge: challenge.challenge, expectedOrigin: expectedOrigins,
      expectedRPID: rpID, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257],
    });
    if (!verification.verified || !verification.registrationInfo) throw new PasskeyError('通行密钥验证失败。');
    // 验证期间用户可能退出登录，写入之前再次检查会话。
    manage(request);
    const info = verification.registrationInfo;
    const stored = database.prepare(`INSERT OR IGNORE INTO passkeys
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL WHERE (SELECT COUNT(*) FROM passkeys) < 20`)
      .run(info.credential.id, challenge.name, Buffer.from(info.credential.publicKey), info.credential.counter,
        JSON.stringify(info.credential.transports || []), info.credentialDeviceType, Number(info.credentialBackedUp), Date.now());
    if (stored.changes !== 1) throw new PasskeyError('无法添加通行密钥，请刷新密钥列表。', 409);
    return { ok: true };
  });
  server.post('/api/passkeys/login/options', { config: { rateLimit } }, async (request) => {
    secureRoute(request);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', timeout: challengeLifetime });
    saveChallenge(request, 'authentication', options.challenge);
    return options;
  });
  server.post('/api/passkeys/login/verify', { bodyLimit: 65536, config: { rateLimit } }, async (request) => {
    secureRoute(request);
    const revision = access.revision();
    const challenge = consumeChallenge(request, 'authentication');
    const response = authenticationSchema.parse(request.body) as AuthenticationResponseJSON;
    const key = database.prepare('SELECT * FROM passkeys WHERE id = ?').get(response.id) as Credential | undefined;
    if (!key || response.response.userHandle !== userHandle) throw new PasskeyError('通行密钥无法用于此账号。', 401);
    const verification = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge.challenge, expectedOrigin: expectedOrigins, expectedRPID: rpID,
      requireUserVerification: true,
      credential: { id: key.id, publicKey: new Uint8Array(key.public_key), counter: key.counter,
        transports: JSON.parse(key.transports) as AuthenticatorTransport[] },
    });
    if (!verification.verified) throw new PasskeyError('通行密钥验证失败。', 401);
    if (revision !== access.revision()) throw new PasskeyError('账户已变更，请重新登录。', 401);
    const updated = database.prepare('UPDATE passkeys SET counter = ?, backed_up = ?, last_used_at = ? WHERE id = ? AND counter = ?')
      .run(verification.authenticationInfo.newCounter, Number(verification.authenticationInfo.credentialBackedUp), Date.now(), key.id, key.counter);
    if (updated.changes !== 1) throw new PasskeyError('通行密钥已变更，请重新登录。', 401);
    access.login(request, key.id, revision);
    return { ok: true };
  });
  server.delete('/api/passkeys/:id', { config: { rateLimit } }, async (request) => {
    secureRoute(request);
    manage(request);
    const { id } = z.object({ id: credentialId }).parse(request.params);
    const result = database.prepare('DELETE FROM passkeys WHERE id = ?').run(id);
    if (result.changes !== 1) throw new PasskeyError('通行密钥不存在。', 404);
    access.revokeCredential(id);
    return { ok: true };
  });
  server.addHook('onClose', async () => { database.close(); });
}
