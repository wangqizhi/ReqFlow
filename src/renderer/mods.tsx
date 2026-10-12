import protocol from '../../docs/mod-protocol.md?raw';
import { useEffect } from 'react';
import { renderMarkdown } from './markdown';
import { X, Layers } from './icons';
export function ModsOverlay({ onClose }: { onClose(): void }) {
  // REQ-062：Esc 关闭插件/MOD 说明浮层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="help-panel" role="dialog" aria-modal="true" aria-label="插件/MOD">
      <header className="help-header"><div><h2><Layers /> 插件 / MOD</h2><p>对接规范草案 · 尚未开放插件安装与运行功能</p></div><button className="icon-btn" aria-label="关闭插件/MOD" onClick={onClose}><X /></button></header>
      <article className="help-body fb-md mod-document" dangerouslySetInnerHTML={{ __html: renderMarkdown(protocol) }} />
    </section>
  </div>;
}
