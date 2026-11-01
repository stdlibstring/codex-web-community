import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { api, ApiError } from './api';
import { usePasskey } from './passkeys';
import { getAppearance, toggleAppearance, subscribeAppearance } from '../shared/appearance.js';

type MailConfig = { host: string; port: number; user: string; from: string; origin: string };
type SecurityInfo = {
  email: string | null; suggestedEmail: string; suggestedOrigin: string;
  pendingEmail: { email: string; awaiting: 'old' | 'new' } | null;
  mail: { configured: boolean; connection: string; config: MailConfig | null; lastDelivery: { status: string; createdAt: number } | null };
};
type Action = 'password' | 'email' | 'mail';
const PasswordFields = ({ password, confirmation, setPassword, setConfirmation }: {
  password: string; confirmation: string; setPassword: (value: string) => void; setConfirmation: (value: string) => void;
}) => <>
  <label htmlFor="new-password">新密码</label>
  <input id="new-password" name="new-password" type="password" autoComplete="new-password" minLength={15} maxLength={512} required value={password} onChange={event => setPassword(event.target.value)} />
  <small className="field-note">至少十五个字符，可以使用中文、空格和符号。</small>
  <label htmlFor="confirm-password">确认新密码</label>
  <input id="confirm-password" name="confirm-password" type="password" autoComplete="new-password" maxLength={512} required value={confirmation} onChange={event => setConfirmation(event.target.value)} />
</>;

