import { useEffect, useState } from 'react';
import type { ContextPrompt, Project } from '../core/domain';
import { bridge } from './api';
import { renderMarkdown } from './markdown';
import { ExternalLink, FileText, GitBranch, Plus, Search, Trash, X } from './icons';

/** 功能上下文的编辑表单：正文 + 相关文件 + 相关代码摘录。 */
type ContextForm = { id?: string; title: string; body: string; tags: string; projectId?: string; feature?: string; code?: string; files?: string };

/** 复制到剪贴板的完整上下文（说明 + 相关文件 + 代码摘录）。 */
function contextText(prompt: ContextPrompt): string {
  const parts = [prompt.title, prompt.body];
  if (prompt.files?.length) parts.push('相关文件：\n' + prompt.files.map(file => `- ${file}`).join('\n'));
  if (prompt.code?.trim()) parts.push('相关代码：\n' + prompt.code.trim());
  return parts.filter(Boolean).join('\n\n');
}

export function ContentWorkspace({ prompts, projects, busy, apply, notify }: {
  projects: Project[]; prompts: ContextPrompt[]; busy: boolean;
  apply(action: any): Promise<unknown>;
  notify(text: string, kind?: 'ok' | 'err'): void;
}) {
  const [query, setQuery] = useState(''), [tag, setTag] = useState('');
  const [form, setForm] = useState<ContextForm | null>(null);
  const [deleting, setDeleting] = useState<ContextPrompt | null>(null);
  const [saving, setSaving] = useState(false);
  const [git, setGit] = useState<{ supported: boolean; available?: boolean; dir?: string } | null>(null);
  const locked = busy || saving;
  const tags = [...new Set(prompts.flatMap(prompt => prompt.tags))].sort((a, b) => a.localeCompare(b));
  const visible = prompts.filter(prompt => (!tag || prompt.tags.includes(tag)) &&
    `${prompt.title}\n${prompt.body}\n${prompt.tags.join(' ')}\n${(prompt.files || []).join(' ')}\n${prompt.code || ''}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { if (tag && !tags.includes(tag)) setTag(''); }, [prompts, tag]);
  useEffect(() => {
    let cancelled = false;
    if (!bridge.getContextSettings) { setGit({ supported: false }); return; }
    bridge.getContextSettings()
      .then(r => { if (!cancelled) setGit({ supported: true, available: !!r.git, dir: r.dir, }); })
      .catch(() => { if (!cancelled) setGit({ supported: true, available: false }); });
    return () => { cancelled = true; };
  }, [prompts.length]);
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
    <div className="title-row"><div><div className="eyebrow">CONTENT WORKSPACE</div><h1>上下文 · 提示词</h1><p className="muted">保存常用提示词与功能上下文，附带相关代码，供各项目复用。</p></div>
      <button className="btn primary" disabled={locked} onClick={() => setForm({ title: '', body: '', tags: '' })}><Plus size={17} />新建提示词</button></div>
    {!git && <div className="context-git-bar"><GitBranch size={16} /><div><strong>正在检测 Git 版本管理…</strong><span>检查上下文目录是否可用 Git 保存历史。</span></div></div>}
    {git?.available === false && <div className="context-git-bar off" role="status">
      <GitBranch size={16} />
      <div><strong>未检测到 Git，上下文暂不会自动提交版本</strong>
        <span>总结与原始代码文件仍会保存到上下文目录。安装 Git 后重启 ReqFlow，即可自动为每次更新提交历史；Windows 可运行 <code>winget install --id Git.Git -e</code>。</span></div>
      <button className="btn sm" disabled={!bridge.openExternal} onClick={() => void bridge.openExternal?.('https://git-scm.com/download/win')}><ExternalLink size={14} />Git 下载页</button>
    </div>}
    {git?.available === true && <div className="context-git-bar on"><GitBranch size={16} />
      <div><strong>上下文已启用 Git 版本管理</strong><span title={git.dir}>每次保存都会自动提交到 <code>{git.dir}</code></span></div>
    </div>}
    {git?.supported === false && <div className="context-git-bar"><GitBranch size={16} /><div><strong>浏览器预览不检测 Git</strong><span>桌面版会在上下文目录中自动初始化 Git 仓库并提交每次更新。</span></div></div>}
    <div className="content-toolbar"><div className="content-tags" role="group" aria-label="按标签筛选"><button className={'tag-btn' + (!tag ? ' on' : '')} aria-pressed={!tag} onClick={() => setTag('')}>全部 · {prompts.length}</button>{tags.map(value => <button key={value} className={'tag-btn' + (tag === value ? ' on' : '')} aria-pressed={tag === value} onClick={() => setTag(value)}>{value}</button>)}</div>
      <div className="search"><Search size={15} /><input aria-label="搜索提示词" placeholder="搜索标题、内容或代码" value={query} onChange={e => setQuery(e.target.value)} /></div></div>
    <div className="content-list">{visible.length ? visible.map(prompt => <article className="content-card" key={prompt.id}>
      <h2>{prompt.title}</h2>
      <div className="content-tags">{prompt.projectId && prompt.feature && <span className="content-link">{projects.find(p => p.id === prompt.projectId)?.name || '已删除项目'} · {prompt.feature}</span>}{prompt.tags.map(value => <button className="tag-btn" key={value} onClick={() => setTag(value)}>{value}</button>)}</div>
      <div className="content-body md-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(prompt.body) }} />
      {!!prompt.files?.length && <p className="content-files" title={prompt.files.join('\n')}><FileText size={14} />{[...prompt.files].join(' · ')}</p>}
      {!!prompt.code?.trim() && <details className="content-code"><summary>相关代码 · {prompt.files?.length || 1} 处<ExternalLink size={13} /></summary><div className="md-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(prompt.code.trim()) }} /></details>}
      <div className="card-actions">{git?.dir && <button className="btn" disabled={!bridge.openProjectDir} onClick={async () => { try { const r = await bridge.openProjectDir!(git.dir + "/" + prompt.id); if (!r.ok) throw Error(r.error || "打开目录失败"); } catch (e: any) { notify(e.message, "err"); } }}><FileText size={14} />打开上下文目录</button>}<button className="btn" onClick={async () => { try { await navigator.clipboard.writeText(contextText(prompt)); notify('提示词已复制'); } catch { notify('复制失败，请检查剪贴板权限', 'err'); } }}>复制</button><button className="btn" disabled={locked} onClick={() => setForm({ ...prompt, tags: prompt.tags.join('，'), files: (prompt.files || []).join('，'), code: prompt.code || '' })}>编辑</button><button className="btn" disabled={locked} onClick={() => setDeleting(prompt)}><Trash size={14} />删除</button></div>
    </article>) : <p className="empty">{prompts.length ? '没有符合筛选条件的提示词。' : '还没有提示词，点击「新建提示词」开始记录。'}</p>}</div>
    {(form || deleting) && <div className="overlay" role="dialog" aria-modal="true" aria-label={form ? '编辑提示词' : '删除提示词'} onClick={e => { if (e.target === e.currentTarget && !locked) { setForm(null); setDeleting(null); } }}><div className="dialog content-dialog"><div className="dialog-head"><h3>{form ? form.id ? '编辑提示词' : '新建提示词' : '删除提示词'}</h3><button className="icon-btn" aria-label="关闭提示词窗口" disabled={locked} onClick={() => { setForm(null); setDeleting(null); }}><X size={18} /></button></div>
      {form ? <form onSubmit={e => { e.preventDefault(); void save({ op: 'contextPrompt', ...form, files: form.files?.split(/[,，;；\n]/).map(value => value.trim()).filter(Boolean) || [], tags: form.tags.split(/[,，;；\n]/).map(value => value.trim()).filter(Boolean) }); }}>
        <label className="field">标题<input required autoFocus value={form.title} disabled={locked} onChange={e => setForm({ ...form, title: e.target.value })} /></label>
        <label className="field">上下文内容<textarea required rows={8} value={form.body} disabled={locked} onChange={e => setForm({ ...form, body: e.target.value })} placeholder="这段功能是什么、如何实现、与相邻模块的边界与约束" /></label>
        <label className="field">相关文件 · 每行或逗号分隔<input value={form.files || ''} disabled={locked} placeholder="src/renderer/App.tsx, src/core/domain.ts" onChange={e => setForm({ ...form, files: e.target.value })} /></label>
        <label className="field">补充说明 · 兼容旧代码摘录<textarea rows={6} value={form.code || ''} disabled={locked} onChange={e => setForm({ ...form, code: e.target.value })} placeholder={'### src/core/domain.ts\n```ts\n关键代码片段\n```'} /></label>
        <label className="field">关联项目<select value={form.projectId || ''} disabled={locked} onChange={e => setForm({ ...form, projectId: e.target.value })}><option value="">不关联项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {form.projectId && <label className="field">功能名称<input required value={form.feature || ''} disabled={locked} onChange={e => setForm({ ...form, feature: e.target.value })} /></label>}
        <label className="field">自定义标签<input value={form.tags} disabled={locked} placeholder="多个标签用逗号分隔，例如：开发，文案，审查" onChange={e => setForm({ ...form, tags: e.target.value })} /></label>
        <p className="settings-hint">每条上下文保存在独立的 ID 文件夹中：<code>summary.md</code> 为总结，<code>files/</code> 保存关联项目内的原始代码文件；检测到 Git 时自动提交。</p>
        <div className="settings-actions"><button type="button" className="btn" disabled={locked} onClick={() => setForm(null)}>取消</button><button className="btn primary" disabled={locked || !form.title.trim() || !form.body.trim()}>{saving ? '保存中…' : '保存提示词'}</button></div>
      </form> : <><p>确认删除「{deleting?.title}」？删除后无法恢复，原始代码副本也会从上下文目录移除，Git 历史保留。</p><div className="settings-actions"><button className="btn" disabled={locked} onClick={() => setDeleting(null)}>取消</button><button className="btn danger" disabled={locked} onClick={() => void save({ op: 'deleteContextPrompt', id: deleting!.id })}>确认删除</button></div></>}
    </div></div>}
  </section>;
}
