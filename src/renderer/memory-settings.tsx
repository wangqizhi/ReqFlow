import { bridge, type MemoryInfo, type MemorySettings } from './api';
import { FolderOpen } from './icons';

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
    {sections.filter(s => !s.auto).map(s => {
      const text = value.notes[s.key] || '';
      return <label className="field memory-note" key={s.key}><span className="memory-note-head"><span>{s.title} · <small>{s.file}</small></span><small>{kb(byteLength(text))}</small></span>
        <textarea rows={5} value={text} disabled={disabled} placeholder={s.hint} onChange={e => change({ ...value, notes: { ...value.notes, [s.key]: e.target.value } })} /></label>;
    })}
    <h3 className="memory-heading">自动生成</h3>
    <p className="settings-hint">以下内容随需求完成、项目变更自动更新，无需手动编辑。</p>
    {sections.filter(s => s.auto).map(s => {
      const file = files.find(f => f.key === s.key);
      return <details className="memory-preview" key={s.key}><summary>{s.title} · {s.file}{file ? ' · ' + kb(file.size) : ' · 未生成'}</summary><pre tabIndex={0}>{file?.content || (value.enabled ? '暂无内容' : '全局记忆已关闭')}</pre></details>;
    })}
    {info?.prompt && <details className="memory-preview"><summary>开发 Prompt 中附加的内容</summary><pre tabIndex={0}>{info.prompt}</pre></details>}
  </div>;
}
