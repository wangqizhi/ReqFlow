// 项目设置里的引导词输入（REQ-150 / REQ-151）：
// - 默认以只读文本块展示当前引导词，点击进入编辑；编辑框支持输入 @ 补全项目文件与目录：
//   目录列表按需加载并缓存，输入过程只在内存里过滤，下拉支持 ↑↓ 选择、回车/Tab 确认、
//   Esc 关闭；选择目录后追加 / 继续深入。焦点离开字段（且无进行中的 AI 优化）自动收起为文本块。
// - AI 优化：携带最近提交与差异统计请求后端，返回后展示「原文 / 可编辑的优化稿」对比视图。
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { bridge, type FileEntry } from './api';
import { FileText, Folder, Wand } from './icons';

const MENTION_MAX_ITEMS = 30;

/** 光标前是否正处于 @ 引用中：@ 后到光标之间没有空白，且 @ 不紧跟字母数字（避免邮箱误触发）。 */
function detectMention(value: string, caret: number): string | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (/[\s@]/.test(query)) return null;
  if (at > 0 && /[A-Za-z0-9]/.test(before[at - 1])) return null;
  return query;
}

export function GuidanceField({ label, value, onChange, root, projectId, kind, rows = 8, placeholder, disabled, hint }:
  { label: string; value: string; onChange(v: string): void; root: string; projectId: string; kind: 'guidance' | 'delivery'; rows?: number; placeholder?: string; disabled?: boolean; hint?: string }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const dirCache = useRef(new Map<string, FileEntry[]>());
  const [editing, setEditing] = useState(false);
  const [mention, setMention] = useState<{ query: string; caret: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [listing, setListing] = useState<{ dir: string; entries: FileEntry[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [index, setIndex] = useState(0);
  const [ai, setAi] = useState<{ running: boolean; error: string; compare: { original: string; optimized: string; note: string } | null }>({ running: false, error: '', compare: null });
  const menu = useRef<HTMLDivElement>(null);

  const completable = !!root && !!bridge.listDir;
  const open = !!mention && !dismissed && completable;
  const query = mention?.query || '';
  const slash = query.lastIndexOf('/');
  const dirRel = slash >= 0 ? query.slice(0, slash) : '';
  const filterText = (slash >= 0 ? query.slice(slash + 1) : query).toLowerCase();

  useEffect(() => {
    if (!open || !root || !bridge.listDir) return;
    const cached = dirCache.current.get(dirRel);
    if (cached) { setListing({ dir: dirRel, entries: cached }); setLoading(false); setLoadError(''); return; }
    let cancelled = false;
    setLoading(true); setLoadError('');
    bridge.listDir(root, dirRel).then((r) => {
      if (cancelled) return;
      if (!r.ok) { setListing(null); setLoadError(r.error || '目录读取失败'); return; }
      dirCache.current.set(dirRel, r.entries);
      setListing({ dir: dirRel, entries: r.entries });
    }).catch((e: any) => { if (!cancelled) { setListing(null); setLoadError(e?.message || '目录读取失败'); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, root, dirRel]);

  const entries = open && listing?.dir === dirRel ? listing.entries : [];
  // 目录尚未加载完成（含 effect 尚未跑到的首帧）一律按读取中展示，避免闪现“没有匹配”
  const fetching = loading || (open && !listing && !loadError);
  const lower = entries.filter((e) => e.name.toLowerCase().includes(filterText));
  const matched = [...lower.filter((e) => e.name.toLowerCase().startsWith(filterText)), ...lower.filter((e) => !e.name.toLowerCase().startsWith(filterText))];
  const shown = matched.slice(0, MENTION_MAX_ITEMS);
  const hidden = matched.length - shown.length;

  useEffect(() => { setIndex(0); }, [filterText, dirRel]);
  useEffect(() => { menu.current?.querySelector('.mention-item.on')?.scrollIntoView({ block: 'nearest' }); }, [index]);

  function refreshMention() {
    const ta = input.current;
    if (!ta) return;
    const next = detectMention(ta.value, ta.selectionStart ?? 0);
    if (next === null) { setMention(null); return; }
    if (mention?.query !== next) { setDismissed(false); setIndex(0); }
    setMention({ query: next, caret: ta.selectionStart ?? 0 });
  }

  function applyMention(entry: FileEntry) {
    const ta = input.current;
    if (!ta || !mention) return;
    const caret = mention.caret;
    const before = ta.value.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at < 0) return;
    const insert = entry.rel + (entry.dir ? '/' : ' ');
    onChange(before.slice(0, at + 1) + insert + ta.value.slice(caret));
    if (!entry.dir) setDismissed(true);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = at + 1 + insert.length;
      ta.setSelectionRange(pos, pos);
      setMention(entry.dir ? { query: entry.rel + '/', caret: pos } : null);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (open && shown.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setIndex((i) => e.key === 'ArrowDown' ? (i + 1) % shown.length : (i - 1 + shown.length) % shown.length);
      return;
    }
    if (open && shown.length > 0 && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      applyMention(shown[index]);
      return;
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation(); // 先关闭补全列表，不冒泡关闭外层弹窗
      setDismissed(true);
    }
  }

  async function runOptimize() {
    if (ai.running || disabled || !value.trim()) return;
    if (!bridge.optimizeGuidance) { setAi({ running: false, error: 'AI 优化仅桌面版可用', compare: null }); return; }
    setEditing(true); // 对比视图挂在编辑区内，优化前先进入编辑态
    setAi({ running: true, error: '', compare: null });
    try {
      const r = await bridge.optimizeGuidance(projectId, kind, value);
      if (!r.ok || !r.text?.trim()) throw Error(r.error || 'AI 返回的优化结果为空');
      setAi({ running: false, error: '', compare: { original: value, optimized: r.text, note: r.contextNote || '' } });
    } catch (e: any) {
      setAi((s) => ({ ...s, running: false, error: e.message }));
    }
  }

  return <div className="field guidance-field" onBlur={(e) => {
    // 焦点移出整个字段（标题按钮、输入框、对比区之外）时收起为文本块；AI 优化进行中或对比未处理时保持展开
    if (!e.currentTarget.contains(e.relatedTarget as Node) && !ai.running && !ai.compare) { setEditing(false); setDismissed(true); }
  }}>
    <div className="guidance-field-head">
      <span>{label}</span>
      <div className="guidance-field-actions">
        {editing && <button type="button" className="btn sm" disabled={disabled} title="收起编辑框，回到文本块展示" onClick={() => { setEditing(false); setDismissed(true); }}>收起</button>}
        <button type="button" className="btn sm" disabled={disabled || ai.running || !value.trim()} title="结合最近提交与变更差异，让 AI 优化当前引导词"
          onClick={() => void runOptimize()}><Wand size={14} />{ai.running ? 'AI 优化中…' : 'AI 优化'}</button>
      </div>
    </div>
    {!editing && <button type="button" className={'guidance-view' + (value.trim() ? '' : ' empty')} title="点击编辑，输入 @ 可补全项目文件路径" onClick={() => setEditing(true)}>{value.trim() || `点击填写${label}`}</button>}
    {editing && <>
      <div className="guidance-input-wrap">
        <textarea className="guide-edit" autoFocus rows={rows} value={value} disabled={disabled} placeholder={placeholder}
          ref={input} onChange={(e) => { onChange(e.target.value); refreshMention(); }} onKeyDown={onKeyDown}
          onClick={refreshMention} onKeyUp={refreshMention} />
        {open && <div className={'mention-menu' + (shown.length || fetching || loadError ? '' : ' empty')} role="listbox" aria-label="文件与目录补全" ref={menu}>
          {fetching ? <p className="mention-status">正在读取目录…</p>
            : loadError ? <p className="mention-status">{'目录读取失败：' + loadError}</p>
            : shown.length === 0 ? <p className="mention-status">没有匹配“{filterText}”的文件或目录</p>
            : <>
              {shown.map((entry, i) => (
                <button type="button" key={entry.rel} role="option" aria-selected={i === index} className={'mention-item' + (i === index ? ' on' : '')}
                  onMouseDown={(e) => { e.preventDefault(); applyMention(entry); }} onMouseEnter={() => setIndex(i)}
                  title={entry.rel + (entry.dir ? '/' : '')}>
                  {entry.dir ? <Folder size={14} /> : <FileText size={14} />}
                  <span className="mention-name">{entry.name}</span>
                  <span className="mention-path">{entry.rel}</span>
                </button>
              ))}
              {hidden > 0 && <p className="mention-status">还有 {hidden} 项未展示，继续输入可缩小范围</p>}
            </>}
        </div>}
      </div>
      {hint && <p className="guidance-field-hint">{hint}</p>}
      {ai.error && <p className="settings-message" role="alert">{ai.error}</p>}
      {ai.compare && <div className="guidance-compare">
        <div className="guidance-compare-head">
          <strong>AI 优化对比</strong>
          {ai.compare.note && <span title={ai.compare.note}>{ai.compare.note}</span>}
        </div>
        <label className="field">原文（优化前）<textarea className="guide-edit" rows={rows} readOnly value={ai.compare.original} /></label>
        <label className="field">优化后 · 可编辑<textarea className="guide-edit" rows={rows} value={ai.compare.optimized}
          onChange={(e) => setAi((s) => s.compare ? { ...s, compare: { ...s.compare, optimized: e.target.value } } : s)} /></label>
        <div className="settings-actions">
          <button type="button" className="btn primary" disabled={disabled || !ai.compare.optimized.trim()}
            onClick={() => { onChange(ai.compare!.optimized.trim()); setAi({ running: false, error: '', compare: null }); }}>应用优化结果</button>
          <button type="button" className="btn" disabled={disabled} onClick={() => setAi({ running: false, error: '', compare: null })}>放弃</button>
        </div>
      </div>}
    </>}
  </div>;
}
