import { useEffect, useRef, useState } from 'react';
import { bridge } from './api';

type CloseRequest = { tasks?: number; error?: string };

export function ShutdownDialog() {
  const [request, setRequest] = useState<CloseRequest | null>(null);
  const [pending, setPending] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const receive = (event: Event) => { setPending(false); setRequest((event as CustomEvent<CloseRequest>).detail); };
    window.addEventListener('reqflow-close-request', receive);
    return () => window.removeEventListener('reqflow-close-request', receive);
  }, []);
  useEffect(() => {
    if (!request) return;
    const previous = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [request]);
  if (!request) return null;
  return <div className="overlay update-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="shutdown-title"
    onKeyDown={event => {
      if (event.key === 'Escape' && !pending) { event.stopPropagation(); setRequest(null); }
      if (event.key === 'Tab') {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const next = buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length];
        if (next) { event.preventDefault(); next.focus(); }
      }
    }}>
    <div className="dialog update-confirm-dialog">
      <div className="dialog-head"><div><h3 id="shutdown-title">{request.error ? '暂时无法关闭 ReqFlow' : `有 ${request.tasks} 条任务正在执行`}</h3>
        <p>{request.error ? '请处理后重试。' : '关闭 ReqFlow 会中断本窗口内的 Agent 终端。'}</p></div></div>
      <p className="update-confirm-text">{request.error || '执行中的任务与运行记录会保留，不会释放。重新打开 ReqFlow 后，CLI 仍可使用原运行记录继续操作。'}</p>
      <div className="settings-actions update-confirm-actions">
        <button ref={cancel} type="button" className="btn" disabled={pending} onClick={() => setRequest(null)}>{request.error ? '知道了' : '取消'}</button>
        {!request.error && <button type="button" className="btn primary" disabled={pending} onClick={async () => {
          setPending(true);
          try { await bridge.windowControl?.('confirmClose'); }
          catch (error: any) { setPending(false); setRequest({ error: error.message || '关闭失败，请重试' }); }
        }}>{pending ? '正在关闭…' : '仍然关闭'}</button>}
      </div>
    </div>
  </div>;
}
