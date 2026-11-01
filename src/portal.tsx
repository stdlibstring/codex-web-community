import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { createPasskey, usePasskey, supportsPasskeys as passkeysSupported } from './passkeys';
import { api, ApiError } from './api';
import { getAppearance, toggleAppearance, subscribeAppearance } from '../shared/appearance.js';
import './portal.css';
import { AccountRecovery, AccountSecurity } from './account';

type PasskeyStatus = { enabled: boolean; nativeOnly: boolean; browserOrigin?: string | null; loginOrigin?: string };
type PasskeyReturnPreparation = { verificationRequired: true } | { verificationRequired: false; returnUrl: string };
type Passkey = { id: string; name: string; createdAt: number; lastUsedAt: number | null };
type PasskeyList = { recentAuthentication: boolean; credentials: Passkey[] };
type Action = { kind: 'add' } | { kind: 'delete'; key: Passkey };

function Portal() {
  const [appearance, setAppearance] = useState(getAppearance);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(new URLSearchParams(location.search).has('passwordChanged') ? '密码已修改，请重新登录。' : '');
  const [passkeyStatus, setPasskeyStatus] = useState<PasskeyStatus | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeyList | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const automaticPasskeyAttempt = useRef<string | null>(null);
  const settings = location.pathname === '/account' || location.pathname === '/account/security';
  const security = location.pathname === '/account/security';
  const legacyManage = new URLSearchParams(location.search).has('manage');
  const androidApp = navigator.userAgent.includes('CodexRemote/');
  const [keyName, setKeyName] = useState(androidApp ? 'Android 手机' : '我的设备');
  const supportsPasskeys = passkeysSupported(passkeyStatus?.nativeOnly ?? true);
  const returnId = new URLSearchParams(location.hash.slice(1)).get('passkeyReturn');

  const beginBrowserLogin = async () => {
    const result = await api<{ authorizeUrl: string }>('/passkeys/return/start', {});
    location.replace(result.authorizeUrl);
  };
  const completeLogin = async (status: PasskeyStatus) => {
    if (!androidApp && !settings && returnId && location.origin === status.browserOrigin) {
      const result = await api<{ returnUrl: string }>('/passkeys/return/approve', { id: returnId });
      location.replace(result.returnUrl);
    } else if (!androidApp && !settings && status.loginOrigin && location.origin !== status.loginOrigin) {
      location.replace(`${status.loginOrigin}/#passkeyStart`);
    } else location.replace(settings ? location.pathname : '/workbench/');
  };

  useEffect(() => subscribeAppearance(setAppearance), []);
  useEffect(() => {
    if (legacyManage) { location.replace('/account'); return; }
    void Promise.all([api<{ authenticated: boolean }>('/session'), api<PasskeyStatus>('/passkeys/status')]).then(async ([result, status]) => {
      setPasskeyStatus(status);
      if (!androidApp && !settings && location.origin === status.loginOrigin && returnId) {
        history.replaceState(null, '', location.pathname);
        await api('/passkeys/return/finish', { id: returnId });
        location.replace('/workbench/');
      } else if (!androidApp && !settings && location.origin === status.loginOrigin && location.hash === '#passkeyStart') {
        history.replaceState(null, '', location.pathname);
        await beginBrowserLogin();
      } else if (!androidApp && !settings && returnId && location.origin === status.browserOrigin) {
        const preparation = await api<PasskeyReturnPreparation>('/passkeys/return/prepare', { id: returnId });
        if (preparation.verificationRequired) {
          setAuthenticated(false);
          if (status.enabled && passkeysSupported(status.nativeOnly) && automaticPasskeyAttempt.current !== returnId) {
            automaticPasskeyAttempt.current = returnId;
            perform(() => verifyPasskey(status));
          }
        } else {
          location.replace(preparation.returnUrl);
        }
      } else if (result.authenticated && !settings) await completeLogin(status);
      else setAuthenticated(result.authenticated);
    }).catch((failure: Error) => { setAuthenticated(false); setError(failure.message); });
  }, [legacyManage, settings]);
  useEffect(() => {
    if (authenticated && settings && passkeyStatus?.enabled) {
      void api<PasskeyList>('/passkeys').then(setPasskeys, (failure: Error) => setError(failure.message));
    }
  }, [authenticated, settings, passkeyStatus?.enabled]);
  useEffect(() => {
    if (!action) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current!.showModal();
    return () => { previous?.focus(); };
  }, [action]);

  const perform = (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    void operation().then(undefined, (failure: Error) => {
      if (failure instanceof ApiError && failure.status === 401 && !action) {
        setAuthenticated(false); setPasskeys(null); setAction(null);
      }
      if (failure instanceof ApiError && [401, 403].includes(failure.status) && authenticated && settings) {
        setPasskeys(current => current ? { ...current, recentAuthentication: false } : current);
      }
      if (failure.name === 'NotAllowedError') setError('验证未完成。请确认设备已设置屏幕锁，并在系统中启用通行密钥服务。');
      else if (failure.name === 'InvalidStateError') setError('此设备已经保存了通行密钥，请使用已有密钥登录。');
      else if (failure.message.includes('RP ID cannot be validated')) setError('通行密钥的服务域名验证未完成。请确认网络连接后重试。');
      else if (failure.name === 'SecurityError') setError('无法验证当前服务的通行密钥，请确认使用受信任的 HTTPS 登录地址。');
      else setError(failure.message);
    }).finally(() => setBusy(false));
  };
  const verifyPasskey = async (status: PasskeyStatus) => {
    if (!androidApp && !settings && !returnId && status.loginOrigin && location.origin !== status.loginOrigin) {
      location.replace(`${status.loginOrigin}/#passkeyStart`);
      return;
    }
    const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>('/passkeys/login/options', {});
    await api('/passkeys/login/verify', await usePasskey(optionsJSON));
    if (authenticated) setPasskeys(await api<PasskeyList>('/passkeys'));
    else await completeLogin(status);
  };
  const authenticatePasskey = () => perform(() => verifyPasskey(passkeyStatus!));
  const registerPasskey = (event: FormEvent) => {
    event.preventDefault();
    perform(async () => {
      const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>('/passkeys/register/options', { name: keyName });
      await api('/passkeys/register/verify', await createPasskey(optionsJSON));
      setPasskeys(await api<PasskeyList>('/passkeys'));
      setAction(null);
      setNotice('通行密钥已添加。下次可以使用设备解锁登录。');
    });
  };
  const removePasskey = (key: Passkey) => perform(async () => {
    await api(`/passkeys/${encodeURIComponent(key.id)}`, {}, 'DELETE');
    const session = await api<{ authenticated: boolean }>('/session');
    setAuthenticated(session.authenticated);
    setPasskeys(session.authenticated ? await api<PasskeyList>('/passkeys') : null);
    setAction(null);
    setNotice('通行密钥已删除，相关登录会话已退出。');
  });
  const reauthenticate = (event: FormEvent) => {
    event.preventDefault();
    perform(async () => {
      await api('/login', { password });
      setPassword('');
      setPasskeys(await api<PasskeyList>('/passkeys'));
    });
  };
  const login = (event: FormEvent) => {
    event.preventDefault();
    perform(async () => {
      await api('/login', { password });
      await completeLogin(passkeyStatus!);
    });
  };
  const logout = () => perform(async () => {
    await api('/logout', {});
    location.replace('/');
  });
  const openAction = (next: Action) => {
    setError(''); setNotice(''); setPassword(''); setAction(next);
  };
  const closeAction = () => { if (!busy) { setAction(null); setError(''); setPassword(''); } };
  const settingsVisible = authenticated && settings;
  const hasPasskeyLogin = Boolean((passkeyStatus?.enabled && supportsPasskeys)
    || (!androidApp && passkeyStatus?.nativeOnly && passkeyStatus.browserOrigin));

  return <main className={settingsVisible ? 'settings-page' : 'login-page login-home'}>
    <section className={settingsVisible ? 'settings-panel' : 'login-panel'}>
      <header className="portal-header">
        {settingsVisible ? <a className="back-link" href={security ? '/account'
          : !androidApp && passkeyStatus?.loginOrigin && location.origin !== passkeyStatus.loginOrigin
            ? `${passkeyStatus.loginOrigin}/#passkeyStart` : '/workbench/'}>{security ? '← 账户设置' : '← 返回 Codex'}</a>
          : !androidApp && <span className="brand">Codex Remote</span>}
        {!androidApp && <button type="button" className="theme-toggle" onClick={toggleAppearance} aria-label={appearance.theme === 'dark' ? '切换日间模式' : '开启黑夜模式'}>{appearance.theme === 'dark' ? '日间模式' : '黑夜模式'}</button>}
      </header>
      {settingsVisible ? security ? <>
        <h1>登录与安全</h1>
        <p className="page-description">管理用于登录 Codex 的验证方式。</p>
        <AccountSecurity supportsPasskeys={Boolean(passkeyStatus?.enabled && supportsPasskeys)} onReauthenticated={async () => {
          if (passkeyStatus?.enabled) setPasskeys(await api<PasskeyList>('/passkeys'));
        }} />
        <section className="security-section" aria-labelledby="passkeys-title">
          <div className="section-heading"><h2 id="passkeys-title">通行密钥</h2>
            {passkeys && supportsPasskeys && <button className="secondary compact" disabled={busy} onClick={() => openAction({ kind: 'add' })}>添加通行密钥</button>}
          </div>
          <p>使用设备指纹、面容或解锁密码验证身份。</p>
          {!passkeyStatus?.enabled ? <p role="status">此服务尚未启用通行密钥。</p> : !passkeys ? <p role="status">正在加载…</p>
            : passkeys.credentials.length === 0 ? <div className="empty-state"><strong>尚未添加通行密钥</strong><p>添加后，可以通过设备解锁登录 Codex。</p></div>
            : <ul className="passkey-list">{passkeys.credentials.map(key => <li key={key.id}>
              <div><strong>{key.name}</strong><span>创建于 {new Date(key.createdAt).toLocaleDateString()}</span>
                <span>{key.lastUsedAt ? `最近使用 ${new Date(key.lastUsedAt).toLocaleString()}` : '尚未使用'}</span></div>
              <button className="text-button danger-text" disabled={busy} aria-label={`删除通行密钥：${key.name}`} onClick={() => openAction({ kind: 'delete', key })}>删除</button>
            </li>)}</ul>}
          {!supportsPasskeys && <p className="support-note">{passkeyStatus?.browserOrigin && passkeyStatus.nativeOnly && !androidApp
            ? <a href={`${passkeyStatus.browserOrigin}/account/security`}>通过安全地址管理通行密钥 →</a>
            : '请在支持通行密钥的设备上添加。已保存的密钥可以在这里管理。'}</p>}
        </section>
      </> : <>
        <h1>账户设置</h1>
        <p className="page-description">管理登录方式与账户访问。</p>
        <nav className="settings-list" aria-label="账户设置">
          <a className="settings-row" href="/account/security"><span><strong>登录与安全</strong><small>访问密码、恢复邮箱与通行密钥</small></span><span aria-hidden="true">›</span></a>
        </nav>
        <button className="text-button signout-button" disabled={busy} onClick={logout}>退出登录</button>
      </> : <>
        <h1>登录 Codex</h1>
        <p className="login-description">继续主机上的项目与会话。</p>
        {authenticated === false ? <>
          {passkeyStatus?.enabled && supportsPasskeys && <div className="passkey-login"><button className="primary" disabled={busy} onClick={authenticatePasskey}>使用通行密钥登录</button><div className="login-divider">或</div></div>}
          {!androidApp && passkeyStatus?.nativeOnly && passkeyStatus.browserOrigin && <div className="passkey-login"><button className="primary" disabled={busy} onClick={() => perform(beginBrowserLogin)}>使用通行密钥登录</button><div className="login-divider">或</div></div>}
          <form id="login" method="post" action="/api/login" autoComplete="on" onSubmit={login}>
            <div className="login-password-heading"><label htmlFor="password">访问密码</label><a className="forgot-password" href="/forgot-password">忘记密码</a></div>
            <input id="password" name="password" type="password" autoComplete="current-password" autoFocus={!passkeyStatus?.enabled || !supportsPasskeys} value={password} onChange={event => setPassword(event.target.value)} required />
            <button type="submit" className={hasPasskeyLogin ? 'secondary' : 'primary'} disabled={busy}>{busy ? '正在验证…' : '使用访问密码登录'}</button>
          </form>
        </> : <p role="status">正在连接…</p>}
      </>}
      {error && !action && <p role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {!settingsVisible && !androidApp && <footer className="login-footer"><a href="/downloads/codex-remote.apk" download="codex-remote.apk">下载 Android APP</a>{passkeyStatus?.nativeOnly && <a href="/certificate.crt" download="codex-web.crt">安装网站证书</a>}</footer>}
    </section>
    {action && <dialog ref={dialog} className="security-dialog" aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); closeAction(); }}>
      {!passkeys?.recentAuthentication ? <>
        <h2 id="dialog-title">验证身份</h2><p>为保护账户安全，请先验证身份后继续。</p>
        <form onSubmit={reauthenticate}>
          <label htmlFor="verify-password">访问密码</label>
          <input id="verify-password" type="password" autoComplete="current-password" autoFocus value={password} onChange={event => setPassword(event.target.value)} required />
          <button className="primary" disabled={busy}>验证并继续</button>
          {supportsPasskeys && <button type="button" className="secondary" disabled={busy} onClick={authenticatePasskey}>使用通行密钥验证</button>}
        </form>
      </> : action.kind === 'add' ? <>
        <h2 id="dialog-title">添加通行密钥</h2><p>为这个通行密钥设置名称，随后按照系统提示保存。</p>
        <form onSubmit={registerPasskey}>
          <label htmlFor="passkey-name">密钥名称</label>
          <input id="passkey-name" autoComplete="off" autoFocus value={keyName} maxLength={80} onChange={event => setKeyName(event.target.value)} required />
          <button className="primary" disabled={busy || !keyName.trim()}>{busy ? '正在验证…' : '继续'}</button>
        </form>
      </> : <>
        <h2 id="dialog-title">删除通行密钥？</h2><p>“{action.key.name}”将无法继续登录，使用它建立的登录会话也会退出。</p>
        <button className="danger" disabled={busy} onClick={() => removePasskey(action.key)}>{busy ? '正在删除…' : '删除通行密钥'}</button>
      </>}
      {error && <p role="alert">{error}</p>}
      <button className="text-button dialog-cancel" disabled={busy} onClick={closeAction}>取消</button>
    </dialog>}
  </main>;
}

createRoot(document.getElementById('root')!).render(['/forgot-password', '/recover', '/verify-email'].includes(location.pathname) ? <AccountRecovery /> : <Portal />);
