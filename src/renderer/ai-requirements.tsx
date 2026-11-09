import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AIDraft } from '../core/ai';
import type { Project } from '../core/domain';
import { bridge, type AIRequirementToolCall } from './api';
import { ChevronDown, FileText, ImageIcon, RefreshCw, Terminal, Wand, X } from './icons';
import { renderMarkdown } from './markdown';

type Image = { name: string; size: number; url: string };
type DraftChange = { action: '新增' | '修改'; item: AIDraft };
type Message = { role: 'user' | 'assistant'; content: string; images?: Image[]; reasoning?: string; toolCalls?: AIRequirementToolCall[]; changes?: DraftChange[] };
type Draft = { item: AIDraft & { id: string }; selected: boolean };
const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const kinds = [['feature', '新需求'], ['improvement', '优化'], ['bug', '修复']];
const toolActions = { create: '新增候选', update: '修改候选', list: '查看候选' };

function reconcileDrafts(previous: Draft[], items: (AIDraft & { id?: string })[]) {
  const existing = new Map(previous.map(draft => [draft.item.id, draft]));
  const changes: DraftChange[] = [];
  const drafts = items.map(item => {
    const draft = existing.get(item.id || '');
    if (draft) {
      existing.delete(draft.item.id);
      const before = draft.item;
      if (before.title !== item.title || before.body !== item.body || before.type !== item.type ||
          before.priority !== item.priority || JSON.stringify(before.criteria) !== JSON.stringify(item.criteria)) {
        changes.push({ action: '修改', item });
      }
    } else {
      changes.push({ action: '新增', item });
    }
    return { item: { ...item, id: draft?.item.id || crypto.randomUUID() }, selected: draft?.selected ?? true };
  });
  return { drafts: [...drafts, ...existing.values()], changes };
}

function ChatMessage({ message }: { message: Message }) {
  const [source, setSource] = useState(false);
  if (message.role === 'user') return <article className="ai-discussion user" aria-label="你的消息">
    {message.content && <div className="ai-discussion-plain">{message.content}</div>}
    {!!message.images?.length && <div className="ai-chat-images">{message.images.map((image, n) => <img key={n} src={image.url} alt={image.name} title={image.name} />)}</div>}
  </article>;
  return <article className={`ai-discussion ${message.role}`}>
    <div className="ai-discussion-head">
      <strong><Wand size={16} />需求助手</strong>
      {message.content && <button type="button" className="btn sm" onClick={() => setSource(!source)}>{source ? '显示预览' : '查看原文'}</button>}
    </div>
    {message.reasoning && <details className="ai-chat-trace">
      <summary><ChevronDown /><span>思考过程</span></summary>
      <div className="ai-discussion-plain">{message.reasoning}</div>
    </details>}
    {message.toolCalls?.map(({ name, operations }, index) => <details key={index} className="ai-chat-trace">
      <summary><Terminal /><span>工具调用</span><span className="muted">{operations.map(operation => toolActions[operation]).join(' · ')}</span></summary>
      <code>{name}</code>
    </details>)}
    {message.content && (source
      ? <pre className="ai-discussion-source">{message.content}</pre>
      : <div className="fb-md ai-discussion-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
        onClick={e => {
          const link = (e.target as HTMLElement).closest('a');
          if (!link || !bridge.openExternal) return;
          e.preventDefault();
          void bridge.openExternal(link.href);
        }} />)}
    {!!message.changes?.length && <div className="ai-chat-changes" aria-label="候选需求变更">
      <strong>候选需求已同步 · {message.changes.length} 条</strong>
      {message.changes.map(({ action, item }, index) => <details key={index}>
        <summary><span>{action}</span> {item.title || '未命名候选需求'}</summary>
        <p>{kinds.find(([kind]) => kind === item.type)?.[1]} · {item.priority}</p>
        <p>{item.body}</p>
        {item.criteria.some(Boolean) && <ul>{item.criteria.filter(Boolean).map((criterion, n) => <li key={n}>{criterion}</li>)}</ul>}
      </details>)}
    </div>}
  </article>;
}

