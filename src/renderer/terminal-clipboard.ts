import { type MouseEvent, useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import { bridge } from './api';

async function copyText(text: string) {
  try {
    if ((await bridge.writeTerminalClipboard?.(text))?.ok) return true;
  } catch { /* Use the WebView fallback below. */ }
  try { await navigator.clipboard.writeText(text); return true; } catch { /* Use the WebView fallback below. */ }
  const focus = document.activeElement;
  const helper = document.createElement('textarea');
  helper.value = text;
  helper.readOnly = true;
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  document.body.appendChild(helper);
  try {
    helper.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    helper.remove();
    if (focus instanceof HTMLElement) focus.focus({ preventScroll: true });
  }
}

function visibleTerminalText(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  let text = '';
  const end = Math.min(buffer.viewportY + terminal.rows, buffer.length);
  for (let row = buffer.viewportY; row < end; row++) {
    const line = buffer.getLine(row);
    if (row > buffer.viewportY && !line?.isWrapped) text += '\n';
    text += line?.translateToString(row + 1 >= end || !buffer.getLine(row + 1)?.isWrapped) || '';
  }
  return text.trimEnd();
}

export function useTerminalClipboard(xterm?: React.RefObject<Terminal | null>) {
  const [message, setMessage] = useState('');
  const messageTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  function notify(text: string) {
    clearTimeout(messageTimer.current);
    setMessage(text);
    messageTimer.current = setTimeout(() => setMessage(''), 2000);
  }
  useEffect(() => () => clearTimeout(messageTimer.current), []);

  async function copy(text: string, success = '已复制选中内容') {
    if (text) notify(await copyText(text) ? success : '复制失败，请重试');
  }

  async function paste(terminal: Terminal) {
    if (terminal.options.disableStdin) return;
    terminal.focus();
    try {
      const result = await bridge.readTerminalClipboard?.();
      if (result && !result.ok) throw Error(result.error);
      const text = result ? result.text : await navigator.clipboard.readText();
      if (text && xterm?.current === terminal && !terminal.options.disableStdin) terminal.paste(text);
    } catch {
      if (xterm?.current === terminal) notify('粘贴失败，请重试');
    }
  }

  function onContextMenu(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const region = event.currentTarget;
    const terminal = xterm?.current;
    const selection = window.getSelection();
    const domSelection = selection && region.contains(selection.anchorNode) && region.contains(selection.focusNode) ? selection.toString() : '';
    const history = region.querySelector<HTMLElement>('.agent-history-view:not([hidden])');
    const selected = domSelection || (!history ? terminal?.getSelection() : '') || '';
    const text = selected || (history ? history.innerText : terminal ? visibleTerminalText(terminal) : region.innerText);
    if (text) void copy(text, selected ? '已复制选中内容' : '已复制终端输出');
    else notify('暂无可复制的终端输出');
  }

  function bind(terminal: Terminal) {
    // Keep plain Ctrl+C available for the program running inside xterm.
    terminal.attachCustomKeyEventHandler(event => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return true;
      const key = event.key.toLowerCase();
      if (key !== 'v' && !(key === 'c' && event.shiftKey)) return true;
      event.preventDefault();
      if (event.type === 'keydown' && !event.repeat) {
        if (key === 'c') void copy(terminal.getSelection());
        else void paste(terminal);
      }
      return false;
    });
    return terminal.onSelectionChange(() => void copy(terminal.getSelection()));
  }

  return { bind, message, onContextMenu };
}
