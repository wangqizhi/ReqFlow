import { useState } from 'react';
import { createPortal } from 'react-dom';
import { aiConsole } from './ai-console';
import { renderMarkdown } from './markdown';
import { bridge, type MemoryInfo, type MemorySettings } from './api';
import { Eye, FolderOpen, Pencil, Wand, X } from './icons';

export const emptyMemory: MemorySettings = { enabled: true, limitKB: 100, recentLimit: 30, notes: {} };

function kb(bytes: number) { return bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1) + ' KB'; }
const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** 全局记忆（REQ-294）：跨项目记忆的预留大小、手动条目与自动生成内容，保存后拼接进开发 Prompt。 */
export function MemorySettingsPanel({ value, change, info, disabled, error, notify }: {
  value: MemorySettings; change(v: MemorySettings): void; info: MemoryInfo | null; disabled: boolean; error: string;
  notify(text: string, kind?: 'ok' | 'err'): void;
}) {
  const sections = info?.sections || [];
  const files = info?.files || [];
  const limit = value.limitKB * 1024;
  const manual = sections.filter(s => !s.auto).reduce((sum, s) => sum + byteLength(value.notes[s.key] || ''), 0);
  const used = info?.used || 0;
  const percent = info?.limit ? Math.min(100, Math.round(used / info.limit * 100)) : 0;
  return <div className="memory-settings">
    <p className="settings-hint">全局记忆跨项目保存最近工作、项目简介与目录、常用技术方案和 UI 设计要求等，生成 Markdown 文件到数据目录。开启后，排期与指派生成的开发 Prompt 末尾会引用这些文件，开发 AI 会在实现前先阅读。</p>
    {error && <p className="settings-message err" role="alert">{error}</p>}
    <div className="validation-setting"><div><label htmlFor="memory-enabled">启用全局记忆</label><p>关闭后不再更新记忆文件，开发 Prompt 也不再引用；已填写的内容保留。</p></div><label className="switch"><input id="memory-enabled" type="checkbox" checked={value.enabled} disabled={disabled} onChange={e => change({ ...value, enabled: e.target.checked })} /><span className="slider" /><span className="switch-state">{value.enabled ? '已开启' : '已关闭'}</span></label></div>
    <div className="settings-columns">
      <label className="field">预留大小（KB）<input type="number" min={10} max={1024} step={1} value={value.limitKB} disabled={disabled} onChange={e => change({ ...value, limitKB: Math.trunc(Number(e.target.value)) || 0 })} /></label>
      <label className="field">最近工作条数<input type="number" min={1} max={200} step={1} value={value.recentLimit} disabled={disabled} onChange={e => change({ ...value, recentLimit: Math.trunc(Number(e.target.value)) || 0 })} /></label>
    </div>
    <div className="memory-usage" role="group" aria-label="记忆用量">
      <div className="memory-usage-text"><span>已用 {kb(used)} / 预留 {kb(info?.limit || limit)}</span><span>手动记忆 {kb(manual)}</span></div>
      <div className="memory-meter" role="progressbar" aria-label="记忆用量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: percent + '%' }} /></div>
      <p className="settings-hint">预留默认 100 KB，可设 10–1024 KB。手动记忆优先保留，剩余空间依次用于项目索引与最近工作，超出时自动省略较早的记录。</p>
    </div>
    {info?.dir && <div className="memory-dir"><code title={info.dir}>{info.dir}</code><button type="button" className="btn sm" disabled={!bridge.openProjectDir || !files.length} onClick={async () => { const r = await bridge.openProjectDir!(info.dir); if (!r.ok) notify(r.error || '打开目录失败', 'err'); }}><FolderOpen size={14} />打开目录</button></div>}
    <h3 className="memory-heading">手动记忆</h3>
    <p className="settings-hint">点击预览框或「详情」查看完整内容，在弹窗顶部切换到「编辑」修改。「AI 填写」调用 AI 供应商结合各项目相关 Git 提交、约定文件与近期完成需求生成内容，发送与收到的信息显示在底部终端「AI 交互」，确认对比后写入草稿，保存设置后生效。</p>
    {sections.filter(s => !s.auto).map(s => <MemoryNoteField key={s.key} section={s} value={value} change={change} disabled={disabled} />)}
    <h3 className="memory-heading">自动生成</h3>
    <p className="settings-hint">以下内容随需求完成、项目变更自动更新，无需手动编辑。</p>
    {sections.filter(s => s.auto).map(s => {
      const file = files.find(f => f.key === s.key);
      return <details className="memory-preview" key={s.key}><summary>{s.title} · {s.file}{file ? ' · ' + kb(file.size) : ' · 未生成'}</summary><pre tabIndex={0}>{file?.content || (value.enabled ? '暂无内容' : '全局记忆已关闭')}</pre></details>;
    })}
    {info?.prompt && <details className="memory-preview"><summary>开发 Prompt 中附加的内容</summary><pre tabIndex={0}>{info.prompt}</pre></details>}
  </div>;
}