export function AIRequirements({ project, onClose, insert }: { project: Project; onClose(): void; insert(items: AIDraft[]): Promise<boolean> }) {
  const [input, setInput] = useState('');
  const [images, setImages] = useState<Image[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [action, setAction] = useState<'images' | 'send' | 'save'>();
  const [error, setError] = useState('');
  const [away, setAway] = useState(false);
  const [context, setContext] = useState('对话使用项目背景与守则、最近需求、近 7 天 Git 记录和项目说明文件。');
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const followHistory = useRef(true);
  const locked = useRef(false);
  const selected = drafts.filter(draft => draft.selected).map(draft => draft.item);
  const sending = action === 'send';
  const conversation: Message[] = sending ? [...messages, { role: 'user', content: input.trim(), images }] : messages;

  function scrollToLatest() {
    followHistory.current = true;
    setAway(false);
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !locked.current) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useLayoutEffect(() => {
    if (history.current && followHistory.current) history.current.scrollTop = history.current.scrollHeight;
  }, [messages, sending]);

  async function run(next: NonNullable<typeof action>, work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setAction(next);
    setError('');
    try { await work(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally {
      locked.current = false;
      setAction(undefined);
    }
  }

  function addImages(files: File[]) {
    if (!files.length) return;
    void run('images', async () => {
      if (images.length + files.length > 4) throw Error('每条消息最多插入 4 张图片');
      if (files.some(file => !imageTypes.includes(file.type) || !file.size)) throw Error('请选择有效的 PNG、JPEG、WebP 或 GIF 图片');
      if ([...images, ...files].reduce((size, file) => size + file.size, 0) > 5 * 1024 * 1024) throw Error('每条消息的图片总大小不能超过 5 MB');
      const added = await Promise.all(files.map(file => new Promise<Image>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, size: file.size, url: String(reader.result) });
        reader.onerror = () => reject(Error('读取图片失败，请重新选择'));
        reader.readAsDataURL(file);
      })));
      setImages([...images, ...added]);
    });
  }

  async function send() {
    if (!bridge.aiRequirements || (!input.trim() && !images.length)) return;
    await run('send', async () => {
      scrollToLatest();
      const recent = messages.slice(-16);
      const previousImages = recent.findLast(message => message.images?.length)?.images;
      const attached = images.length ? images : previousImages;
      const discussion = recent.map(({ role, content, images: pictures }) => ({
        role, content: pictures?.length ? `${content}\n（此消息附有 ${pictures.length} 张图片）` : content,
      }));
      const result = await bridge.aiRequirements!(project.id, 'chat', input.trim(), discussion,
        attached?.map(image => image.url) || [], images.length ? 'current' : 'previous', drafts.map(draft => draft.item));
      if (!result?.ok) throw Error(result?.error || 'AI 需求仅桌面版可用');
      const revision = result.items ? reconcileDrafts(drafts, result.items) : undefined;
      if (revision) setDrafts(revision.drafts);
      setMessages([...messages, { role: 'user', content: input.trim(), images },
        { role: 'assistant', content: result.reply || '', reasoning: result.reasoning, toolCalls: result.toolCalls, changes: revision?.changes }]);
      setInput('');
      setImages([]);
      setContext(`${result.contextNote} · 最近需求 ${result.requirementCount} 条 · 项目文件 ${result.contextFiles?.join('、') || '无'}`);
    });
    composer.current?.focus();
  }

  function update(id: string, patch: Partial<AIDraft>) {
    setDrafts(previous => previous.map(draft => draft.item.id === id ? { ...draft, item: { ...draft.item, ...patch } } : draft));
  }

  return <div className="overlay"><div className="dialog ai-requirements-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-requirements-title">
    <div className="dialog-head">
      <div><h3 id="ai-requirements-title">AI 需求 · {project.name}</h3><p>和 AI 讨论需求，生成或修改候选后勾选提交。</p></div>
      <button className="icon-btn" aria-label="关闭 AI 需求" disabled={!!action} onClick={onClose}><X /></button>
    </div>
    <div className="ai-requirements-body">
      <section className="ai-chat" aria-label="需求对话">
        <div className="ai-chat-head"><h4><Wand />需求讨论</h4><details className="ai-chat-context"><summary>项目上下文</summary><p>{context}</p></details></div>
        <div className="ai-chat-history" ref={history} role="log" aria-label="对话记录" tabIndex={0}
          onScroll={e => {
            const list = e.currentTarget;
            followHistory.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
            setAway(!followHistory.current);
          }}>
          {!conversation.length && <div className="ai-chat-intro"><span><Wand size={20} /></span><strong>从一个想法开始</strong><p>描述问题或请 AI 根据项目现状提出建议。讨论形成的需求会出现在右侧。</p></div>}
          {conversation.map((message, index) => <ChatMessage key={index} message={message} />)}
          {sending && <p className="ai-chat-waiting" role="status"><RefreshCw size={16} />正在处理这轮讨论…</p>}
        </div>
        {away && <button type="button" className="btn sm ai-chat-latest" onClick={scrollToLatest}><ChevronDown />回到最新</button>}
        <form className="ai-chat-compose" onSubmit={e => { e.preventDefault(); void send(); }}>
          <label className="field"><span className="visually-hidden">消息</span>
            <textarea ref={composer} autoFocus rows={2} maxLength={20000} readOnly={!!action} value={input} placeholder="输入想法、问题或修改意见"
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault(); void send();
                }
              }}
              onPaste={e => {
                const files = Array.from(e.clipboardData.files).filter(file => file.type.startsWith('image/'));
                if (files.length) { e.preventDefault(); addImages(files); }
              }} />
          </label>
          {!!images.length && <div className="ai-chat-images">{images.map((image, index) => <div key={index}>
            <img src={image.url} alt={image.name} title={image.name} />
            <button type="button" className="icon-btn" aria-label={`移除图片 ${index + 1}`} disabled={!!action} onClick={() => setImages(images.filter((_, n) => n !== index))}><X size={14} /></button>
          </div>)}</div>}
          <div className="ai-chat-actions">
            <input className="visually-hidden" ref={fileInput} tabIndex={-1} type="file" accept={imageTypes.join(',')} multiple disabled={!!action} onChange={e => { addImages(Array.from(e.target.files || [])); e.target.value = ''; }} />
            <button type="button" className="btn" disabled={!!action} onClick={() => fileInput.current?.click()}><ImageIcon />{action === 'images' ? '读取中…' : '插入图片'}</button>
            <button className="btn primary" disabled={!!action || (!input.trim() && !images.length) || !bridge.aiRequirements}>{action === 'send' ? '发送中…' : '发送'}</button>
          </div>
          <p className="settings-hint">Enter 发送 · Shift+Enter 换行 · 可粘贴图片，每条最多 4 张、合计 5 MB</p>
        </form>
      </section>
      <section className="ai-drafts" aria-label="候选需求">
        <div className="ai-drafts-head"><h4><FileText />候选需求</h4><span className="muted">已勾选 {selected.length} / {drafts.length} 条</span></div>
        <div className="ai-draft-list" tabIndex={0}>
          {!drafts.length && <div className="ai-chat-intro"><span><FileText size={20} /></span><strong>暂无候选需求</strong><p>候选会随对话更新。你可以在这里查看、编辑和勾选。</p></div>}
          {drafts.map(({ item, selected }, index) => <article className="ai-draft" key={item.id}>
            <label className="ai-draft-select">
              <input type="checkbox" checked={selected} disabled={!!action} onChange={e => {
                const checked = e.target.checked;
                setDrafts(previous => previous.map(draft => draft.item.id === item.id ? { ...draft, selected: checked } : draft));
              }} />
              <strong>{item.title || `候选需求 ${index + 1}`}</strong>
            </label>
            <p>{kinds.find(([kind]) => kind === item.type)?.[1]} · {item.priority}</p>
            <details><summary>查看和编辑</summary>
              <label className="field">标题<input value={item.title} readOnly={!!action} onChange={e => update(item.id, { title: e.target.value })} /></label>
              <label className="field">说明<textarea rows={3} value={item.body} readOnly={!!action} onChange={e => update(item.id, { body: e.target.value })} /></label>
              <div className="ai-draft-options">
                <div className="segmented" role="group" aria-label="需求类型">{kinds.map(([value, label]) => <button className={item.type === value ? 'on' : ''} aria-pressed={item.type === value} disabled={!!action} key={value} onClick={() => update(item.id, { type: value })}>{label}</button>)}</div>
                <div className="segmented" role="group" aria-label="优先级">{['P0', 'P1', 'P2'].map(value => <button className={item.priority === value ? 'on' : ''} aria-pressed={item.priority === value} disabled={!!action} key={value} onClick={() => update(item.id, { priority: value })}>{value}</button>)}</div>
              </div>
              <label className="field">验收条件<textarea rows={2} value={item.criteria.join('\n')} readOnly={!!action} onChange={e => update(item.id, { criteria: e.target.value.split('\n') })} /></label>
            </details>
          </article>)}
        </div>
      </section>
    </div>
    {error && <p className="error ai-chat-error" role="alert">{error}</p>}
    <div className="dialog-foot">
      <button className="btn" disabled={!!action} onClick={onClose}>关闭</button>
      <button className="btn primary" disabled={!!action || !selected.length || selected.some(item => !item.body.trim())} onClick={() => void run('save', async () => {
        if (!await insert(selected)) throw Error('提交失败，候选需求已保留，请重试。');
        onClose();
      })}>{action === 'save' ? '提交中…' : `提交到需求池 · ${selected.length} 条`}</button>
    </div>
  </div></div>;
}
