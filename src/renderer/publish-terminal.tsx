import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
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
let terminalLoaded = false;
let terminalSaving = false;
async function loadTerminalSetting() {
  if (terminalLoaded || !bridge.getTerminalSetting) return;
  terminalLoaded = true;
  try {
    const r = await bridge.getTerminalSetting();
    if (!r.ok) throw Error('读取 Terminal 设置失败');
    if (terminalSaving) return;
    if (r.settings) localStorage.setItem(settingKey, String(r.settings.enabled));
    else await bridge.saveTerminalSetting?.(readSetting());
    window.dispatchEvent(new Event(settingEvent));
  } catch { terminalLoaded = false; }
}
export function useTerminalSetting(): [boolean, (enabled: boolean) => Promise<void>] {
  useEffect(() => { void loadTerminalSetting(); }, []);
  const enabled = useSyncExternalStore(subscribe, readSetting);
  return [enabled, async value => {
    terminalSaving = true;
    const result = await bridge.saveTerminalSetting?.(value);
    if (result && !result.ok) throw Error(result.error || '无法保存 Terminal 设置');
    localStorage.setItem(settingKey, String(value));
    window.dispatchEvent(new Event(settingEvent));
  }];
}

type PublishSession = Pick<TerminalSession, 'running' | 'step' | 'startedAt' | 'endedAt' | 'idle'> & { result: { ok: boolean; output?: string; error?: string } | null };
function elapsedTime(start: number, end: number) {
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return (seconds >= 3600 ? String(Math.floor(seconds / 3600)).padStart(2, '0') + ':' : '') + String(Math.floor(seconds / 60) % 60).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}
export function PublishTerminal({ runId, project, session, onClose, onDetach }: { runId: string; project: string; session: PublishSession; onClose(): void; onDetach?(): Promise<void> }) {
  const container = useRef<HTMLDivElement>(null);
  const veil = useRef<HTMLDivElement>(null);
  const veilApi = useRef<{ show(): void; hide(): void } | null>(null);
  const detachingRef = useRef(false);
  const current = useRef(session);
  current.current = session;
  const [readError, setReadError] = useState('');
  const [detachError, setDetachError] = useState(''), [detaching, setDetaching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!session.running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session.running, session.startedAt]);
  async function detach() {
    if (!onDetach || detaching) return;
    detachingRef.current = true;
    veilApi.current?.show();
    setDetaching(true); setDetachError('');
    try { await onDetach(); } catch (error: any) { setDetachError(error.message || '无法打开独立终端'); }
    finally {
      detachingRef.current = false;
      setDetaching(false);
      veilApi.current?.hide();
    }
  }
  useLayoutEffect(() => {
    const content = container.current!, overlay = veil.current!;
    let veilHideTimer: ReturnType<typeof setTimeout> | undefined;
    // Keep the opaque veil on top for the whole gesture. The terminal stays
    // hidden until xterm has reflowed and painted at the settled size, so a
    // maximize (or a continuous drag-resize) never exposes an intermediate
    // frame or an old canvas stretched to the new box.
    const showVeil = () => {
      clearTimeout(veilHideTimer);
      content.style.visibility = 'hidden';
      overlay.style.visibility = 'visible';
      overlay.style.opacity = '1';
    };
    const hideVeil = () => {
      if (detachingRef.current) return;
      content.style.visibility = '';
      overlay.style.opacity = '0';
      clearTimeout(veilHideTimer);
      veilHideTimer = setTimeout(() => {
        if (!detachingRef.current && overlay.isConnected && overlay.style.opacity === '0') overlay.style.visibility = 'hidden';
      }, 180);
    };
    veilApi.current = { show: showVeil, hide: hideVeil };
    showVeil();
    const terminal = new Terminal({
      convertEol: true, disableStdin: true, cursorBlink: false, scrollback: 5000, screenReaderMode: true,
      fontFamily: '"Cascadia Code", Consolas, "Microsoft YaHei", monospace', fontSize: 12,
      theme: { background: '#1c1917', foreground: '#e7e5e4', cursor: '#a8a29e', selectionBackground: '#57534e' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(content);
    let disposed = false, timer: ReturnType<typeof setTimeout>, offset = 0;
    let cycleTimer: ReturnType<typeof setTimeout> | undefined, drainTimer: ReturnType<typeof setTimeout> | undefined, frame = 0;
    let renderSub: { dispose(): void } | undefined, renderFallback: ReturnType<typeof setTimeout> | undefined;
    let generation = 0, replayReady = false;
    let stableWidth = 0, stableHeight = 0, stableSince = 0, cycleStarted = 0;
    const paintAt = (ticket: number) => {
      if (disposed || ticket !== generation || !replayReady) return;
      if (!content.clientWidth || !content.clientHeight) return;
      renderSub?.dispose(); renderSub = undefined;
      clearTimeout(renderFallback); clearTimeout(drainTimer);
      let done = false, painted = false;
      const finish = () => {
        if (done || disposed || ticket !== generation) return;
        done = true;
        renderSub?.dispose(); renderSub = undefined;
        clearTimeout(renderFallback);
        // Two frames after xterm's own paint: the canvas is complete before
        // the veil is faded out, so the reveal is a clean transition.
        frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
          if (disposed || ticket !== generation) return;
          setLoading(false);
          hideVeil();
        }); });
      };
      const paint = () => {
        if (disposed || ticket !== generation || done || painted) return;
        painted = true;
        renderSub?.dispose();
        clearTimeout(renderFallback);
        renderSub = terminal.onRender(finish);
        fit.fit();
        terminal.refresh(0, terminal.rows - 1);
        renderFallback = setTimeout(finish, 250);
      };
      // Let every queued write (replay or live output) finish parsing before
      // reflowing, so the reveal always shows the complete log.
      drainTimer = setTimeout(paint, 400);
      terminal.write('', () => { clearTimeout(drainTimer); paint(); });
    };
    // Wait for the container to keep its size for a full beat. This also
    // absorbs the successive WM_SIZE reports a Windows maximize emits.
    const waitForSettledSize = () => {
      const ticket = ++generation;
      showVeil();
      setLoading(true);
      clearTimeout(cycleTimer); clearTimeout(drainTimer); clearTimeout(renderFallback); cancelAnimationFrame(frame);
      renderSub?.dispose(); renderSub = undefined;
      cycleStarted = performance.now();
      stableWidth = 0; stableHeight = 0; stableSince = cycleStarted;
      const tick = () => {
        if (disposed || ticket !== generation) return;
        const at = performance.now(), width = content.clientWidth, height = content.clientHeight;
        if (!width || !height) { clearTimeout(cycleTimer); cycleTimer = setTimeout(tick, 50); return; }
        if (width !== stableWidth || height !== stableHeight) {
          stableWidth = width; stableHeight = height; stableSince = at;
        }
        const stableFor = at - stableSince, aliveFor = at - cycleStarted;
        // Keep the veil up for at least one Windows maximize animation, so a
        // trailing WM_SIZE cannot make the content flash back for a few frames.
        if (stableFor < 360 || aliveFor < 360) {
          clearTimeout(cycleTimer);
          cycleTimer = setTimeout(tick, Math.max(20, Math.min(50, 360 - aliveFor, 360 - stableFor)));
          return;
        }
        paintAt(ticket);
      };
      clearTimeout(cycleTimer);
      cycleTimer = setTimeout(tick, 50);
    };
    const resize = new ResizeObserver(waitForSettledSize);
    resize.observe(content);
    window.addEventListener('resize', waitForSettledSize);
    fit.fit();
    terminal.writeln(current.current.idle ? '终端已就绪，启动项目发布后将在这里显示输出。' : '发布 · ' + project);
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
      if (!replayReady) { replayReady = true; waitForSettledSize(); }
      if (!current.current.running && !streamRunning) {
        const result = current.current.result;
        if (offset === 0 && result?.output) terminal.write(result.output);
        if (!current.current.idle) terminal.writeln('\r\n' + (result?.ok ? '发布完成' : '发布失败：' + (result?.error || '执行失败')));
        return;
      }
      timer = setTimeout(poll, 250);
    };
    if (current.current.idle) { replayReady = true; waitForSettledSize(); } else void poll();
    return () => {
      disposed = true; generation++;
      clearTimeout(timer); clearTimeout(cycleTimer); clearTimeout(drainTimer); clearTimeout(renderFallback); clearTimeout(veilHideTimer);
      cancelAnimationFrame(frame); renderSub?.dispose(); resize.disconnect(); window.removeEventListener('resize', waitForSettledSize); terminal.dispose();
      veilApi.current = null;
    };
  }, [runId, project]);
  return <section className="publish-terminal" aria-label="终端" aria-busy={session.running || loading || detaching} data-run-id={runId}>
    <header><strong>Terminal · {project}</strong>
      {!session.idle && <span className={'terminal-indicator ' + (session.running ? 'running' : session.result?.ok ? 'success' : 'failure')} aria-label={session.running ? '发布运行中' : session.result?.ok ? '发布成功' : '发布失败'}>{session.running ? <RefreshCw size={14} className="terminal-spinner" /> : session.result?.ok ? <Check size={14} /> : <X size={14} />}</span>}
      <span className="terminal-status" role="status">{detachError || readError || (session.idle ? '就绪 · 等待发布' : session.running ? '运行中 · ' + (session.step || '准备发布…') : session.result?.ok ? '发布完成' : '发布失败')}</span>
      {!session.idle && <time className="terminal-elapsed" aria-label={session.running ? '运行时间' : '总用时'} dateTime={'PT' + Math.max(0, Math.floor(((session.endedAt || now) - session.startedAt) / 1000)) + 'S'}>{session.running ? '运行 ' : '用时 '}{elapsedTime(session.startedAt, session.endedAt || now)}</time>}
      {onDetach && <button className="icon-btn" aria-label="在独立窗口打开终端" title="在独立窗口打开终端" disabled={detaching} onClick={() => void detach()}><Maximize2 size={16} /></button>}
      <button className="icon-btn" aria-label={onDetach ? '收起终端' : '关闭终端'} title="关闭显示，发布继续运行" onClick={onClose}><X size={16} /></button></header>
    <div className="publish-terminal-body">
      <div className="publish-terminal-content" ref={container} />
      <div className="terminal-loading" ref={veil} role="status" aria-hidden={!loading && !detaching}>
        <RefreshCw size={20} className="terminal-loading-spinner" /><span>{detaching ? '正在打开独立终端…' : '正在加载终端…'}</span>
      </div>
    </div>
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
        if (!result?.ok || !result.session) throw Error(result?.error || '终端会话不可用');
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
  return <div className="publish-terminal-window">{error && <p className="terminal-window-error" role="alert">{error}</p>}{session ? <PublishTerminal runId={runId} project={session.project} session={session} onClose={() => void close()} /> : <div className="terminal-loading" role="status"><RefreshCw size={20} className="terminal-loading-spinner" /><span>{error ? '正在重试…' : '正在加载终端…'}</span></div>}</div>;
}

