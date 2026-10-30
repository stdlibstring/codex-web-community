import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import './portal.css';

function Portal() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const manage = new URLSearchParams(location.search).has('manage');
  useEffect(() => {
    void api<{ authenticated: boolean }>('/session').then((result) => {
      if (result.authenticated && !manage) location.replace('/workbench/');
      else setAuthenticated(result.authenticated);
    }, (failure: Error) => setError(failure.message));
  }, [manage]);
  const login = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/login', { password });
      location.replace('/workbench/');
    } catch (failure) {
      setError((failure as Error).message); setBusy(false);
    }
  };
  const logout = async () => {
    setBusy(true); setError('');
    try { await api('/logout', {}); setAuthenticated(false); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  return <main><section className="login-panel">
    <span className="brand">Codex</span>
    <h1>继续主机上的工作</h1>
    <p>使用官方 Codex 插件，连接这台机器上的项目与会话。</p>
    {authenticated === true ? <div className="actions"><a className="primary" href="/workbench/">打开 Codex</a><button className="secondary" disabled={busy} onClick={() => void logout()}>退出登录</button></div> : authenticated === false ? <form id="login" method="post" action="/api/login" autoComplete="on" onSubmit={(event) => void login(event)}>
      <label htmlFor="password">访问密码</label>
      <input id="password" name="password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} required />
      <button type="submit" className="primary" disabled={busy}>{busy ? '正在连接…' : '连接 Codex'}</button>
    </form> : <p role="status">正在连接…</p>}
    {error && <p role="alert">{error}</p>}
    <p className="certificate-help">浏览器提示证书不受信任时，需要先安装<a href="/certificate.crt" download="codex-web.crt">网站证书</a>，才能使用浏览器的密码保存功能。</p>
  </section></main>;
}

createRoot(document.getElementById('root')!).render(<Portal />);
