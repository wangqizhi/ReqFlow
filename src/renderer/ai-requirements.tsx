import { useState } from 'react';
import type { AIDraft } from '../core/ai';
import type { Project } from '../core/domain';
import { bridge } from './api';
import { X, Trash } from './icons';

export function AIRequirements({ project, onClose, insert }: { project: Project; onClose(): void; insert(items: AIDraft[]): Promise<boolean> }) {
  const [mode, setMode] = useState('organize');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [items, setItems] = useState<AIDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [context, setContext] = useState('本次请求将使用项目背景、最近 40 条需求、近 7 天 Git Log 与项目说明文件。');
  async function generate() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const discussion = messages.slice(-16);
      if (items.length) discussion.push({ role: 'assistant', content: JSON.stringify({ currentDrafts: items }) });
      const r = await bridge.aiRequirements?.(project.id, mode, input, discussion);
      if (!r?.ok) throw Error(r?.error || 'AI 需求仅桌面版可用');
      setMessages([...messages, { role: 'user', content: input || '请给出新需求建议' }, { role: 'assistant', content: r.reply || '' }].slice(-16));
      setItems(r.items || []); setInput('');
      setContext(`${r.contextNote}；最近需求 ${r.requirementCount} 条；文件：${r.contextFiles?.join('、') || '无'}`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  function update(n: number, patch: Partial<AIDraft>) { setItems(items.map((i, k) => k === n ? { ...i, ...patch } : i)); }
  return <div className="overlay"><div className="dialog ai-requirements-dialog" role="dialog" aria-modal="true" aria-label="AI 需求">
    <div className="dialog-head"><div><h3>AI 需求 · {project.name}</h3><p>整理想法，讨论建议，确认后加入待执行</p></div><button className="icon-btn" aria-label="关闭 AI 需求" disabled={busy} onClick={onClose}><X /></button></div>
    <div className="ai-requirements-body">
      <div className="segmented" role="group" aria-label="AI 需求方式">{[['organize', '整理需求'], ['suggest', '建议与讨论']].map(([id, label]) => <button key={id} aria-pressed={mode === id} className={mode === id ? 'on' : ''} disabled={busy} onClick={() => { setMode(id); setItems([]); setMessages([]); setError(''); }}>{label}</button>)}</div>
      <p className="settings-hint">{context}</p>
      {messages.map((m, n) => <p className="ai-discussion" key={n}><strong>{m.role === 'user' ? '你：' : 'AI：'}</strong>{m.content}</p>)}
      <label className="field">{mode === 'organize' ? '填写整段需求或继续补充' : '讨论方向或修改意见（首次可留空）'}<textarea rows={3} value={input} disabled={busy} onChange={(e) => setInput(e.target.value)} /></label>
      <button className="btn" disabled={busy || (mode === 'organize' && !input.trim()) || !bridge.aiRequirements} onClick={generate}>{busy ? 'AI 正在处理…' : messages.length ? '继续讨论并修订' : mode === 'organize' ? '整理成需求列表' : '获取新需求建议'}</button>
      {error && <p className="error" role="alert">{error}</p>}
      {items.map((i, n) => <article className="ai-draft" key={n}><div className="ai-draft-head"><strong>候选需求 {n + 1}</strong><button className="icon-btn" aria-label={`删除候选需求 ${n + 1}`} disabled={busy} onClick={() => setItems(items.filter((_, k) => k !== n))}><Trash /></button></div>
        <label className="field">标题<input value={i.title} disabled={busy} onChange={(e) => update(n, { title: e.target.value })} /></label>
        <label className="field">说明<textarea rows={3} value={i.body} disabled={busy} onChange={(e) => update(n, { body: e.target.value })} /></label>
        <div className="ai-draft-options">{[['feature', '新需求'], ['improvement', '优化'], ['bug', '修复']].map(([v, label]) => <button className={'btn sm' + (i.type === v ? ' primary' : '')} aria-pressed={i.type === v} disabled={busy} key={v} onClick={() => update(n, { type: v })}>{label}</button>)}{['P0', 'P1', 'P2'].map((v) => <button className={'btn sm' + (i.priority === v ? ' primary' : '')} aria-pressed={i.priority === v} disabled={busy} key={v} onClick={() => update(n, { priority: v })}>{v}</button>)}</div>
        <label className="field">验收条件<textarea rows={2} value={i.criteria.join('\n')} disabled={busy} onChange={(e) => update(n, { criteria: e.target.value.split('\n') })} /></label>
      </article>)}
    </div>
    <div className="dialog-foot"><button className="btn" disabled={busy} onClick={onClose}>关闭</button><button className="btn primary" disabled={busy || !items.length || items.some((i) => !i.body.trim())} onClick={async () => { setBusy(true); try { if (await insert(items)) onClose(); } finally { setBusy(false); } }}>确认加入待执行 · {items.length} 条</button></div>
  </div></div>;
}