// Interactive agent sessions use the same dock as publish output, but remain
// alive in the backend while the user switches projects or collapses the dock.
// REQ-205：会话产生过输出后连续静默超过该时长且未结束，视为可能在等待用户输入。
export const AGENT_INPUT_IDLE_MS = 45000;
export function agentNeedsInput(done: boolean | undefined, idleMs: number | undefined) {
  return !done && (idleMs || 0) >= AGENT_INPUT_IDLE_MS;
}
export function AgentTerminal({ runId, project, agent, onClose, onState }: { runId: string; project: string; agent: string; onClose(done: boolean): void; onState?(state: { needsInput: boolean; done: boolean }): void }) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const reportState = useRef(onState);
  reportState.current = onState;
  useEffect(() => {
    let disposed = false, offset = 0, timer: ReturnType<typeof setTimeout>;
    let inputQueue = Promise.resolve();
    let reportedNeedsInput: boolean | undefined, reportedDone: boolean | undefined;
    const terminal = new Terminal({ cursorBlink: true, scrollback: 5000, fontSize: 13, fontFamily: 'Consolas, "Microsoft YaHei", monospace', theme: { background: '#1c1917', foreground: '#e7e5e4' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(container.current!);
    const report = (message: string) => { if (!disposed) setError(message); };
    const size = () => { if (!container.current?.clientWidth || !container.current.clientHeight) return; fit.fit(); void bridge.resizeAgent?.(runId, terminal.cols, terminal.rows).then(r => { if (!r.ok) report(r.error || '终端尺寸同步失败'); }).catch(e => report(e.message)); };
    const observer = new ResizeObserver(size); observer.observe(container.current!); size();
    const input = terminal.onData(data => {
      inputQueue = inputQueue.then(async () => { if (disposed) return; const r = await bridge.writeAgent?.(runId, data); if (!r?.ok) throw Error(r?.error || '终端输入失败'); }).catch(e => report(e.message));
    });
    const poll = async () => {
      try {
        const r = await bridge.readAgent!(runId, offset);
        if (disposed) return;
        if (!r.ok) throw Error(r.error || '读取终端失败');
        if (r.data) terminal.write(Uint8Array.from(atob(r.data), c => c.charCodeAt(0)));
        offset = r.offset || 0;
        const finished = !!r.done;
        const needsInput = agentNeedsInput(finished, r.idleMs);
        setDone(previous => previous === finished ? previous : finished);
        setWaiting(previous => previous === needsInput ? previous : needsInput);
        // 仅在状态变化时上报，避免高频轮询触发整页重渲染
        if (needsInput !== reportedNeedsInput || finished !== reportedDone) {
          reportedNeedsInput = needsInput; reportedDone = finished;
          reportState.current?.({ needsInput, done: finished });
        }
        if (finished) { terminal.options.disableStdin = true; terminal.options.cursorBlink = false; return; }
      } catch (e: any) { report(e.message); }
      if (!disposed) timer = setTimeout(() => void poll(), 100);
    };
    terminal.focus(); void poll();
    return () => { disposed = true; clearTimeout(timer); observer.disconnect(); input.dispose(); terminal.dispose(); };
  }, [runId]);
  return <section className="publish-terminal" aria-label={agent + ' 交互终端'} data-run-id={runId}><header><strong>Terminal · {project} · {agent}</strong><span className={'terminal-status' + (waiting && !done ? ' waiting' : '')} role="status">{error || (done ? '会话已结束' : waiting ? '可能等待输入，请在终端处理交互' : '可在终端输入，与 ' + agent + ' 沟通')}</span><button className="btn sm" disabled={done || stopping} onClick={async () => { setStopping(true); try { const r = await bridge.stopAgent?.(runId); if (!r?.ok) throw Error(r?.error || '停止失败'); } catch (e: any) { setError(e.message); } finally { setStopping(false); } }}>停止</button><button className="icon-btn" aria-label={done ? '关闭 ' + agent + ' 终端' : '收起 ' + agent + ' 终端'} title={done ? '关闭终端' : '收起后继续运行'} onClick={() => onClose(done)}><X size={16} /></button></header><div className="publish-terminal-body"><div className="publish-terminal-content" ref={container} /></div></section>;
}
