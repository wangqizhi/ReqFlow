import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { Minus, Trash } from './icons';

/** 底部终端「AI 交互」页签（REQ-295）：记录发送给 AI 供应商的内容与收到的回复，供用户查看交互过程。 */
export type AIConsoleEntry = { id: number; time: string; kind: 'send' | 'recv' | 'info' | 'error'; title: string; text?: string };
type AIConsoleState = { entries: AIConsoleEntry[]; open: boolean; pending: number; focus: number };

const MAX_ENTRIES = 200;
let state: AIConsoleState = { entries: [], open: false, pending: 0, focus: 0 };
let seq = 0;
const listeners = new Set<() => void>();
function set(next: Partial<AIConsoleState>) { state = { ...state, ...next }; listeners.forEach(l => l()); }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const aiConsole = {
  log(kind: AIConsoleEntry['kind'], title: string, text?: string) {
    const entry = { id: ++seq, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), kind, title, text };
    set({ entries: [...state.entries, entry].slice(-MAX_ENTRIES) });
  },
  /** 开始一次交互：展开终端并切到「AI 交互」页签。 */
  begin() { set({ open: true, pending: state.pending + 1, focus: state.focus + 1 }); },
  end() { set({ pending: Math.max(0, state.pending - 1) }); },
  setOpen(open: boolean) { set({ open, focus: open ? state.focus + 1 : state.focus }); },
  clear() { set({ entries: [] }); },
};

export function useAIConsole() { return useSyncExternalStore(subscribe, () => state); }

const labels: Record<AIConsoleEntry['kind'], string> = { send: '→ 发送', recv: '← 收到', info: '·', error: '× 错误' };

export function AIConsole({ tabs, onClose }: { tabs?: ReactNode; onClose(): void }) {
  const { entries, pending } = useAIConsole();
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => { const el = body.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [entries]);
  return <section className="publish-terminal ai-console" aria-label="AI 交互">
    <header><strong>Terminal · AI 交互</strong>
      <span className={'terminal-status' + (pending ? ' waiting' : '')} role="status">{pending ? '等待 AI 响应…' : entries.length ? '展示发送给 AI 供应商的内容与收到的回复' : '暂无 AI 交互记录'}</span>
      <button className="icon-btn" aria-label="清空 AI 交互记录" title="清空记录" disabled={!entries.length || !!pending} onClick={() => aiConsole.clear()}><Trash size={15} /></button>
      <button className="icon-btn" aria-label="收起 AI 交互终端" title="收起" onClick={onClose}><Minus size={16} /></button>
    </header>
    {tabs}
    <div className="publish-terminal-body">
      <div className="ai-console-log" ref={body} tabIndex={0} role="log" aria-label="AI 交互记录"
        onScroll={e => { const el = e.currentTarget; stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8; }}>
        {entries.map(e => <div key={e.id} className={'ai-console-entry ' + e.kind}>
          <div className="ai-console-line"><span className="ai-console-time">[{e.time}]</span> <span className="ai-console-kind">{labels[e.kind]}</span> {e.title}</div>
          {e.text && <pre>{e.text}</pre>}
        </div>)}
      </div>
    </div>
  </section>;
}
