import { useEffect, useRef, useState } from 'react';
import type { Project } from '../core/domain';
import { emptyRemote, validateRemote, type RemoteSettings } from '../core/remote';
import { RemoteFields } from './settings';
import { bridge } from './api';
import { X } from './icons';
import { isSSH } from './ssh-directory';

export function ProjectRemoteOverlay({ project, save, onClose, notify, onSynced, syncDisabled }: { project: Project; onSynced?(): Promise<void>; syncDisabled?: boolean; save(remote: RemoteSettings, expectedDir?: string): Promise<boolean>; onClose(): void; notify(text: string, kind?: 'ok' | 'err'): void }) {
  const localDir = isSSH(project.dir) ? '' : project.dir || '';
  const [remote, setRemote] = useState(project.remote || { ...emptyRemote });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(false);
  const lock = useRef(false);
  // REQ-062：Esc 关闭远程仓库设置（操作进行中不打断）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !lock.current) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  async function perform(operation: () => Promise<string>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage(''); setError(false);
    try { const text = await operation(); setMessage(text); notify(text); }
    catch (e: any) { setMessage(e.message); setError(true); notify(e.message, 'err'); }
    finally { lock.current = false; setBusy(false); }
  }

  async function associateLocalRemote() {
    if (!localDir || !bridge.detectProjectRemote) throw Error('请在桌面版关联本地项目目录后重试');
    const detected = await bridge.detectProjectRemote(localDir);
    if (!detected.ok) throw Error(detected.error);
    const settings = detected.remote.url === project.remote?.url
      ? { ...detected.remote, sshKeyPath: project.remote.sshKeyPath }
      : detected.remote;
    if (!await save(settings, localDir)) throw Error('自动关联未保存，输入已保留');
    setRemote(settings);
    return '已关联本地 Git 远程仓库';
  }

  return <div className="overlay project-remote-overlay" onClick={e => { e.stopPropagation(); if (!busy && e.target === e.currentTarget) onClose(); }}>
    <section className="dialog settings-dialog" role="dialog" aria-modal="true" aria-label="项目仓库设置">
      <header className="dialog-head"><div><h3>项目仓库设置</h3><p>{project.name} · GitHub / GitLab</p></div><button className="icon-btn" aria-label="关闭项目仓库设置" disabled={busy} onClick={onClose}><X /></button></header>
      <div className="settings-body">
        <RemoteFields value={remote} change={value => { setRemote(value); setMessage(''); }} disabled={busy} />
        <p className="settings-hint">测试连接只读取远程引用，不克隆、不拉取、不修改本地文件。SSH 使用本机私钥和 known_hosts；HTTPS 使用系统凭据。</p>
        <div className="settings-actions">
          <button className="btn primary" disabled={busy || !project.dir || !remote.url.trim() || !bridge.applyRemote} onClick={() => perform(async () => { if (!await save(validateRemote(remote))) throw Error('配置保存失败，输入已保留'); const r = await bridge.applyRemote!(project.id); if (!r.ok) throw Error(r.error); return '仓库配置已保存并应用到本地 Git'; })}>保存并应用</button>
          <button className="btn" disabled={busy || !localDir || !bridge.detectProjectRemote} onClick={() => perform(associateLocalRemote)}>从本地 Git 自动关联</button>
          <button className="btn" disabled={busy || !remote.url.trim() || !bridge.testRemote} onClick={() => perform(async () => { const r = await bridge.testRemote!(validateRemote(remote)); if (!r.ok) throw Error(r.error || '仓库连接失败，请调整地址或认证配置'); return '仓库连接成功（只读测试）'; })}>测试连接</button>
          {project.remote?.url?.trim() && <button className="btn" disabled={busy || syncDisabled || !project.dir || !bridge.gitPull} onClick={() => perform(async () => { const r = await bridge.gitPull!(project.dir!); if (!r.ok) throw Error(r.error); await onSynced?.(); return r.summary || '远程仓库同步完成'; })}>同步远程仓库</button>}
        </div>
        <p className="settings-hint">自动关联从本地 Git 读取地址和分支，并保存到 ReqFlow。「保存并应用」会写入本地仓库的 origin。</p>
        {message && <p className={'settings-message' + (error ? ' project-create-error' : '')} role={error ? 'alert' : 'status'}>{message}</p>}
      </div>
      <div className="settings-footer"><button className="btn" disabled={busy} onClick={onClose}>关闭</button></div>
    </section>
  </div>;
}
