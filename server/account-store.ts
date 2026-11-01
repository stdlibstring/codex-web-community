import Database from 'better-sqlite3';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { z } from 'zod';

const derive = promisify(scrypt);
export const emailSchema = z.email().max(254).transform(value => value.toLowerCase());
export const newPasswordSchema = z.string().max(512).refine(value => [...value].length >= 15, '密码至少需要十五个字符。');
const legacySchema = z.object({ salt: z.string().regex(/^[a-f0-9]{64}$/), hash: z.string().regex(/^[a-f0-9]{128}$/) });
export type Account = { salt: string; hash: string; revision: number; email: string | null };
export type MailKind = 'reset' | 'approve_email' | 'verify_email' | 'notice';
export type MailJob = { id: string; kind: MailKind; email: string; flow_id: string | null; revision: number; text: string | null };
type RecoveryToken = { hash: string; kind: MailKind; email: string; flow_id: string | null; revision: number; expires_at: number };
type EmailFlow = { id: string; email: string; previous_email: string | null; approved: number; revision: number; expires_at: number };

export class AccountError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

export async function passwordHash(password: string) {
  const salt = randomBytes(32).toString('hex');
  return { salt, hash: (await derive(password, salt, 64) as Buffer).toString('hex') };
}

export class AccountStore {
  readonly database: Database.Database;
  private readonly encryptionKey: Buffer;

