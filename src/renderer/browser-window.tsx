import { useCallback, useEffect, useState } from 'react';
import { bridge } from './api';
import { ProjectBrowser } from './browser';
import { RefreshCw } from './icons';
import { projectConcurrencyToken, type Workspace } from '../core/domain';
import type { RemoteSettings } from '../core/remote';

export function BrowserWindow({ id }: { id: string }) {
  const [state, setState] = useState<Workspace | null>(null);
  const [message, setMessage] = useState('');
  const load = useCallback(async () => { const r = await bridge.getWorkspace(); if (r.ok) setState(r.state); else setMessage(r.error); }, []);
  useEffect(() => {
    document.body.classList.add('browser-window');
    // REQ-250：先用本地备份渲染文件树，再在后台刷新远程数据，避免首屏等待 Server Agent。
    let fresh = false;
    void bridge.getLocalWorkspace?.().then(r => { if (r.ok && !fresh) setState(r.state); });
    void load().then(() => { fresh = true; });
    const focus = () => void load();
    window.addEventListener('focus', focus);
    return () => { document.body.classList.remove('browser-window'); window.removeEventListener('focus', focus); };
  }, [load]);
  const project = state?.projects.find(p => p.id === id);
  async function update(op: string, value: Record<string, unknown>) {
    if (!project) return false;
    const r = await bridge.apply({ op, project: id, ...value, expectedProjectVersions: { [id]: project.revision || 0 }, expectedProjectSignatures: { [id]: await projectConcurrencyToken(project) } });
    if (!r.ok) { setMessage(r.error); await load(); return false; }
    setState(r.state); return true;
  }
  return <>
    {message && <div role="alert" className="browser-window-message" onClick={() => setMessage('')}>{message}</div>}
    {project
      ? <ProjectBrowser project={project} onClose={() => void bridge.closeProjectBrowser?.(id)} onDirChange={async dir => { if (!await update('projectDir', { dir })) throw Error('目录未保存'); }} notify={(text) => setMessage(text)} onCommitted={load} saveRemote={(remote: RemoteSettings) => update('projectRemote', { remote })} />
      : <div className="browser-window-loading" role="status">
          <div className="browser-window-loading-bar" aria-hidden="true" />
          {state && !message ? <span>未找到该项目，可能已被删除</span> : <><RefreshCw size={22} className="terminal-loading-spinner" /><span>{message || '正在加载项目…'}</span></>}
        </div>}
  </>;
}
