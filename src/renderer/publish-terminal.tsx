import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { bridge } from './api';
import { X } from './icons';

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

type PublishSession = { running: boolean; step: string; result: { ok: boolean; output: string; error?: string } | null };
export function PublishTerminal({ runId, project, session, onClose }: { runId: string; project: string; session: PublishSession; onClose(): void }) {
  const container = useRef<HTMLDivElement>(null);
  const current = useRef(session);
  current.current = session;
  const [readError, setReadError] = useState('');
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
  return <section className="publish-terminal" aria-label="发布终端">
    <header><strong>Terminal · {project}</strong><span role="status">{readError || (session.running ? session.step || '准备发布…' : session.result?.ok ? '发布完成' : '发布失败')}</span><button className="icon-btn" aria-label="收起发布终端" title="收起日志，发布继续运行" onClick={onClose}><X size={16} /></button></header>
    <div className="publish-terminal-content" ref={container} />
  </section>;
}
