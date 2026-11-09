import { useEffect, useRef, useState } from 'react';
import type { AIDraft } from '../core/ai';
import type { Project } from '../core/domain';
import { bridge } from './api';
import { ImageIcon, X } from './icons';
import { renderMarkdown } from './markdown';

type Image = { name: string; size: number; url: string };
type Message = { role: 'user' | 'assistant'; content: string; images?: Image[] };
type Draft = { item: AIDraft & { id: string }; selected: boolean };
const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const kinds = [['feature', '新需求'], ['improvement', '优化'], ['bug', '修复']];

function ChatMessage({ message }: { message: Message }) {
  const [source, setSource] = useState(false);
  return <article className={`ai-discussion ${message.role}`}>
    <div className="ai-discussion-head">
      <strong>{message.role === 'user' ? '你' : 'AI'}</strong>
      {message.content && <button type="button" className="btn sm" onClick={() => setSource(!source)}>{source ? '显示预览' : '查看原文'}</button>}
    </div>
    {message.content && (source
      ? <pre className="ai-discussion-source">{message.content}</pre>
      : <div className="fb-md ai-discussion-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
        onClick={e => {
          const link = (e.target as HTMLElement).closest('a');
          if (!link || !bridge.openExternal) return;
          e.preventDefault();
          void bridge.openExternal(link.href);
        }} />)}
    {!!message.images?.length && <div className="ai-chat-images">{message.images.map((image, n) => <img key={n} src={image.url} alt={image.name} title={image.name} />)}</div>}
  </article>;
}

export function AIRequirements({ project, onClose, insert }: { project: Project; onClose(): void; insert(items: AIDraft[]): Promise<boolean> }) {
  const [input, setInput] = useState('');
  const [images, setImages] = useState<Image[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [action, setAction] = useState<'images' | 'send' | 'save'>();
  const [error, setError] = useState('');
  const [context, setContext] = useState('对话使用项目背景与守则、最近需求、近 7 天 Git 记录和项目说明文件。');
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const locked = useRef(false);
  const selected = drafts.filter(draft => draft.selected).map(draft => draft.item);
  const sending = action === 'send';
  const conversation: Message[] = sending ? [...messages, { role: 'user', content: input.trim(), images }] : messages;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !locked.current) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
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
      const recent = messages.slice(-16);
      const previousImages = recent.findLast(message => message.images?.length)?.images;
      const attached = images.length ? images : previousImages;
      const discussion = recent.map(({ role, content, images: pictures }) => ({
        role, content: pictures?.length ? `${content}\n（此消息附有 ${pictures.length} 张图片）` : content,
      }));
      const result = await bridge.aiRequirements!(project.id, 'chat', input.trim(), discussion,
        attached?.map(image => image.url) || [], images.length ? 'current' : 'previous', drafts.map(draft => draft.item));
      if (!result?.ok) throw Error(result?.error || 'AI 需求仅桌面版可用');
      setMessages([...messages, { role: 'user', content: input.trim(), images }, { role: 'assistant', content: result.reply || '' }]);
      if (result.items) {
        const existing = new Map(drafts.map(draft => [draft.item.id, draft]));
        setDrafts(result.items.map(item => {
          const previous = existing.get(item.id || '');
          if (previous) existing.delete(previous.item.id);
          return { item: { ...item, id: previous?.item.id || crypto.randomUUID() }, selected: previous?.selected ?? true };
        }));
      }
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
      <div><h3 id="ai-requirements-title">AI 需求 · {project.name}</h3><p>讨论项目需求，勾选候选后提交到需求池。</p></div>
      <button className="icon-btn" aria-label="关闭 AI 需求" disabled={!!action} onClick={onClose}><X /></button>
    </div>
    <div className="ai-requirements-body">
      <section className="ai-chat" aria-label="需求对话">
        <div className="ai-chat-history" ref={history} role="log" aria-label="对话记录" tabIndex={0}>
          <p className="settings-hint">{context}</p>
          {!conversation.length && <p className="ai-chat-intro">告诉 AI 你想解决的问题，也可以请它根据项目现状提出建议。</p>}
          {conversation.map((message, index) => <ChatMessage key={index} message={message} />)}
          {sending && <p className="settings-hint" role="status">AI 正在回复…</p>}
        </div>
        <form className="ai-chat-compose" onSubmit={e => { e.preventDefault(); void send(); }}>
          <label className="field">消息
            <textarea ref={composer} autoFocus rows={3} maxLength={20000} readOnly={!!action} value={input} placeholder="输入想法、问题或修改意见"
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
          <p className="settings-hint">支持粘贴 PNG、JPEG、WebP、GIF，每条最多 4 张、合计 5 MB。续聊时引用最近一组图片。</p>
        </form>
      </section>
      <section className="ai-drafts" aria-label="候选需求">
        <div className="ai-drafts-head"><h4>候选需求</h4><span className="muted">已勾选 {selected.length} / {drafts.length} 条</span></div>
        <div className="ai-draft-list" tabIndex={0}>
          {!drafts.length && <p className="settings-hint">生成的需求会出现在这里，可编辑或取消勾选。</p>}
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
