import { type MouseEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy } from './icons';

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* Use the WebView fallback below. */ }
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
  }
}

export function useTerminalCopy(getSelection?: () => string | undefined) {
  const [menu, setMenu] = useState<{ x: number; y: number; text: string; focus: HTMLElement | null }>();
  const [message, setMessage] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const messageTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  async function copy(text: string) {
    if (!text) return;
    const ok = await copyText(text);
    clearTimeout(messageTimer.current);
    setMessage(ok ? '已复制选中内容' : '复制失败，请重试');
    messageTimer.current = setTimeout(() => setMessage(''), 2000);
  }
  useEffect(() => () => clearTimeout(messageTimer.current), []);
  useEffect(() => {
    if (!menu) return;
    const el = menuRef.current!;
    (el.querySelector('button:not(:disabled)') as HTMLElement | null || el).focus();
    const dismiss = (event: PointerEvent) => {
      if (!el.contains(event.target as Node)) setMenu(undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(undefined);
      menu.focus?.focus({ preventScroll: true });
    };
    const resize = () => setMenu(undefined);
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('resize', resize);
    window.addEventListener('blur', resize);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', resize);
    };
  }, [menu]);

  function onContextMenu(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    const selection = window.getSelection();
    const target = event.target as HTMLElement;
    const inTerminal = selection && event.currentTarget.contains(selection.anchorNode) && event.currentTarget.contains(selection.focusNode);
    const text = (target.closest('.xterm') ? getSelection?.() : inTerminal ? selection.toString() : '') || '';
    const bounds = target.getBoundingClientRect();
    const x = event.clientX || bounds.left;
    const y = event.clientY || bounds.bottom;
    setMenu({ x: Math.max(0, Math.min(x, innerWidth - 144)), y: Math.max(0, Math.min(y, innerHeight - 46)), text,
      focus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  }

  const copyMenu = menu && createPortal(<div className="terminal-copy-menu" ref={menuRef} role="menu" aria-label="终端操作" tabIndex={-1}
    style={{ left: menu.x, top: menu.y }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setMenu(undefined); }}>
    <button type="button" role="menuitem" disabled={!menu.text} onClick={() => {
      void copy(menu.text);
      setMenu(undefined);
      menu.focus?.focus({ preventScroll: true });
    }}><Copy />复制</button>
  </div>, document.body);
  return { copy, message, onContextMenu, copyMenu };
}
