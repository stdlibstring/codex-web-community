import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccountError, AccountStore, emailSchema, newPasswordSchema, passwordHash } from './account-store.js';
import { AccountMail, mailConfigSchema } from './account-mail.js';

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const passwords = z.object({ password: newPasswordSchema, confirmation: z.string() })
  .refine(value => value.password === value.confirmation, '两次输入的密码不同。');
type Access = { authenticated: (request: FastifyRequest) => boolean; revokeAll: () => void };

export function registerAccount(server: FastifyInstance, store: AccountStore, access: Access) {
  const mail = new AccountMail(store, server.log);
  const manage = (request: FastifyRequest, recent = true) => {
    if (!access.authenticated(request)) throw new AccountError('请先登录。', 401);
    if (request.headers.origin !== `https://${request.headers.host}`) throw new AccountError('请从当前网站提交操作。', 403);
    if (recent && Date.now() - (request.session.get('loginAt') || 0) > 5 * 60_000) {
      throw new AccountError('请重新验证身份后继续。', 403);
    }
    return store.account().revision;
  };
  const available = () => {
    if (!mail.status().configured) throw new AccountError('邮件服务尚未配置，请通过账户设置或服务器本机管理。', 503);
  };
  const rateLimit = { max: 5, timeWindow: '1 minute' };
  const mutation = { config: { rateLimit } };

  server.get('/api/account/security', async request => {
    if (!access.authenticated(request)) throw new AccountError('请先登录。', 401);
    return { email: store.account().email, pendingEmail: store.pendingEmail(),
      suggestedEmail: process.env.CODEX_RECOVERY_EMAIL || '', suggestedOrigin: process.env.CODEX_PUBLIC_ORIGIN || '',
      recentAuthentication: Date.now() - (request.session.get('loginAt') || 0) <= 5 * 60_000, mail: mail.status() };
  });
  server.post('/api/account/password', mutation, async (request) => {
    const revision = manage(request);
    const input = passwords.parse(request.body);
    const hash = await passwordHash(input.password);
    manage(request);
    store.replacePassword(hash, revision);
    access.revokeAll();
    request.session.delete();
    return { ok: true };
  });
  server.post('/api/account/mail', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async request => {
    const revision = manage(request);
    const config = mailConfigSchema.parse(request.body);
    await mail.check(config);
    manage(request);
    if (revision !== store.account().revision) throw new AccountError('账户已变更，请重新验证身份。', 409);
    store.saveMailConfig(config);
    return { ok: true };
  });
  server.post('/api/account/mail/check', mutation, async request => {
    manage(request, false);
    await mail.check();
    return { ok: true };
  });
  server.post('/api/account/email', mutation, async request => {
    const revision = manage(request);
    available();
    const { email } = z.object({ email: emailSchema }).parse(request.body);
    if (!store.allowRecovery('email-mail', 60_000)) throw new AccountError('请等待一分钟后再发送验证邮件。', 429);
    store.beginEmail(email, revision);
    return { ok: true };
  });
  server.post('/api/account/email/resend', mutation, async request => {
    manage(request);
    available();
    if (!store.allowRecovery('email-mail', 60_000)) throw new AccountError('请等待一分钟后再发送验证邮件。', 429);
    const pending = store.pendingEmail();
    if (!pending) throw new AccountError('没有待确认的邮箱变更。');
    const flow = store.database.prepare('SELECT id, previous_email FROM email_flows WHERE expires_at > ?').get(Date.now()) as { id: string; previous_email: string | null };
    store.enqueue(pending.awaiting === 'old' ? 'approve_email' : 'verify_email', pending.awaiting === 'old' ? flow.previous_email! : pending.email, flow.id);
    return { ok: true };
  });
  server.delete('/api/account/email/pending', mutation, async request => {
    manage(request);
    store.cancelEmail();
    return { ok: true };
  });
  server.post('/api/account/recovery/request', { config: { rateLimit: { max: 3, timeWindow: '15 minutes' } } }, async request => {
    available();
    const { email } = z.object({ email: emailSchema }).parse(request.body);
    // 公开接口仅提交发送任务，响应时间不取决于邮箱是否匹配或 SMTP 速度。
    store.requestReset(email);
    return { ok: true, message: '如果这个邮箱已经绑定，将收到密码重置邮件。请同时检查垃圾邮件。' };
  });
  server.post('/api/account/recovery/inspect', mutation, async request => {
    const { token } = z.object({ token: tokenSchema }).parse(request.body);
    const record = store.token(token);
    return { kind: record.kind };
  });
  server.post('/api/account/recovery/reset', mutation, async request => {
    const input = passwords.safeExtend({ token: tokenSchema }).parse(request.body);
    if (store.token(input.token).kind !== 'reset') throw new AccountError('此链接无法用于重置密码。');
    const hash = await passwordHash(input.password);
    store.finishReset(input.token, hash);
    access.revokeAll();
    request.session.delete();
    return { ok: true };
  });
  server.post('/api/account/email/confirm', mutation, async request => {
    const { token } = z.object({ token: tokenSchema }).parse(request.body);
    return store.confirmEmail(token);
  });
  mail.start();
  server.addHook('onClose', async () => { mail.stop(); store.close(); });
  return mail;
}