export function AccountSecurity({ supportsPasskeys, onReauthenticated }: { supportsPasskeys: boolean; onReauthenticated: () => Promise<void> }) {
  const [info, setInfo] = useState<SecurityInfo | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [email, setEmail] = useState('');
  const [config, setConfig] = useState<MailConfig>({ host: 'smtp.qq.com', port: 465, user: '', from: '', origin: '' });
  const [authorization, setAuthorization] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const refresh = async () => setInfo(await api<SecurityInfo>('/account/security'));
  useEffect(() => {
    let active = true;
    const load = () => void api<SecurityInfo>('/account/security').then(result => { if (active) setInfo(result); }, (failure: Error) => { if (active) setError(failure.message); });
    load();
    const timer = setInterval(load, 3000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!action) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current!.showModal();
    return () => previous?.focus();
  }, [action]);
  const perform = (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    void operation().then(undefined, (failure: Error) => {
      setError(failure.name === 'NotAllowedError' ? '设备验证未完成，请重新操作。' : failure.message);
      if (failure instanceof ApiError && failure.status === 403) setVerified(false);
    }).finally(() => setBusy(false));
  };
  const open = (next: Action) => {
    setCurrentPassword(''); setPassword(''); setConfirmation(''); setAuthorization('');
    setEmail(info?.email || info?.suggestedEmail || '');
    setConfig(info?.mail.config || { host: 'smtp.qq.com', port: 465, user: info?.email || info?.suggestedEmail || '', from: info?.email || info?.suggestedEmail || '', origin: info?.suggestedOrigin || location.origin });
    setVerified(false); setError(''); setNotice(''); setAction(next);
  };
  const close = () => { if (!busy) { setAction(null); setCurrentPassword(''); setPassword(''); setConfirmation(''); setAuthorization(''); setError(''); } };
  const reauthenticate = (event?: FormEvent) => {
    event?.preventDefault();
    perform(async () => {
      if (event) await api('/login', { password: currentPassword });
      else {
        const options = await api<PublicKeyCredentialRequestOptionsJSON>('/passkeys/login/options', {});
        await api('/passkeys/login/verify', await usePasskey(options));
      }
      setCurrentPassword('');
      await onReauthenticated();
      setVerified(true);
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    perform(async () => {
      if (action === 'password') {
        if (password !== confirmation) throw new Error('两次输入的密码不同。');
        await api('/account/password', { password, confirmation });
        location.replace('/?passwordChanged=1');
      } else if (action === 'email') {
        await api('/account/email', { email });
        setAction(null); await refresh(); setNotice('验证邮件已提交，请按页面提示确认邮箱。');
      } else {
        await api('/account/mail', { ...config, pass: authorization });
        setAuthorization(''); setAction(null); await refresh(); setNotice('邮件服务器连接与身份验证成功。请继续绑定恢复邮箱，确认实际收信。');
      }
    });
  };
  const delivery = info?.mail.lastDelivery?.status;
  return <>
    <section className="security-section" aria-labelledby="password-title">
      <div className="section-heading"><h2 id="password-title">访问密码</h2><button className="secondary compact" disabled={busy || !info} onClick={() => open('password')}>修改密码</button></div>
      <p>通过当前密码或通行密钥验证身份后设置新密码。修改后全部设备需要重新登录。</p>
    </section>
    <section className="security-section" aria-labelledby="recovery-email-title">
      <div className="section-heading"><h2 id="recovery-email-title">恢复邮箱</h2><button className="secondary compact" disabled={busy || !info?.mail.configured || Boolean(info?.pendingEmail)} onClick={() => open('email')}>{info?.email ? '更换邮箱' : '绑定邮箱'}</button></div>
      <p className="account-detail">{info ? info.email ? `已验证：${info.email}` : '尚未绑定恢复邮箱。验证邮箱后，可以通过邮件重置忘记的密码。' : '正在加载…'}</p>
      {info?.pendingEmail && <div className="pending-email"><p>{info.pendingEmail.awaiting === 'old' ? '请先打开旧邮箱中的邮件，确认更换操作。随后会向新邮箱发送验证链接。' : `请打开 ${info.pendingEmail.email} 中的邮件，确认绑定。`}</p>
        <div className="account-actions"><button className="text-button" disabled={busy} onClick={() => perform(async () => { await api('/account/email/resend', {}); await refresh(); setNotice('验证邮件已重新提交。'); })}>重新发送</button>
          <button className="text-button" disabled={busy} onClick={() => perform(async () => { await api('/account/email/pending', {}, 'DELETE'); await refresh(); })}>取消邮箱变更</button></div></div>}
    </section>
    <section className="security-section" aria-labelledby="mail-service-title">
      <div className="section-heading"><h2 id="mail-service-title">邮件服务</h2><button className="secondary compact" disabled={busy || !info} onClick={() => open('mail')}>{info?.mail.configured ? '修改邮件配置' : '配置邮件服务'}</button></div>
      <p>{info?.mail.configured ? `发件邮箱：${info.mail.config!.from}` : '配置发件邮箱后，网站可以发送邮箱验证、密码重置和安全通知邮件。QQ 邮箱需要提供十六位授权码。'}</p>
      {info?.mail.configured && <p className="mail-status" role="status">{info.mail.connection === 'ready' ? '邮件服务器连接正常。' : info.mail.connection === 'failed' ? '邮件发送失败，请检查授权码、网络和发件邮箱设置。' : '邮件配置已保存，可以检查服务器连接。'}
        <button className="text-button" disabled={busy} onClick={() => perform(async () => { await api('/account/mail/check', {}); await refresh(); setNotice('邮件服务器连接与身份验证成功。'); })}>检查连接</button></p>}
      {delivery && <p className="delivery-status" role="status">最近邮件：{{ queued: '等待发送', sending: '正在发送', sent: '邮件服务器已接受，请检查收件箱和垃圾邮件', failed: '发送失败，请检查配置后重新发送', cancelled: '发送任务已取消' }[delivery] || delivery}</p>}
    </section>
    {error && !action && <p role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    {action && <dialog ref={dialog} className="security-dialog account-dialog" onCancel={event => { event.preventDefault(); close(); }} aria-labelledby="account-dialog-title">
      <h2 id="account-dialog-title">{!verified ? '验证身份' : { password: '修改密码', email: info?.email ? '更换恢复邮箱' : '绑定恢复邮箱', mail: '配置邮件服务' }[action]}</h2>
      {!verified ? <><p>请重新验证身份后继续。</p><form onSubmit={reauthenticate}>
        <label htmlFor="account-current-password">当前密码</label><input id="account-current-password" name="current-password" type="password" autoComplete="current-password" required autoFocus value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} />
        <button className="primary" disabled={busy}>验证并继续</button>{supportsPasskeys && <button type="button" className="secondary" disabled={busy} onClick={() => reauthenticate()}>使用通行密钥验证</button>}
      </form></> : <form onSubmit={submit}>
        {action === 'password' ? <PasswordFields {...{ password, confirmation, setPassword, setConfirmation }} /> : action === 'email' ? <>
          <p>{info?.email ? '需要分别通过旧邮箱和新邮箱确认。' : '完成邮件验证后，这个地址才能用于找回密码。'}</p>
          <label htmlFor="recovery-email">恢复邮箱地址</label><input id="recovery-email" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} />
        </> : <>
          <p>QQ 邮箱请使用 smtp.qq.com、端口 465，并填写邮箱设置里面生成的授权码。</p>
          <label htmlFor="smtp-user">发件邮箱账号</label><input id="smtp-user" type="email" autoComplete="username" required value={config.user} onChange={event => { const user = event.target.value; setConfig(current => ({ ...current, user, from: current.from === current.user ? user : current.from })); }} />
          <label htmlFor="smtp-authorization">邮箱授权码</label><input id="smtp-authorization" type="password" autoComplete="new-password" required value={authorization} onChange={event => setAuthorization(event.target.value)} />
          <label htmlFor="smtp-host">SMTP 服务器</label><input id="smtp-host" required value={config.host} onChange={event => setConfig(current => ({ ...current, host: event.target.value }))} />
          <label htmlFor="smtp-port">SMTP 端口</label><select id="smtp-port" value={config.port} onChange={event => setConfig(current => ({ ...current, port: Number(event.target.value) }))}><option value={465}>465（TLS）</option><option value={587}>587（STARTTLS）</option></select>
          <label htmlFor="smtp-from">发件人地址</label><input id="smtp-from" type="email" required value={config.from} onChange={event => setConfig(current => ({ ...current, from: event.target.value }))} />
          <label htmlFor="recovery-origin">邮件中的网站地址</label><input id="recovery-origin" type="url" required value={config.origin} onChange={event => setConfig(current => ({ ...current, origin: event.target.value }))} />
        </>}
        <button className="primary" disabled={busy}>{busy ? '正在处理…' : action === 'password' ? '保存新密码' : action === 'email' ? '发送验证邮件' : '验证并保存配置'}</button>
      </form>}
      {error && <p role="alert">{error}</p>}<button className="text-button dialog-cancel" disabled={busy} onClick={close}>取消</button>
    </dialog>}
  </>;
}

export function AccountRecovery() {
  const [appearance, setAppearance] = useState(getAppearance);
  const [link, setLink] = useState(() => ({ token: new URLSearchParams(location.hash.slice(1)).get('token') || '', sequence: 0 }));
  const token = link.token;
  const [kind, setKind] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [complete, setComplete] = useState(false);
  const forgot = location.pathname === '/forgot-password';
  const reset = location.pathname === '/recover';
  useEffect(() => subscribeAppearance(setAppearance), []);
  useEffect(() => {
    const receive = () => {
      if (!location.hash) return;
      const next = new URLSearchParams(location.hash.slice(1)).get('token') || '';
      setKind(''); setComplete(false); setError(''); setNotice(''); setPassword(''); setConfirmation('');
      setLink(current => ({ token: next, sequence: current.sequence + 1 }));
    };
    addEventListener('hashchange', receive);
    return () => removeEventListener('hashchange', receive);
  }, []);
  useEffect(() => {
    if (forgot) return;
    history.replaceState(null, '', location.pathname);
    if (!token) { setError('请从邮件里面打开完整的验证链接。'); return; }
    void api<{ kind: string }>('/account/recovery/inspect', { token }).then(result => {
      if (reset !== (result.kind === 'reset')) { setError('请从对应的验证邮件打开链接。'); return; }
      setKind(result.kind);
    }, (failure: Error) => setError(failure.message));
  }, [forgot, reset, token, link.sequence]);
  const submit = (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    const operation = async () => {
      if (forgot) {
        const result = await api<{ message: string }>('/account/recovery/request', { email }); setNotice(result.message);
      } else if (reset) {
        if (password !== confirmation) throw new Error('两次输入的密码不同。');
        await api('/account/recovery/reset', { token, password, confirmation });
        setPassword(''); setConfirmation(''); setComplete(true); setNotice('新密码已保存，全部设备需要重新登录。');
      } else {
        const result = await api<{ awaitingNewEmail: boolean }>('/account/email/confirm', { token });
        setComplete(true); setNotice(result.awaitingNewEmail ? '旧邮箱已确认。请打开新邮箱中的验证邮件，完成更换。' : '恢复邮箱已验证，可以用于找回密码。');
      }
    };
    void operation().then(undefined, (failure: Error) => setError(failure.message)).finally(() => setBusy(false));
  };
  return <main className="login-page"><section className="login-panel">
    <header className="portal-header"><a className="back-link" href="/">← 返回登录</a><button className="theme-toggle" onClick={toggleAppearance} aria-label={appearance.theme === 'dark' ? '切换日间模式' : '开启黑夜模式'}>{appearance.theme === 'dark' ? '日间模式' : '黑夜模式'}</button></header>
    <h1>{complete ? reset ? '密码已重置' : '邮箱确认完成' : forgot ? '找回密码' : reset ? '重置密码' : '确认恢复邮箱'}</h1>
    {!complete && <form onSubmit={submit}>
      {forgot ? <><p>填写提前绑定并验证的恢复邮箱，接收密码重置链接。</p><label htmlFor="forgot-email">恢复邮箱地址</label><input id="forgot-email" type="email" autoComplete="email" required autoFocus value={email} onChange={event => setEmail(event.target.value)} /><button className="primary" disabled={busy}>发送重置邮件</button></>
        : kind && (reset ? <><PasswordFields {...{ password, confirmation, setPassword, setConfirmation }} /><button className="primary" disabled={busy}>重置密码</button></>
          : <><p>{kind === 'approve_email' ? '确认后，网站将向新邮箱发送验证链接。' : '确认后，这个邮箱将用于恢复你的 Codex 账户访问。'}</p><button className="primary" disabled={busy}>{kind === 'approve_email' ? '确认更换邮箱' : '确认绑定邮箱'}</button></>)}
    </form>}
    {error && <p role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    {complete && <a className="primary recovery-return" href={reset ? '/' : '/account/security'}>{reset ? '使用新密码登录' : '返回登录与安全'}</a>}
  </section></main>;
}
