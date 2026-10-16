import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { bridge, type TerminalSession } from './api';
import { Check, Maximize2, RefreshCw, X } from './icons';

const settingKey = 'reqflow-lab-terminal';
const settingEvent = 'reqflow-terminal-changed';
function readSetting() { try { return localStorage.getItem(settingKey) === 'true'; } catch { return false; } }
function subscribe(listener: () => void) {
  window.addEventListener(settingEvent, listener);
  window.addEventListener('storage', listener);
  return () => { window.removeEventListener(settingEvent, listener); window.removeEventListener('storage', listener); };
}
export function useTerminalSetting(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, readSetting);
  return [enabled, value => {
    localStorage.setItem(settingKey, String(value));
    window.dispatchEvent(new Event(settingEvent));
  }];
}

type PublishSession = Pick<TerminalSession, 'running' | 'step' | 'startedAt' | 'endedAt'> & { result: { ok: boolean; output?: string; error?: string } | null };
function elapsedTime(start: number, end: number) {
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return (seconds >= 3600 ? String(Math.floor(seconds / 3600)).padStart(2, '0') + ':' : '') + String(Math.floor(seconds / 60) % 60).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}
export function PublishTerminal({ runId, project, session, onClose, onDetach }: { runId: string; project: string; session: PublishSession; onClose(): void; onDetach?(): Promise<void> }) {
  const container = useRef<HTMLDivElement>(null);
  const current = useRef(session);
  current.current = session;
  const [readError, setReadError] = useState('');
  const [detachError, setDetachError] = useState(''), [detaching, setDetaching] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!session.running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session.running, session.startedAt]);
  async function detach() {
    if (!onDetach || detaching) return;
    setDetaching(true); setDetachError('');
    try { await onDetach(); } catch (error: any) { setDetachError(error.message || '无法打开独立终端'); }
    finally { setDetaching(false); }
  }
  useEffect(() => {
    const terminal = new Terminal({
      convertEol: true, disableStdin: true, cursorBlink: false, scrollback: 5000, screenReaderMode: true,
      fontFamily: '"Cascadia Code", Consolas, "Microsoft YaHei", monospace', fontSize: 12,
      theme: { background: '#1c1917', foreground: '#e7e5e4', cursor: '#a8a29e', selectionBackground: '#57534e' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current!);
    const resize = new ResizeObserver(() => { if (container.current?.clientHeight && container.current.clientWidth) fit.fit(); });
    resize.observe(container.current!);
    fit.fit();
    terminal.writeln('发布 · ' + project);
    let disposed = false, timer: ReturnType<typeof setTimeout>, offset = 0;
    const poll = async () => {
      let streamRunning = false;
      try {
        const output = await bridge.getPublishOutput!(runId, offset);
        if (disposed) return;
        if (!output.ok) throw Error(output.error || '无法读取发布输出');
        setReadError('');
        if (output.truncated) terminal.writeln('\r\n…（前文已截断）…');
        if (output.data) terminal.write(Uint8Array.from(atob(output.data), char => char.charCodeAt(0)));
        offset = output.offset;
        streamRunning = output.started && !output.done;
      } catch (error: any) {
        if (disposed) return;
        setReadError(error.message || '无法读取发布输出');
      }
      if (disposed) return;
      if (!current.current.running && !streamRunning) {
        const result = current.current.result;
        if (offset === 0 && result?.output) terminal.write(result.output);
        terminal.writeln('\r\n' + (result?.ok ? '发布完成' : '发布失败：' + (result?.error || '执行失败')));
        return;
      }
      timer = setTimeout(poll, 250);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); resize.disconnect(); terminal.dispose(); };
  }, [runId, project]);
  return <section className="publish-terminal" aria-label="发布终端" aria-busy={session.running} data-run-id={runId}>
    <header><strong>Terminal · {project}</strong>
      <span className={'terminal-indicator ' + (session.running ? 'running' : session.result?.ok ? 'success' : 'failure')} aria-label={session.running ? '发布运行中' : session.result?.ok ? '发布成功' : '发布失败'}>{session.running ? <RefreshCw size={14} className="terminal-spinner" /> : session.result?.ok ? <Check size={14} /> : <X size={14} />}</span>
      <span className="terminal-status" role="status">{detachError || readError || (session.running ? '运行中 · ' + (session.step || '准备发布…') : session.result?.ok ? '发布完成' : '发布失败')}</span>
      <time className="terminal-elapsed" aria-label={session.running ? '运行时间' : '总用时'} dateTime={'PT' + Math.max(0, Math.floor(((session.endedAt || now) - session.startedAt) / 1000)) + 'S'}>{session.running ? '运行 ' : '用时 '}{elapsedTime(session.startedAt, session.endedAt || now)}</time>
      {onDetach && <button className="icon-btn" aria-label="在独立窗口打开终端" title="在独立窗口打开终端" disabled={detaching} onClick={() => void detach()}><Maximize2 size={16} /></button>}
      <button className="icon-btn" aria-label={onDetach ? '收起发布终端' : '关闭发布终端'} title="关闭显示，发布继续运行" onClick={onClose}><X size={16} /></button></header>
    <div className="publish-terminal-content" ref={container} />
  </section>;
}

export function PublishTerminalWindow({ runId }: { runId: string }) {
  const [session, setSession] = useState<TerminalSession | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await bridge.getPublishTerminal?.(runId);
        if (cancelled) return;
        if (!result?.ok || !result.session) throw Error(result?.error || '发布终端会话不可用');
        setSession(result.session); setError(''); document.title = 'Terminal · ' + result.session.project;
      } catch (e: any) { if (!cancelled) setError(e.message); }
      finally { if (!cancelled) timer = setTimeout(poll, 250); }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [runId]);
  async function close() {
    try { const result = await bridge.closePublishTerminal?.(runId); if (!result?.ok) throw Error(result?.error || '无法关闭终端窗口'); }
    catch (e: any) { setError(e.message); }
  }
  return <div className="publish-terminal-window">{error && <p className="terminal-window-error" role="alert">{error}</p>}{session ? <PublishTerminal runId={runId} project={session.project} session={session} onClose={() => void close()} /> : <p role="status">{error ? '正在重试…' : '正在加载发布终端…'}</p>}</div>;
}
