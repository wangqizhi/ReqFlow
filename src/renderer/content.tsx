import { useEffect, useState } from 'react';
import type { ContextPrompt, Project } from '../core/domain';
import { Plus, Search, Trash, X } from './icons';

export function ContentWorkspace({ prompts, projects, busy, apply, notify }: {
  projects: Project[]; prompts: ContextPrompt[]; busy: boolean;
  apply(action: any): Promise<unknown>;
  notify(text: string, kind?: 'ok' | 'err'): void;
}) {
  const [query, setQuery] = useState(''), [tag, setTag] = useState('');
  const [form, setForm] = useState<{ id?: string; title: string; body: string; tags: string; projectId?: string; feature?: string } | null>(null);
  const [deleting, setDeleting] = useState<ContextPrompt | null>(null);
  const [saving, setSaving] = useState(false);
  const locked = busy || saving;
  const tags = [...new Set(prompts.flatMap(prompt => prompt.tags))].sort((a, b) => a.localeCompare(b));
  const visible = prompts.filter(prompt => (!tag || prompt.tags.includes(tag)) &&
    `${prompt.title}\n${prompt.body}\n${prompt.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { if (tag && !tags.includes(tag)) setTag(''); }, [prompts, tag]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !locked) { setForm(null); setDeleting(null); } };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [locked]);
  async function save(action: any) {
    if (locked) return;
    setSaving(true);
    try { if (await apply(action)) { setForm(null); setDeleting(null); } }
    finally { setSaving(false); }
  }
  return <section className="content-workspace">
    <div className="title-row"><div><div className="eyebrow">CONTENT WORKSPACE</div><h1>上下文 · 提示词</h1><p className="muted">保存常用提示词，用自定义标签分类，供各项目复用。</p></div>
      <button className="btn primary" disabled={locked} onClick={() => setForm({ title: '', body: '', tags: '' })}><Plus size={17} />新建提示词</button></div>
    <div className="content-toolbar"><div className="content-tags" role="group" aria-label="按标签筛选"><button className={'tag-btn' + (!tag ? ' on' : '')} aria-pressed={!tag} onClick={() => setTag('')}>全部 · {prompts.length}</button>{tags.map(value => <button key={value} className={'tag-btn' + (tag === value ? ' on' : '')} aria-pressed={tag === value} onClick={() => setTag(value)}>{value}</button>)}</div>
      <div className="search"><Search size={15} /><input aria-label="搜索提示词" placeholder="搜索标题、内容或标签" value={query} onChange={e => setQuery(e.target.value)} /></div></div>
    <div className="content-list">{visible.length ? visible.map(prompt => <article className="content-card" key={prompt.id}>
      <h2>{prompt.title}</h2><div className="content-tags">{prompt.tags.map(value => <button className="tag-btn" key={value} onClick={() => setTag(value)}>{value}</button>)}</div>
      <p className="content-body">{prompt.body}</p><div className="card-actions"><button className="btn" onClick={async () => { try { await navigator.clipboard.writeText(prompt.body); notify('提示词已复制'); } catch { notify('复制失败，请检查剪贴板权限', 'err'); } }}>复制</button><button className="btn" disabled={locked} onClick={() => setForm({ ...prompt, tags: prompt.tags.join('，') })}>编辑</button><button className="btn" disabled={locked} onClick={() => setDeleting(prompt)}><Trash size={14} />删除</button></div>
    </article>) : <p className="empty">{prompts.length ? '没有符合筛选条件的提示词。' : '还没有提示词，点击「新建提示词」开始记录。'}</p>}</div>
    {(form || deleting) && <div className="overlay" role="dialog" aria-modal="true" aria-label={form ? '编辑提示词' : '删除提示词'} onClick={e => { if (e.target === e.currentTarget && !locked) { setForm(null); setDeleting(null); } }}><div className="dialog content-dialog"><div className="dialog-head"><h3>{form ? form.id ? '编辑提示词' : '新建提示词' : '删除提示词'}</h3><button className="icon-btn" aria-label="关闭提示词窗口" disabled={locked} onClick={() => { setForm(null); setDeleting(null); }}><X size={18} /></button></div>
      {form ? <form onSubmit={e => { e.preventDefault(); void save({ op: 'contextPrompt', ...form, tags: form.tags.split(/[,，;；\n]/).map(value => value.trim()).filter(Boolean) }); }}>
        <label className="field">标题<input required autoFocus value={form.title} disabled={locked} onChange={e => setForm({ ...form, title: e.target.value })} /></label>
        <label className="field">提示词内容<textarea required rows={10} value={form.body} disabled={locked} onChange={e => setForm({ ...form, body: e.target.value })} /></label>
        <label className="field">关联项目<select value={form.projectId || ''} disabled={locked} onChange={e => setForm({ ...form, projectId: e.target.value })}><option value="">不关联项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {form.projectId && <label className="field">功能名称<input required value={form.feature || ''} disabled={locked} onChange={e => setForm({ ...form, feature: e.target.value })} /></label>}
        <label className="field">自定义标签<input value={form.tags} disabled={locked} placeholder="多个标签用逗号分隔，例如：开发，文案，审查" onChange={e => setForm({ ...form, tags: e.target.value })} /></label>
        <div className="settings-actions"><button type="button" className="btn" disabled={locked} onClick={() => setForm(null)}>取消</button><button className="btn primary" disabled={locked || !form.title.trim() || !form.body.trim()}>{saving ? '保存中…' : '保存提示词'}</button></div>
      </form> : <><p>确认删除「{deleting?.title}」？删除后无法恢复。</p><div className="settings-actions"><button className="btn" disabled={locked} onClick={() => setDeleting(null)}>取消</button><button className="btn danger" disabled={locked} onClick={() => void save({ op: 'deleteContextPrompt', id: deleting!.id })}>确认删除</button></div></>}
    </div></div>}
  </section>;
}
