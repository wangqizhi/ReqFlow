import { useEffect, useState } from 'react';
import { bridge } from './api';

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const LINES = 1;

/** 将终端字节流整理为可读文本行：去掉控制序列，\r 覆盖同一行内容。 */
function visibleLines(text: string) {
  return text.replace(ANSI, '').split('\n').map(line => {
    const parts = line.replace(/\r$/, '').split('\r');
    return parts[parts.length - 1].replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd();
  });
}

/**
 * REQ-297：终端收起时读取发布输出的最新一行，显示在原最小化信息栏内。
 * 只在 active 时轮询；输出结束后停止。
 */
export function usePublishTail(runId: string | undefined, active: boolean) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => { setLines([]); }, [runId]);
  useEffect(() => {
    if (!runId || !active || !bridge.getPublishOutput) return;
    let disposed = false;
    let offset = 0;
    let timer = 0;
    let pending = '';
    let tail: string[] = [];
    const decoder = new TextDecoder();
    const poll = async () => {
      let finished = false;
      try {
        const output = await bridge.getPublishOutput!(runId, offset);
        if (disposed) return;
        if (output.ok) {
          offset = output.offset;
          if (output.data) {
            pending += decoder.decode(Uint8Array.from(atob(output.data), c => c.charCodeAt(0)), { stream: true });
            const all = visibleLines(pending);
            // 最后一段可能尚未换行，保留以便与后续输出拼接
            const cut = pending.lastIndexOf('\n');
            if (cut >= 0) pending = pending.slice(cut + 1);
            tail = [...tail, ...all.slice(0, -1)].filter(Boolean).slice(-LINES);
            const current = all[all.length - 1];
            setLines(current ? [...tail, current].slice(-LINES) : tail);
          }
          finished = output.done;
        }
      } catch { /* 读取失败时保留已显示内容，下次重试 */ }
      if (!disposed && !finished) timer = window.setTimeout(poll, 600);
    };
    void poll();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [runId, active]);
  return lines;
}

/** 在原最小化栏内显示单行发布进度。 */
export function PublishTail({ runId, failure, status, onOpen }: { runId: string; failure: boolean; status: string; onOpen: () => void }) {
  const lines = usePublishTail(runId, true);
  const text = lines.length ? status + ' · ' + lines[lines.length - 1] : status;
  return <button type="button" className={'terminal-collapsed-output' + (failure ? ' failure' : '')} aria-label="发布进度，点击展开发布输出" title={text} onClick={onOpen}><span role="status">{text}</span></button>;
}
