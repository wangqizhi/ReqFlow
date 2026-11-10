// REQ-318：浏览项目底部信息栏 —— 左侧显示选中文件/目录的路径、大小、权限与修改时间，
// 右侧显示 Git Push 的过程输出（进行中实时轮询，完成后保留最近一次结果，可展开完整日志）。
import { useEffect, useRef, useState } from 'react';
import { bridge, type FileEntry, type FileInfo } from './api';
import { ChevronDown, Copy, GitBranch, RefreshCw } from './icons';

export type PushLog = { lines: string[]; running: boolean; failed: boolean; startedAt?: string; endedAt?: string };

const humanSize = (n: number) =>
  n < 1024 ? n + ' B' : n < 1024 * 1024 ? (n / 1024).toFixed(1) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';

/** Push 进行中每 400ms 读取一次过程输出，结束后再读一次拿到最终结果。 */
export function usePushLog(root: string) {
  const [log, setLog] = useState<PushLog | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  async function read() {
    const r = await bridge.gitPushOutput?.(root).catch(() => undefined);
    if (r?.ok && r.started) setLog({ lines: r.lines || [], running: !!r.running, failed: !!r.failed, startedAt: r.startedAt, endedAt: r.endedAt });
  }
  useEffect(() => () => clearInterval(timer.current), []);
  useEffect(() => { setLog(null); }, [root]);
  /** 包裹一次 Push：开始前清空旧日志并启动轮询，完成后停止轮询。 */
  async function track<T>(work: () => Promise<T>): Promise<T> {
    setLog({ lines: ['正在推送…'], running: true, failed: false, startedAt: new Date().toISOString() });
    clearInterval(timer.current);
    timer.current = setInterval(() => void read(), 400);
    try { return await work(); }
    finally {
      clearInterval(timer.current);
      await read();
    }
  }
  return { log, track };
}

export function BrowserStatusBar({ root, entry, refreshKey, push, notify }: {
  root: string; entry: FileEntry | null; refreshKey: number; push: PushLog | null;
  notify(text: string, kind?: 'ok' | 'err'): void;
}) {
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setInfo(null);
    setError('');
    if (!root || !entry || !bridge.statFile) return;
    let alive = true;
    void bridge.statFile(root, entry.rel).then(r => {
      if (!alive) return;
      if (r.ok) setInfo(r);
      else setError(r.error || '无法读取文件信息');
    }).catch(e => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [root, entry?.rel, refreshKey]);

  useEffect(() => { if (push?.running) setOpen(false); }, [push?.running]);
  useEffect(() => {
    if (open && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [open, push?.lines.length]);

  const last = push?.lines[push.lines.length - 1] || '';
  const fields = info ? [
    info.dir ? '目录' : humanSize(info.size),
    `权限 ${info.mode}${info.writable ? '' : '（只读）'}`,
    info.attributes && `属性 ${info.attributes}`,
    info.owner,
    info.symlink && '符号链接',
    `修改于 ${new Date(info.modified).toLocaleString('zh-CN')}`,
  ].filter(Boolean) as string[] : [];

  return <footer className="fb-status" aria-label="信息栏">
    {open && push && <div className="fb-status-log" role="log" aria-label="Push 过程输出">
      <div className="fb-status-log-head">
        <strong><GitBranch size={14} />Push 过程</strong>
        <span className="muted">{push.startedAt && new Date(push.startedAt).toLocaleTimeString('zh-CN')}{push.endedAt && ` – ${new Date(push.endedAt).toLocaleTimeString('zh-CN')}`}</span>
        <button type="button" className="btn sm" onClick={() => void navigator.clipboard.writeText(push.lines.join('\n')).then(() => notify('已复制 Push 输出'), () => notify('复制失败，请检查剪贴板权限', 'err'))}><Copy size={14} />复制</button>
      </div>
      <pre ref={logRef}>{push.lines.join('\n') || '暂无输出'}</pre>
    </div>}
    <div className="fb-status-file" title={info?.path}>
      {!entry ? <span className="muted">选择文件或目录查看路径与权限</span>
        : error ? <span className="error">{error}</span>
        : !info ? <span className="muted">读取文件信息…</span>
        : <>
          <span className="fb-status-path">{info.path}</span>
          {fields.map((field, index) => <span key={index} className="fb-status-field">{field}</span>)}
          <button type="button" className="icon-btn" aria-label="复制完整路径" title="复制完整路径"
            onClick={() => void navigator.clipboard.writeText(info.path).then(() => notify('已复制路径'), () => notify('复制失败，请检查剪贴板权限', 'err'))}><Copy size={14} /></button>
        </>}
    </div>
    {push && <button type="button" className={'fb-status-push' + (push.failed ? ' err' : push.running ? '' : ' ok')} aria-expanded={open}
      title={last} onClick={() => setOpen(!open)}>
      {push.running ? <RefreshCw size={14} className="spin" /> : <GitBranch size={14} />}
      <span>{push.running ? 'Push 中 · ' : push.failed ? 'Push 失败 · ' : 'Push 完成 · '}{last}</span>
      <ChevronDown size={14} />
    </button>}
  </footer>;
}
