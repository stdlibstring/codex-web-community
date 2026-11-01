import nodemailer from 'nodemailer';
import { z } from 'zod';
import { AccountError, AccountStore, emailSchema } from './account-store.js';
import type { FastifyBaseLogger } from 'fastify';

export const mailConfigSchema = z.object({
  host: z.string().min(1).max(253), port: z.union([z.literal(465), z.literal(587)]),
  user: emailSchema, pass: z.string().min(1).max(512), from: emailSchema,
  origin: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
  }, '网站地址必须是固定的 HTTPS origin。'),
});
export type MailConfig = z.infer<typeof mailConfigSchema>;
export const accountMailSubjects = { reset: 'Codex 密码重置', approve_email: '确认更换 Codex 恢复邮箱', verify_email: '验证 Codex 恢复邮箱', notice: 'Codex 账户安全通知' };

export class AccountMail {
  private active = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private connection: 'unchecked' | 'ready' | 'failed' = 'unchecked';

  constructor(private readonly store: AccountStore, private readonly logger?: FastifyBaseLogger) {}

  config(): MailConfig | null {
    const saved = this.store.mailConfig();
    if (saved) return mailConfigSchema.parse(saved);
    const env = process.env;
    if (![env.SMTP_HOST, env.SMTP_PORT, env.SMTP_USER, env.SMTP_PASS, env.SMTP_FROM].some(Boolean)) return null;
    return mailConfigSchema.parse({ host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 465), user: env.SMTP_USER,
      pass: env.SMTP_PASS, from: env.SMTP_FROM, origin: env.CODEX_PUBLIC_ORIGIN });
  }

  private transport(config: MailConfig) {
    return nodemailer.createTransport({ host: config.host, port: config.port, secure: config.port === 465,
      requireTLS: true, auth: { user: config.user, pass: config.pass }, tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000,
      disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
  }

  status() {
    const config = this.config();
    return { configured: Boolean(config), connection: this.connection,
      config: config ? { host: config.host, port: config.port, user: config.user, from: config.from, origin: config.origin } : null,
      lastDelivery: this.store.mailStatus() };
  }

  async check(config = this.config()) {
    if (!config) throw new AccountError('请先配置邮件服务。', 503);
    await new Promise<void>((accept, reject) => this.transport(config).verify(error => {
      if (error) {
        this.connection = 'failed';
        reject(new AccountError('邮件服务器验证失败，请检查 SMTP 地址、端口、邮箱授权码和网络连接。', 502));
        return;
      }
      this.connection = 'ready'; accept();
    }));
  }

  start() {
    // 上一次进程终止时尚未确认的发送操作需要用户重新请求。
    this.store.database.prepare("UPDATE mail_jobs SET status = 'failed', finished_at = ? WHERE status = 'sending'").run(Date.now());
    this.config();
    this.timer = setInterval(() => this.dispatch(), 500);
    this.timer.unref();
  }

  dispatch() {
    if (this.active || this.stopped) return;
    const config = this.config();
    if (!config) return;
    const job = this.store.claimMail();
    if (!job) return;
    const token = job.kind === 'notice' ? null : this.store.makeToken(job);
    if (job.kind !== 'notice' && !token) { this.store.finishMail(job.id, 'cancelled'); return; }
    const subject = accountMailSubjects[job.kind];
    const path = job.kind === 'reset' ? '/recover' : '/verify-email';
    const text = job.kind === 'notice' ? job.text! : `${subject}\n\n请打开以下地址，确认操作后继续：\n${config.origin}${path}#token=${token}\n\n此链接十五分钟内有效，仅能使用一次。若非本人请求，请忽略此邮件。`;
    this.active = true;
    this.transport(config).sendMail({ from: config.from, to: job.email, subject, text,
      messageId: `<${job.id}@${new URL(config.origin).hostname}>`, headers: { 'X-Codex-Account-Job': job.id } }, (error, result) => {
      this.active = false;
      if (this.stopped) return;
      if (error || result.rejected.length) {
        this.connection = 'failed';
        this.store.finishMail(job.id, 'failed');
        if (token) this.store.database.prepare('DELETE FROM recovery_tokens WHERE hash = ?').run(this.store.tokenDigest(token));
        this.logger?.error({ job: job.id, code: error?.code || 'RECIPIENT_REJECTED' }, '账户邮件发送失败');
        return;
      }
      this.connection = 'ready';
      this.store.finishMail(job.id, 'sent');
    });
  }

  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); }
}
