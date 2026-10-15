import { useRef, useState } from 'react';
import { bridge } from './api';
import { FolderOpen, X } from './icons';

export const isSSH = (dir?: string) => !!dir?.startsWith('ssh://');
export function SSHDirectory({ initial, onSelect, onClose }: { initial?: string; onSelect(dir: string): void | Promise<void>; onClose(): void }) {
  let parsed: URL | null = null;
  try { if (initial && isSSH(initial)) parsed = new URL(initial); } catch { /* Invalid imported bindings can be replaced in this picker. */ }
  const [host, setHost] = useState(parsed?.hostname.replace(/^\[|\]$/g, '') || '');
  const [user, setUser] = useState(parsed ? decodeURIComponent(parsed.username) : '');
  const [port, setPort] = useState(parsed?.port || '22');
  const [dir, setDir] = useState(parsed ? decodeURIComponent(parsed.pathname) : '');
  const [listing, setListing] = useState<{ dir: string; path: string; entries: { name: string; path: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  function change(fn: () => void) { fn(); setListing(null); setError(''); }
  async function connect(target = dir) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      if (!bridge.listSSH) throw Error('远程目录连接仅桌面版可用');
      if (!host.trim() || !/^\d+$/.test(port) || +port < 1 || +port > 65535) throw Error('请填写服务器地址和有效端口');
      if (/[\s\/\\@?#\[\]]/.test(host.trim())) throw Error('服务器地址只能填写 IP、主机名或 SSH 别名');
      const h = host.trim().includes(':') ? '[' + host.trim() + ']' : host.trim();
      const root = new URL('ssh://' + (user.trim() ? encodeURIComponent(user.trim()) + '@' : '') + h + ':' + port);
      if (target && !target.startsWith('/')) throw Error('请输入远程绝对路径，或留空使用登录目录');
      root.pathname = target;
      const r = await bridge.listSSH(root.toString());
      if (!r.ok || !r.dir || !r.path) throw Error(r.error || '连接失败');
      setListing({ dir: r.dir, path: r.path, entries: r.entries || [] }); setDir(r.path);
    } catch (e: any) { setError(e.message); setListing(null); }
    finally { lock.current = false; setBusy(false); }
  }
  return <div className="overlay" role="dialog" aria-modal="true" aria-label="连接远程服务器" onClick={e => { e.stopPropagation(); if (e.target === e.currentTarget && !busy) onClose(); }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); if (!busy) onClose(); } else if (e.key === 'Enter' && e.target instanceof HTMLInputElement) { e.preventDefault(); e.stopPropagation(); if (!busy) void connect(); } }}>
    <div className="dialog ssh-directory">
      <div className="dialog-head"><div><h3>连接远程服务器</h3><p>使用本机 OpenSSH 默认密钥或 SSH Agent 免密连接。</p></div><button type="button" className="icon-btn" aria-label="关闭远程目录" disabled={busy} onClick={onClose}><X /></button></div>
      <div className="ssh-connection-fields">
        <label className="field">服务器地址<input autoFocus value={host} disabled={busy} placeholder="IP、主机名或 SSH 配置别名" onChange={e => change(() => setHost(e.target.value))} /></label>
        <div className="ssh-connection-row"><label className="field">用户名 · 可选<input value={user} disabled={busy} placeholder="默认使用 SSH 配置" onChange={e => change(() => setUser(e.target.value))} /></label><label className="field">端口<input value={port} disabled={busy} inputMode="numeric" onChange={e => change(() => setPort(e.target.value))} /></label></div>
        <label className="field">远程目录 · 可选<input value={dir} disabled={busy} placeholder="留空使用登录目录，如 /home/dev" onChange={e => change(() => setDir(e.target.value))} /></label>
        <div className="settings-actions"><button type="button" className="btn primary" disabled={busy || !host.trim() || !bridge.listSSH} onClick={() => void connect()}>{busy ? '连接中…' : listing ? '重新连接' : '连接并浏览目录'}</button></div>
        <p className="settings-hint">仅支持免密 SSH 与 SFTP。首次连接请先在终端核对主机指纹并加入 known_hosts；不保存密码或私钥。目录中的文件支持只读预览。</p>
      </div>
      {error && <p className="settings-message project-create-error" role="alert">{error}</p>}
      {listing && <div className="ssh-directory-list"><div className="ssh-current"><strong title={listing.path}>{listing.path}</strong><button type="button" className="btn" disabled={busy || listing.path === '/'} onClick={() => void connect(listing.path.replace(/\/[^/]+\/?$/, '') || '/')}>上级目录</button></div>{listing.entries.map(entry => <button type="button" className="side-project" key={entry.path} disabled={busy} onClick={() => void connect(entry.path)}><FolderOpen size={16} /><span title={entry.name}>{entry.name}</span></button>)}{!listing.entries.length && <p className="muted">此目录没有子文件夹，可直接绑定。</p>}</div>}
      <div className="dialog-foot"><button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={busy || !listing} onClick={async () => { if (!listing || lock.current) return; lock.current = true; setBusy(true); try { await onSelect(listing.dir); } catch (e: any) { setError(e.message); } finally { lock.current = false; setBusy(false); } }}>绑定当前目录</button></div>
    </div>
  </div>;
}