type MemorySection = MemoryInfo['sections'][number];
type FillState = { running: boolean; error: string; compare: { original: string; generated: string; note: string } | null };

/** 手动记忆单个条目（REQ-295）：Markdown 预览框 + 「详情」弹窗（预览 / 编辑页签）+ 「AI 填写」。
 *  AI 填写先取得发送内容并打印到底部终端「AI 交互」，再发送请求并打印收到的回复；生成结果先对比再应用到草稿。 */
function MemoryNoteField({ section, value, change, disabled }: { section: MemorySection; value: MemorySettings; change(v: MemorySettings): void; disabled: boolean }) {
  const [ai, setAi] = useState<FillState>({ running: false, error: '', compare: null });
  const [detail, setDetail] = useState<'preview' | 'edit' | null>(null);
  const text = value.notes[section.key] || '';
  const setText = (next: string) => change({ ...value, notes: { ...value.notes, [section.key]: next } });
  async function fill() {
    if (ai.running || disabled) return;
    if (!bridge.prepareMemoryFill || !bridge.fillMemory) { setAi({ running: false, error: 'AI 填写仅桌面版可用', compare: null }); return; }
    setAi({ running: true, error: '', compare: null });
    aiConsole.begin();
    aiConsole.log('info', 'AI 填写「' + section.title + '」：正在收集相关 Git 提交、项目文件与近期完成需求…');
    const started = Date.now();
    try {
      const others = Object.fromEntries(Object.entries(value.notes).filter(([k]) => k !== section.key));
      const prepared = await bridge.prepareMemoryFill(section.key, text, others);
      if (!prepared.ok || !prepared.payload) throw Error(prepared.error || '收集上下文失败');
      aiConsole.log('send', '系统提示', prepared.system);
      aiConsole.log('send', '上下文 · ' + (prepared.contextNote || section.title) + ' · ' + kb(byteLength(prepared.payload)), prepared.payload);
      aiConsole.log('info', '已发送，等待 AI 供应商响应…');
      const r = await bridge.fillMemory(section.key, prepared.payload);
      if (!r.ok || !r.text?.trim()) throw Error(r.error || 'AI 返回的内容为空');
      aiConsole.log('recv', 'AI 回复 · 用时 ' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒', r.raw || r.text);
      setAi({ running: false, error: '', compare: { original: text, generated: r.text, note: prepared.contextNote || '' } });
    } catch (e: any) {
      const message = e?.message || 'AI 填写失败';
      aiConsole.log('error', message);
      setAi({ running: false, error: message, compare: null });
    } finally {
      aiConsole.end();
    }
  }
  return <div className="field memory-note">
    <div className="memory-note-head">
      <span>{section.title} · <small>{section.file}</small></span>
      <span className="memory-note-actions"><small>{kb(byteLength(text))}</small>
        <button type="button" className="btn sm" onClick={() => setDetail('preview')} title={'查看' + section.title + '详情，可在顶部切换到编辑'}><Eye size={14} />详情</button>
        <button type="button" className="btn sm" disabled={disabled || ai.running} aria-busy={ai.running}
          title={'结合各项目相关 Git 提交、约定文件与近期完成需求，让 AI 填写' + section.title + '；交互内容显示在底部终端「AI 交互」'}
          onClick={() => void fill()}><Wand size={14} />{ai.running ? 'AI 填写中…' : 'AI 填写'}</button></span>
    </div>
    <button type="button" className={'memory-note-preview' + (text.trim() ? '' : ' empty')} aria-label={section.title + '：打开详情'} title="点击打开详情"
      onClick={() => setDetail(text.trim() || disabled ? 'preview' : 'edit')}>
      {text.trim() ? <div className="md-preview fb-md memory-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} /> : <span>{section.hint} 点击填写。</span>}
    </button>
    {ai.error && <p className="settings-message err" role="alert">{ai.error}</p>}
    {ai.compare && <div className="guidance-compare" role="group" aria-label={section.title + ' AI 填写结果'}>
      <div className="guidance-compare-head"><strong>AI 填写对比</strong>{ai.compare.note && <span title={ai.compare.note}>{ai.compare.note}</span>}</div>
      <label className="field">当前内容<textarea rows={5} readOnly value={ai.compare.original} placeholder="（空）" /></label>
      <label className="field">AI 生成 · 可编辑<textarea rows={8} value={ai.compare.generated}
        onChange={e => setAi(s => s.compare ? { ...s, compare: { ...s.compare, generated: e.target.value } } : s)} /></label>
      <div className="settings-actions">
        <button type="button" className="btn primary" disabled={disabled || !ai.compare.generated.trim()}
          onClick={() => { setText(ai.compare!.generated.trim()); setAi({ running: false, error: '', compare: null }); }}>应用到草稿</button>
        <button type="button" className="btn" onClick={() => setAi({ running: false, error: '', compare: null })}>放弃</button>
      </div>
    </div>}
    {detail && createPortal(<div className="overlay" role="dialog" aria-modal="true" aria-label={section.title + '详情'}
      onClick={e => { if (e.target === e.currentTarget) setDetail(null); }} onKeyDown={e => { if (e.key === 'Escape') setDetail(null); }}>
      <div className="dialog memory-detail">
        <div className="dialog-head">
          <div><h3>{section.title}</h3><p>{section.file} · {kb(byteLength(text))} · 修改写入草稿，保存设置后生效</p></div>
          <div className="memory-detail-tools">
            <div className="segmented" role="tablist" aria-label="查看方式">
              <button type="button" role="tab" aria-selected={detail === 'preview'} className={detail === 'preview' ? 'on' : ''} onClick={() => setDetail('preview')}><Eye size={14} />预览</button>
              <button type="button" role="tab" aria-selected={detail === 'edit'} className={detail === 'edit' ? 'on' : ''} disabled={disabled} onClick={() => setDetail('edit')}><Pencil size={13} />编辑</button>
            </div>
            <button type="button" className="icon-btn" aria-label="关闭详情" onClick={() => setDetail(null)}><X /></button>
          </div>
        </div>
        {detail === 'preview'
          ? <div className="md-preview fb-md memory-md memory-detail-body" tabIndex={0}>{text.trim() ? <div dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} /> : <p className="settings-hint">暂无内容，切换到「编辑」填写。</p>}</div>
          : <textarea className="memory-detail-body" aria-label={section.title + '内容'} autoFocus value={text} disabled={disabled} placeholder={section.hint} onChange={e => setText(e.target.value)} />}
        <div className="settings-actions"><button type="button" className="btn primary" onClick={() => setDetail(null)}>完成</button></div>
      </div>
    </div>, document.body)}
  </div>;
}
