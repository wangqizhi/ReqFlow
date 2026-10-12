import { useEffect, useRef, useState } from 'react';
import { bridge } from './api';
import type { UpdateState } from '../core/update';
import { Download, RefreshCw } from './icons';

export function UpdateButton() {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' });
  const locked = useRef(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!bridge.checkUpdate || !bridge.updateState) return;
    let alive = true;
    void bridge.checkUpdate().then(value => { if (alive) setState(value); }).catch(error => { if (alive) setState({ phase: 'error', error: error.message }); });
    const timer = setInterval(() => { void bridge.updateState!().then(value => { if (alive) setState(value); }).catch(() => {}); }, 700);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const working = pending || ['checking', 'downloading', 'installing'].includes(state.phase);
  const action = async () => {
    if (locked.current || working) return;
    const method = state.phase === 'ready' ? bridge.installUpdate : state.phase === 'available' || (state.phase === 'error' && state.retry === 'download') ? bridge.downloadUpdate : bridge.checkUpdate;
    if (!method) return;
    locked.current = true;
    setPending(true);
    try { setState(await method()); }
    catch (error: any) { setState({ phase: 'error', error: error.message || '更新失败，请重试' }); }
    finally { locked.current = false; setPending(false); }
  };
  const label = {
    idle: '检测更新', checking: '检测中…', latest: '已是最新', available: '更新',
    downloading: `下载 ${state.progress || 0}%`, ready: '安装', installing: '启动安装…', error: state.retry === 'download' ? '重试下载' : '重试检测',
  }[state.phase];
  const title = state.error || (state.phase === 'latest' ? `已是最新版本 ${state.version}，点击重新检测` : state.version ? `新版本 ${state.version}` : '检测 GitHub 最新版本');
  if (!bridge.checkUpdate) return null;
  if (['idle', 'checking', 'latest'].includes(state.phase)) return <div className="update-control compact">
    <button className="icon-btn update-indicator update-button" disabled={working} onClick={() => void action()} title={title} aria-label={title}>
      {state.phase === 'latest' ? <span className="update-dot" /> : <RefreshCw size={15} className={state.phase === 'checking' ? 'update-spinning' : ''} />}
    </button>
  </div>;
  return <div className="update-control expanded">
    <button className={'btn sm update-button' + (['available', 'ready'].includes(state.phase) ? ' danger' : '')}
      disabled={!bridge.checkUpdate || working} onClick={() => void action()} title={title} aria-label={title}>
      {['available', 'downloading', 'ready'].includes(state.phase) ? <Download size={14} /> : <RefreshCw size={14} />}{label}
    </button>
    {state.phase === 'downloading' && <progress aria-label="更新下载进度" max={100} value={state.progress || 0} />}
    {state.phase === 'available' && <small>新版本 {state.version}</small>}
    {state.phase === 'ready' && <small>下载完成，点击安装</small>}
    {state.error && <small className="update-error" role="alert">{state.error}</small>}
  </div>;
}