  constructor(readonly state: string) {
    const path = resolve(state, 'account.sqlite');
    this.database = new Database(path);
    chmodSync(path, 0o600);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('busy_timeout = 5000');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS account (
        id INTEGER PRIMARY KEY CHECK (id = 1), salt TEXT NOT NULL, hash TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, email TEXT
      );
      CREATE TABLE IF NOT EXISTS email_flows (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, previous_email TEXT, approved INTEGER NOT NULL,
        revision INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recovery_tokens (
        hash TEXT PRIMARY KEY, kind TEXT NOT NULL, email TEXT NOT NULL, flow_id TEXT,
        revision INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mail_jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, email TEXT NOT NULL, flow_id TEXT,
        revision INTEGER NOT NULL, text TEXT, status TEXT NOT NULL DEFAULT 'queued',
        created_at INTEGER NOT NULL, finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS account_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_limits (name TEXT PRIMARY KEY, requested_at INTEGER NOT NULL);
    `);
    if (!this.database.prepare('SELECT id FROM account').get()) {
      const legacy = legacySchema.parse(JSON.parse(readFileSync(resolve(state, 'auth.json'), 'utf8')));
      this.database.prepare('INSERT INTO account (id, salt, hash) VALUES (1, ?, ?)').run(legacy.salt, legacy.hash);
    }
    const keyPath = resolve(state, 'account.key');
    if (!existsSync(keyPath)) {
      if (this.database.prepare('SELECT name FROM account_settings').get()) throw new Error('账户加密密钥缺失。');
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    this.encryptionKey = readFileSync(keyPath);
    chmodSync(keyPath, 0o600);
    if (this.encryptionKey.length !== 32) throw new Error('账户加密密钥长度错误。');
    // 数据库提交完成后清除初始化文件，密码仅保存哈希。
    rmSync(resolve(state, 'auth.json'), { force: true });
    rmSync(resolve(state, 'access.txt'), { force: true });
  }

  account() { return this.database.prepare('SELECT salt, hash, revision, email FROM account WHERE id = 1').get() as Account; }

  async verify(password: string) {
    const account = this.account();
    const candidate = await derive(password, account.salt, 64) as Buffer;
    if (!timingSafeEqual(candidate, Buffer.from(account.hash, 'hex'))) return null;
    return this.account().revision === account.revision ? account.revision : null;
  }

  replacePassword(hash: { salt: string; hash: string }, revision: number) {
    this.database.transaction(() => {
      const result = this.database.prepare('UPDATE account SET salt = ?, hash = ?, revision = revision + 1 WHERE id = 1 AND revision = ?')
        .run(hash.salt, hash.hash, revision);
      if (result.changes !== 1) throw new AccountError('账户已变更，请重新验证身份。', 409);
      this.clearRecovery();
      const email = this.account().email;
      if (email) this.enqueue('notice', email, null, '你的 Codex 访问密码已修改。全部设备的现有登录已经退出。若非本人操作，请立即检查账户与服务器。');
    })();
  }

  private clearRecovery() {
    this.database.exec("DELETE FROM recovery_tokens; DELETE FROM email_flows; UPDATE mail_jobs SET status = 'cancelled' WHERE status IN ('queued', 'sending');");
  }

  enqueue(kind: MailKind, email: string, flow: string | null = null, text: string | null = null) {
    const id = randomUUID();
    this.database.prepare('INSERT INTO mail_jobs (id, kind, email, flow_id, revision, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, kind, email, flow, this.account().revision, text, Date.now());
    return id;
  }

  beginEmail(email: string, revision: number, local = false) {
    return this.database.transaction(() => {
      const account = this.account();
      if (revision !== account.revision) throw new AccountError('账户已变更，请重新验证身份。', 409);
      if (email === account.email) throw new AccountError('这个邮箱已经完成绑定。');
      const pending = this.database.prepare('SELECT id FROM email_flows WHERE expires_at > ?').get(Date.now());
      if (pending) throw new AccountError('已有待确认的邮箱变更，请完成或取消后继续。', 409);
      this.database.exec('DELETE FROM email_flows');
      const id = randomUUID();
      const approved = Number(local || !account.email);
      this.database.prepare('INSERT INTO email_flows VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, email, account.email, approved, revision, Date.now() + 30 * 60_000);
      this.enqueue(approved ? 'verify_email' : 'approve_email', approved ? email : account.email!, id);
      return id;
    })();
  }

  pendingEmail() {
    const flow = this.database.prepare('SELECT * FROM email_flows WHERE expires_at > ?').get(Date.now()) as EmailFlow | undefined;
    return flow ? { email: flow.email, awaiting: flow.approved ? 'new' : 'old' } : null;
  }

  cancelEmail() {
    this.database.transaction(() => {
      this.database.exec("DELETE FROM recovery_tokens WHERE flow_id IS NOT NULL; DELETE FROM email_flows; UPDATE mail_jobs SET status = 'cancelled' WHERE flow_id IS NOT NULL AND status IN ('queued', 'sending')");
    })();
  }

  allowRecovery(name: string, interval: number) {
    const result = this.database.prepare(`INSERT INTO recovery_limits VALUES (?, ?) ON CONFLICT(name)
      DO UPDATE SET requested_at = excluded.requested_at WHERE requested_at <= ?`).run(name, Date.now(), Date.now() - interval);
    return result.changes === 1;
  }

  requestReset(email: string) {
    this.database.transaction(() => {
      if (email !== this.account().email || !this.allowRecovery('reset-mail', 60_000)) return;
      const pending = this.database.prepare("SELECT id FROM mail_jobs WHERE kind = 'reset' AND revision = ? AND status IN ('queued', 'sending')").get(this.account().revision);
      if (!pending) this.enqueue('reset', email);
    })();
  }

  claimMail() {
    return this.database.transaction(() => {
      const job = this.database.prepare("SELECT * FROM mail_jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1").get() as MailJob | undefined;
      if (!job) return null;
      this.database.prepare("UPDATE mail_jobs SET status = 'sending' WHERE id = ?").run(job.id);
      return job;
    })();
  }

  makeToken(job: MailJob) {
    return this.database.transaction(() => {
      const account = this.account();
      if (job.revision !== account.revision) return null;
      if (job.kind === 'reset' && job.email !== account.email) return null;
      if (job.flow_id) {
        const flow = this.database.prepare('SELECT * FROM email_flows WHERE id = ?').get(job.flow_id) as EmailFlow | undefined;
        if (!flow || flow.expires_at <= Date.now() || flow.revision !== account.revision
          || (job.kind === 'verify_email' && !flow.approved)) return null;
      }
      const token = randomBytes(32).toString('base64url');
      this.database.prepare('DELETE FROM recovery_tokens WHERE expires_at <= ?').run(Date.now());
      this.database.prepare('INSERT INTO recovery_tokens VALUES (?, ?, ?, ?, ?, ?)')
        .run(this.digest(token), job.kind, job.email, job.flow_id, job.revision, Date.now() + 15 * 60_000);
      return token;
    })();
  }

  token(token: string) {
    const record = this.database.prepare('SELECT * FROM recovery_tokens WHERE hash = ?').get(this.digest(token)) as RecoveryToken | undefined;
    const account = this.account();
    if (!record || record.expires_at <= Date.now() || record.revision !== account.revision) throw new AccountError('链接已失效，请重新申请。');
    if (record.kind === 'reset' && record.email !== account.email) throw new AccountError('链接已失效，请重新申请。');
    if (record.flow_id) {
      const flow = this.database.prepare('SELECT * FROM email_flows WHERE id = ?').get(record.flow_id) as EmailFlow | undefined;
      if (!flow || flow.expires_at <= Date.now() || flow.previous_email !== account.email) throw new AccountError('邮箱变更已失效，请重新申请。');
    }
    return record;
  }

  finishReset(token: string, hash: { salt: string; hash: string }) {
    this.database.transaction(() => {
      const record = this.token(token);
      if (record.kind !== 'reset') throw new AccountError('此链接无法用于重置密码。');
      this.replacePassword(hash, record.revision);
    })();
  }

  confirmEmail(token: string) {
    return this.database.transaction(() => {
      const record = this.token(token);
      if (!record.flow_id || !['approve_email', 'verify_email'].includes(record.kind)) throw new AccountError('此链接无法用于验证邮箱。');
      const flow = this.database.prepare('SELECT * FROM email_flows WHERE id = ?').get(record.flow_id) as EmailFlow;
      this.database.prepare('DELETE FROM recovery_tokens WHERE hash = ?').run(record.hash);
      if (record.kind === 'approve_email') {
        if (flow.approved) throw new AccountError('这个请求已经确认。');
        this.database.prepare('UPDATE email_flows SET approved = 1 WHERE id = ?').run(flow.id);
        this.enqueue('verify_email', flow.email, flow.id);
        return { awaitingNewEmail: true };
      }
      if (!flow.approved) throw new AccountError('请先通过旧邮箱确认变更。');
      this.database.prepare('UPDATE account SET email = ? WHERE id = 1').run(flow.email);
      this.clearRecovery();
      this.enqueue('notice', flow.email, null, '这个邮箱已绑定为 Codex 恢复邮箱，可以用于重置访问密码。');
      if (flow.previous_email) this.enqueue('notice', flow.previous_email, null, '你的 Codex 恢复邮箱已经变更。若非本人操作，请立即检查服务器。');
      return { awaitingNewEmail: false };
    })();
  }

  finishMail(id: string, status: 'sent' | 'failed' | 'cancelled') {
    this.database.prepare("UPDATE mail_jobs SET status = ?, finished_at = ? WHERE id = ? AND status = 'sending'").run(status, Date.now(), id);
  }

  mailStatus() {
    return this.database.prepare('SELECT status, created_at AS createdAt FROM mail_jobs ORDER BY created_at DESC, rowid DESC LIMIT 1').get() || null;
  }

  saveMailConfig(config: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const content = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
    const envelope = JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), content: content.toString('base64') });
    this.database.prepare("INSERT INTO account_settings VALUES ('smtp', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(envelope);
  }

  mailConfig(): unknown | null {
    const setting = this.database.prepare("SELECT value FROM account_settings WHERE name = 'smtp'").get() as { value: string } | undefined;
    if (!setting) return null;
    const envelope = z.object({ iv: z.string(), tag: z.string(), content: z.string() }).parse(JSON.parse(setting.value));
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.content, 'base64')), decipher.final()]).toString('utf8'));
  }

  tokenDigest(token: string) { return this.digest(token); }
  private digest(token: string) { return createHash('sha256').update(token).digest('hex'); }
  close() { this.database.close(); }
}
