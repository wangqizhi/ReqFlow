import { useEffect, useRef, useState } from 'react';
import { bridge } from './api';
import type { UpdateState } from '../core/update';
import { Download, RefreshCw } from './icons';

export function UpdateButton() {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' });
  const locked = useRef(false);
  const [pending, setPending] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  useEffect(() => {
    if (!bridge.checkUpdate || !bridge.updateState) return;
    let alive = true;
    void bridge.checkUpdate().then(value => { if (alive) setState(value); }).catch(error => { if (alive) setState({ phase: 'error', error: error.message }); });
    const timer = setInterval(() => { void bridge.updateState!().then(value => { if (alive) setState(value); }).catch(() => {}); }, 700);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const working = pending || rechecking || ['checking', 'downloading', 'installing'].includes(state.phase);
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
  // REQ-257：安装界面重新检测 GitHub 最新版本，发现更新的版本时直接下载新版安装包
  const recheck = async () => {
    if (locked.current || working) return;
    locked.current = true;
    setRechecking(true);
    try { setState(await (bridge.recheckUpdate ?? bridge.checkUpdate)!()); }
    catch (error: any) { setState({ phase: 'error', error: error.message || '重新检测失败，请重试', retry: 'check' }); }
    finally { locked.current = false; setRechecking(false); }
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
    {state.phase === 'ready'
      // REQ-257：安装按钮宽度减半，同行提供重新检测，可直接下载更新的版本
      ? <div className="update-ready-row">
        <button className="btn sm update-button danger" disabled={working} onClick={() => void action()} title={title} aria-label={title}>
          <Download size={14} />{label}
        </button>
        <button className="btn sm update-recheck" disabled={working} onClick={() => void recheck()} title="重新检测 GitHub 最新版本；有更新的版本时可直接下载" aria-label="重新检测更新">
          <RefreshCw size={14} className={rechecking ? 'update-spinning' : ''} />重新检测
        </button>
      </div>
      : <button className={'btn sm update-button' + (state.phase === 'available' ? ' danger' : '')}
        disabled={!bridge.checkUpdate || working} onClick={() => void action()} title={title} aria-label={title}>
        {['available', 'downloading'].includes(state.phase) ? <Download size={14} /> : <RefreshCw size={14} />}{label}
      </button>}
    {state.phase === 'downloading' && <progress aria-label="更新下载进度" max={100} value={state.progress || 0} />}
    {state.phase === 'available' && <small>新版本 {state.version}</small>}
    {state.phase === 'ready' && <small>下载完成，点击安装</small>}
    {state.error && <small className="update-error" role="alert">{state.error}</small>}
  </div>;
}
