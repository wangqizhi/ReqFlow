import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { defaultChatContextTokens, type AIDraft } from '../core/ai';
import { chatModelLabel, chatSources, type ChatCandidate as Draft, type ChatHistoryEntry, type ChatImage as Image, type ChatMessage as Message, type ChatSource, type ChatSourceCounts } from '../core/ai-chat';
import type { Project } from '../core/domain';
import { bridge } from './api';
import { useAIChatSession } from './ai-chat-session';
import { ChevronDown, FileText, History, ImageIcon, RefreshCw, Terminal, Trash, Wand, X } from './icons';
import { renderMarkdown } from './markdown';

const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const kinds = [['feature', '新需求'], ['improvement', '优化'], ['bug', '修复']];
const toolActions = { create: '新增候选', update: '修改候选', list: '查看候选' };
const contextRefreshMs = 25 * 60 * 1000;

function reconcileDrafts(previous: Draft[], items: (AIDraft & { id?: string })[]) {
  const existing = new Map(previous.map(draft => [draft.item.id, draft]));
  const changes: NonNullable<Message['changes']> = [];
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
    {message.interrupted && <p className="settings-hint">此消息未收到回复</p>}
    {message.content && <div className="ai-discussion-plain">{message.content}</div>}
    {!!message.images?.length && <div className="ai-chat-images">{message.images.map((image, n) => <img key={n} src={image.url} alt={image.name} title={image.name} />)}</div>}
  </article>;
  return <article className={`ai-discussion ${message.role}`}>
    <div className="ai-discussion-head">
      <strong><Wand size={16} />需求助手</strong>
      {message.model && <span className="ai-chat-model" title={`模型供应商：${message.model.provider || '未命名'}${message.model.host ? `（${message.model.host}）` : ''}\n模型：${message.model.model}`}>{chatModelLabel(message.model)}</span>}
      {message.content && <button type="button" className="btn sm" onClick={() => setSource(!source)}>{source ? '显示预览' : '查看原文'}</button>}
    </div>
    {message.sourceCounts && <p className="ai-chat-sources-used">来源 · {chatSources.filter(([key]) => (message.sourceCounts?.[key] || 0) > 0)
      .map(([key, label]) => `${label} ${message.sourceCounts?.[key]}`).join(' · ') || '无额外项目上下文'}</p>}
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

function ChatHistory({ project }: { project: string }) {
  const [entries, setEntries] = useState<ChatHistoryEntry[]>([]);
  const [active, setActive] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await bridge.listAIChatHistory?.(project);
        if (!result?.ok) throw Error(result?.error || '本地历史记录不可用');
        if (alive) setEntries(result.entries || []);
      } catch (e) { if (alive) setError(`无法读取聊天历史：${(e as Error).message}`); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [project]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    setLoading(true);
    setMessages([]);
    setError('');
    void (async () => {
      try {
        const result = await bridge.readAIChatHistory?.(project, active);
        if (!result?.ok) throw Error(result?.error || '本地历史记录不可用');
        if (alive) setMessages(result.messages || []);
      } catch (e) { if (alive) setError(`无法读取这段对话：${(e as Error).message}`); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [project, active]);
  return <div className="ai-requirements-body ai-chat-history-mode">
    <section className="ai-drafts" aria-label="历史会话">
      <div className="ai-drafts-head"><h4><History />历史会话</h4></div>
      <div className="ai-draft-list">
        {!loading && !entries.length && <p className="settings-hint">此项目暂无聊天历史。</p>}
        {entries.map(entry => <button type="button" key={entry.id} className="btn ai-chat-history-entry" aria-pressed={active === entry.id} onClick={() => setActive(entry.id)}>
          <strong>{entry.title || '图片讨论'}</strong><small>{new Date(entry.time).toLocaleString()}</small>
        </button>)}
      </div>
    </section>
    <section className="ai-chat" aria-label="历史消息">
      <div className="ai-chat-head"><h4><FileText />历史消息</h4><span className="muted">只读</span></div>
      <div className="ai-chat-history" role="log" tabIndex={0}>
        {error ? <p className="error" role="alert">{error}</p> : loading ? <p role="status">正在读取聊天历史…</p> : !active && <p className="settings-hint">选择一段会话查看消息。</p>}
        {messages.map((message, index) => <div key={index}>{message.time && <p className="ai-chat-time"><time dateTime={message.time}>{new Date(message.time).toLocaleString()}</time></p>}<ChatMessage message={message} /></div>)}
      </div>
    </section>
  </div>;
}

export function AIRequirements({ project, onClose, insert }: { project: Project; onClose(): void; insert(items: AIDraft[]): Promise<boolean> }) {
  const { draft, sources, setSources, ready, warning, edit, persist, flush } = useAIChatSession(project.id);
  const { input, images, messages, drafts, outgoing, queued } = draft;
  const [action, setAction] = useState<'send' | 'save' | 'delete' | 'discard' | 'sources'>();
  const [readingImages, setReadingImages] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  const [away, setAway] = useState(false);
  const [context, setContext] = useState<{ token: string; counts: ChatSourceCounts; time: number }>();
  const [contextError, setContextError] = useState('');
  const [refreshContext, setRefreshContext] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [capacity, setCapacity] = useState(defaultChatContextTokens);
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const followHistory = useRef(true);
  const locked = useRef(false);
  const active = useRef(false);
  const autoSend = useRef(false);
  const closingRef = useRef(false);
  const imageRead = useRef(false);
  const selected = drafts.filter(draft => draft.selected).map(draft => draft.item);
  const sending = action === 'send';
  const conversation = outgoing ? [...messages, { ...outgoing, interrupted: !sending }] : messages;
  const recent = messages.filter(message => !message.interrupted);
  const previousImages = recent.findLast(message => message.images?.length)?.images;
  const attached = sources.images === false ? [] : images.length ? images : previousImages || [];
  const hasMessage = !!(input.trim() || (sources.images !== false && images.length));
  const sendable = !!context && hasMessage;
  const usage = draft.usage;
  const contextPercent = usage ? 100 * usage.contextTokens / capacity : 0;
  const previousUsageUnavailable = !usage && recent.some(message => message.role === 'assistant');

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    void bridge.getAISettings().then(result => {
      if (alive && result.ok) setCapacity(result.settings.chatContextTokens ?? defaultChatContextTokens);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (autoSend.current && !action && !readingImages && !closing) {
      autoSend.current = false;
      if (queued && sendable) void send();
    }
  }, [action, queued, sendable, readingImages, closing]);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setContext(undefined);
    setContextError('');
    void (async () => {
      try {
        const result = await bridge.prepareAIRequirementContext?.(project.id, sources);
        if (!result?.ok || !result.token) throw Error(result?.error || '上下文预览不可用');
        if (alive) setContext({ token: result.token, counts: result.counts || {}, time: Date.now() });
      } catch (e) { if (alive) setContextError((e as Error).message); }
    })();
    return () => { alive = false; };
  }, [ready, sources, project.id, refreshContext]);

  // REQ-320：上下文预览 30 分钟失效，空闲时提前自动刷新；预览失败 15 秒后自动重试，无需手动点「刷新来源」。
  useEffect(() => {
    if (!ready || action) return;
    const delay = contextError ? 15000 : context ? Math.max(1000, context.time + contextRefreshMs - Date.now()) : 0;
    if (!delay) return;
    const timer = setTimeout(() => setRefreshContext(value => value + 1), delay);
    return () => clearTimeout(timer);
  }, [ready, action, context, contextError]);

  function scrollToLatest() {
    followHistory.current = true;
    setAway(false);
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || (locked.current && !sending)) return;
      if (confirmation) setConfirmation('');
      else if (showHistory) setShowHistory(false);
      else void close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirmation, showHistory, draft, action, readingImages]);
  useLayoutEffect(() => {
    if (history.current && followHistory.current) history.current.scrollTop = history.current.scrollHeight;
  }, [messages, sending, showHistory]);

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

  async function close() {
    if (closingRef.current || imageRead.current) return;
    if (sending) {
      closingRef.current = true;
      autoSend.current = false;
      setClosing(true);
      try {
        await flush();
        active.current = false;
        onClose();
      } catch (error) {
        closingRef.current = false;
        setClosing(false);
        setError(`草稿写入失败，聊天室仍打开：${(error as Error).message}`);
      }
      return;
    }
    await run('save', async () => {
      if (submitted) await finishSubmission();
      else await flush();
      onClose();
    });
  }

  function finishSubmission() {
    return persist(queued ? { id: crypto.randomUUID(), input, images, queued, messages: [], drafts: [] } : null);
  }

  function changeSource(key: ChatSource, enabled: boolean) {
    void run('sources', async () => {
      const next = { ...sources, [key]: enabled };
      setContext(undefined);
      setSources(next);
      const result = await bridge.saveAIChatSources?.(project.id, next);
      if (!result?.ok) throw Error(`来源开关未能保存：${result?.error || '本地设置不可用'}`);
    });
  }

  async function addImages(files: File[]) {
    if (!files.length || imageRead.current || closingRef.current || (locked.current && !sending)) return;
    imageRead.current = true;
    setReadingImages(true);
    setError('');
    try {
      if (images.length + files.length > 4) throw Error('每条消息最多插入 4 张图片');
      if (files.some(file => !imageTypes.includes(file.type) || !file.size)) throw Error('请选择有效的 PNG、JPEG、WebP 或 GIF 图片');
      if ([...images, ...files].reduce((size, file) => size + file.size, 0) > 5 * 1024 * 1024) throw Error('每条消息的图片总大小不能超过 5 MB');
      const added = await Promise.all(files.map(file => new Promise<Image>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, size: file.size, url: String(reader.result) });
        reader.onerror = () => reject(Error('读取图片失败，请重新选择'));
        reader.readAsDataURL(file);
      })));
      if (active.current) edit(current => ({ images: [...current.images, ...added] }));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      imageRead.current = false;
      setReadingImages(false);
    }
  }

  function sendOrQueue() {
    if (closingRef.current || imageRead.current) return;
    if (sending && hasMessage) {
      edit({ queued: true });
      void flush().catch(e => setError(`暂存写入失败：${e.message}`));
    } else if (!action) void send();
  }

  /** 重新准备上下文预览并返回新 token（REQ-320 自动刷新）。 */
  async function freshContext() {
    const result = await bridge.prepareAIRequirementContext?.(project.id, sources);
    if (!result?.ok || !result.token) throw Error(result?.error || '上下文预览不可用');
    if (active.current) setContext({ token: result.token, counts: result.counts || {}, time: Date.now() });
    return result.token;
  }

  async function send() {
    if (locked.current || closingRef.current || imageRead.current || !ready || submitted || !bridge.aiRequirements || !context || !sendable) return;
    autoSend.current = false;
    await run('send', async () => {
      scrollToLatest();
      const message: Message = { role: 'user', content: input.trim(), images: sources.images === false ? [] : images, time: new Date().toISOString() };
      const previous = outgoing ? [...messages, { ...outgoing, interrupted: true }] : messages;
      edit({ messages: previous, outgoing: message, queued: false, input: '', images: sources.images === false ? images : [] });
      const discussion = recent.map(({ role, content, images: pictures }) => ({
        role, content: sources.images !== false && pictures?.length ? `${content}\n（此消息附有 ${pictures.length} 张图片）` : content,
      }));
      const result = await (async () => {
        try {
          await flush();
          const request = (token: string) => bridge.aiRequirements!(project.id, 'chat', message.content, discussion,
            attached.map(image => image.url), images.length ? 'current' : 'previous', drafts.map(draft => draft.item), token);
          // REQ-320：上下文过期时自动重新准备并重发一次，不要求手动刷新来源。
          const token = Date.now() - context.time > contextRefreshMs ? await freshContext() : context.token;
          let response = await request(token);
          if (!response?.ok && /上下文预览已失效/.test(response?.error || '')) response = await request(await freshContext());
          if (!response?.ok) throw Error(response?.error || 'AI 需求仅桌面版可用');
          return response;
        } catch (error) {
          if (!active.current || closingRef.current) throw error;
          edit(current => {
            if (current.input || (sources.images !== false && current.images.length)) return {};
            return { outgoing: undefined, input: message.content, images: message.images?.length ? message.images : current.images };
          });
          throw Error(`${(error as Error).message}。下一条消息会留在输入框，请确认后手动发送。`);
        }
      })();
      if (!active.current || closingRef.current) return;
      const revision = result.items ? reconcileDrafts(drafts, result.items) : undefined;
      const replyTime = new Date().toISOString();
      const turn: Message[] = [message,
        { role: 'assistant', content: result.reply || '', reasoning: result.reasoning, toolCalls: result.toolCalls,
          changes: revision?.changes, sourceCounts: result.sourceCounts, model: result.model, time: replyTime }];
      const reported = result.usage;
      if (reported) setCapacity(reported.capacity);
      edit({
        outgoing: undefined, messages: [...previous, ...turn], drafts: revision?.drafts || drafts,
        usage: reported ? {
          contextTokens: reported.contextTokens, tps: reported.tps, estimated: reported.estimated,
          inputTokens: (usage?.inputTokens ?? 0) + reported.inputTokens,
          outputTokens: (usage?.outputTokens ?? 0) + reported.outputTokens,
          compressedMessages: reported.compressedMessages,
          estimatedTotals: usage?.estimatedTotals || reported.estimated,
          partialTotals: usage?.partialTotals || previousUsageUnavailable,
          model: result.model,
        } : usage,
      });
      try {
        await flush({ session: draft.id, time: replyTime, title: message.content, messages: turn });
        autoSend.current = !closingRef.current;
      }
      catch (error) {
        throw Error(`已收到回复，但历史记录写入失败：${(error as Error).message}`);
      }
    });
    composer.current?.focus();
  }

  function update(id: string, patch: Partial<AIDraft>) {
    edit({ drafts: drafts.map(draft => draft.item.id === id ? { ...draft, item: { ...draft.item, ...patch } } : draft) });
  }

  const disabled = !ready || !!action || readingImages || closing || submitted;
  const composerDisabled = !ready || closing || submitted || (!!action && !sending);
  const closeDisabled = closing || readingImages || (!!action && !sending);
  const hasDraft = !!(input || images.length || messages.length || drafts.length || outgoing);

  return <div className="overlay"><div className="dialog ai-requirements-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-requirements-title">
    <div className="dialog-head">
      <div><h3 id="ai-requirements-title">AI 需求 · {project.name}</h3><p>和 AI 讨论需求，生成或修改候选后勾选提交。</p></div>
      <div className="ai-chat-actions">
        <button type="button" className="btn sm" disabled={!!action} onClick={() => { setConfirmation(''); setShowHistory(!showHistory); }}><History />{showHistory ? '返回当前会话' : '聊天历史'}</button>
        <button className="icon-btn" aria-label="关闭 AI 需求" disabled={closeDisabled} onClick={() => void close()}><X /></button>
      </div>
    </div>
    {showHistory ? <ChatHistory project={project.id} /> : <div className="ai-requirements-body">
      <section className="ai-chat" aria-label="需求对话">
        <div className="ai-chat-head"><h4><Wand />当前会话</h4><details className="ai-chat-context">
          <summary>本轮来源 · {context ? chatSources.filter(([key]) => (key === 'images' ? attached.length : context.counts[key] || 0) > 0).length + ' 类' : contextError ? '读取失败' : '读取中'}</summary>
          <div className="ai-chat-source-panel" aria-label="本轮上下文来源">
            {chatSources.map(([key, label]) => <div className="ai-chat-source-row" key={key}>
              <label className="switch"><input type="checkbox" role="switch" checked={sources[key] !== false}
                disabled={disabled} onChange={event => changeSource(key, event.target.checked)} /><span className="slider" aria-hidden="true" />{label}</label>
              <span className="muted">{sources[key] === false ? '已关闭' : key === 'images' ? attached.length : context ? context.counts[key] || 0 : '…'}</span>
            </div>)}
            {contextError && <p className="error" role="alert">{contextError}</p>}
            <button type="button" className="btn sm" disabled={disabled} onClick={() => { setContext(undefined); setRefreshContext(value => value + 1); }}><RefreshCw />刷新来源</button>
          </div>
        </details></div>
        <div className="ai-chat-history" ref={history} role="log" aria-label="对话记录" tabIndex={0}
          onScroll={e => {
            const list = e.currentTarget;
            followHistory.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
            setAway(!followHistory.current);
          }}>
          {!conversation.length && <div className="ai-chat-intro"><span><Wand size={20} /></span><strong>{ready ? '从一个想法开始' : '正在恢复会话…'}</strong><p>描述问题或请 AI 根据项目现状提出建议。讨论形成的需求会出现在右侧。</p></div>}
          {conversation.map((message, index) => <ChatMessage key={index} message={message} />)}
          {sending && <p className="ai-chat-waiting" role="status"><RefreshCw size={16} />正在检查上下文并生成回复，超限时会压缩历史…</p>}
        </div>
        {away && <button type="button" className="btn sm ai-chat-latest" onClick={scrollToLatest}><ChevronDown />回到最新</button>}
        <form className="ai-chat-compose" onSubmit={e => { e.preventDefault(); sendOrQueue(); }}>
          <label className="field"><span className="visually-hidden">消息</span>
            <textarea ref={composer} autoFocus rows={2} maxLength={20000} readOnly={composerDisabled} value={input} placeholder={sending ? '可编辑下一条消息' : '输入想法、问题或修改意见'}
              onChange={e => edit({ input: e.target.value, queued: queued && !!(e.target.value.trim() || (sources.images !== false && images.length)) })}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault(); sendOrQueue();
                }
              }}
              onPaste={e => {
                if (composerDisabled || readingImages) return;
                const files = Array.from(e.clipboardData.files).filter(file => file.type.startsWith('image/'));
                if (files.length) { e.preventDefault(); addImages(files); }
              }} />
          </label>
          {!!images.length && <div className="ai-chat-images">{images.map((image, index) => <div key={index}>
            <img src={image.url} alt={image.name} title={image.name} />
            <button type="button" className="icon-btn" aria-label={`移除图片 ${index + 1}`} disabled={composerDisabled || readingImages} onClick={() => {
              const remaining = images.filter((_, n) => n !== index);
              edit({ images: remaining, queued: queued && !!(input.trim() || (sources.images !== false && remaining.length)) });
            }}><X size={14} /></button>
          </div>)}</div>}
          <div className="ai-chat-actions">
            <input className="visually-hidden" ref={fileInput} tabIndex={-1} type="file" accept={imageTypes.join(',')} multiple disabled={composerDisabled || readingImages} onChange={e => { void addImages(Array.from(e.target.files || [])); e.target.value = ''; }} />
            <button type="button" className="btn" disabled={composerDisabled || readingImages} onClick={() => fileInput.current?.click()}><ImageIcon />{readingImages ? '读取中…' : '插入图片'}</button>
            <button className="btn primary" disabled={composerDisabled || readingImages || !sendable || !bridge.aiRequirements || (sending && queued)}>{sending ? (queued ? '已暂存' : '暂存下一条') : '发送'}</button>
            {sending && queued && <button className="btn" type="button" onClick={() => edit({ queued: false })}>取消自动发送</button>}
          </div>
          {contextError && <p className="error" role="alert">上下文预览失败，可从「本轮来源」刷新。</p>}
          {queued ? <p className="settings-hint" role="status">{sending ? '当前回复成功后自动发送，可继续修改或清空。' : '暂存消息已保留，请确认后手动发送。'}</p> :
            <p className="settings-hint">{sending ? 'Enter 暂存 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行 · 可粘贴图片，每条最多 4 张、合计 5 MB'}</p>}
          <div className="ai-chat-usage" aria-label="会话 Token 用量">
            <span title="最近一次请求的输入与生成内容">{contextPercent >= 80 ? '容量接近上限 · ' : ''}上下文 {usage?.estimated ? '约 ' : ''}{usage ? usage.contextTokens.toLocaleString() : previousUsageUnavailable ? '—' : '0'} / {capacity.toLocaleString()} Token{!previousUsageUnavailable && `（${contextPercent.toFixed(1)}%）`}</span>
            <progress aria-label="上下文使用比例" max={100} value={Math.min(100, contextPercent)} />
            <span>累计{usage?.estimatedTotals ? '估算' : ''}输入 {usage?.inputTokens.toLocaleString() ?? (previousUsageUnavailable ? '—' : '0')} · 输出 {usage?.outputTokens.toLocaleString() ?? (previousUsageUnavailable ? '—' : '0')}</span>
            <span title="最近一次输出 Token 除以整轮请求耗时">最近输出 {usage ? `${usage.tps.toFixed(1)} TPS` : '—'}</span>
            {usage?.model && <span className="ai-chat-usage-model" title={`模型供应商：${usage.model.provider || '未命名'}${usage.model.host ? `（${usage.model.host}）` : ''}\n模型：${usage.model.model}`}>模型 {chatModelLabel(usage.model)}</span>}
          </div>
          {(previousUsageUnavailable || usage?.partialTotals) && <p className="settings-hint">旧版会话用量无法恢复，累计值从升级后的回复开始统计。</p>}
          {!!usage?.compressedMessages && <p className="settings-hint" role="status">上一轮已压缩 {usage.compressedMessages} 条历史消息，完整记录仍保留。</p>}
        </form>
      </section>
      <section className="ai-drafts" aria-label="候选需求">
        <div className="ai-drafts-head"><h4><FileText />候选需求</h4><span className="muted">已勾选 {selected.length} / {drafts.length} 条</span></div>
        <div className="ai-draft-list" tabIndex={0}>
          {!drafts.length && <div className="ai-chat-intro"><span><FileText size={20} /></span><strong>暂无候选需求</strong><p>候选会随对话更新。你可以在这里查看、编辑和勾选。</p></div>}
          {drafts.map(({ item, selected }, index) => <article className="ai-draft" key={item.id}>
            <div className="ai-draft-heading"><label className="ai-draft-select">
              <input type="checkbox" checked={selected} disabled={disabled} onChange={e => {
                const checked = e.target.checked;
                edit({ drafts: drafts.map(draft => draft.item.id === item.id ? { ...draft, selected: checked } : draft) });
              }} />
              <strong>{item.title || `候选需求 ${index + 1}`}</strong>
            </label><button type="button" className="btn sm" disabled={disabled} aria-label={`删除候选 ${item.title || index + 1}`} onClick={() => setConfirmation(item.id)}><Trash />删除</button></div>
            {confirmation === item.id && <div className="ai-chat-confirm" role="group" aria-label="确认删除候选">
              <p>删除后这条候选不会提交到需求池，聊天记录仍可查看。</p>
              <div className="settings-actions">
                <button type="button" className="btn sm" disabled={disabled} onClick={() => setConfirmation('')}>取消</button>
                <button type="button" className="btn sm danger" disabled={disabled} onClick={() => void run('delete', async () => {
                  await persist({ ...draft, drafts: drafts.filter(candidate => candidate.item.id !== item.id) });
                  setConfirmation('');
                })}>确认删除</button>
              </div>
            </div>}
            <p>{kinds.find(([kind]) => kind === item.type)?.[1]} · {item.priority}</p>
            <details><summary>查看和编辑</summary>
              <label className="field">标题<input value={item.title} readOnly={disabled} onChange={e => update(item.id, { title: e.target.value })} /></label>
              <label className="field">说明<textarea rows={3} value={item.body} readOnly={disabled} onChange={e => update(item.id, { body: e.target.value })} /></label>
              <div className="ai-draft-options">
                <div className="segmented" role="group" aria-label="需求类型">{kinds.map(([value, label]) => <button className={item.type === value ? 'on' : ''} aria-pressed={item.type === value} disabled={disabled} key={value} onClick={() => update(item.id, { type: value })}>{label}</button>)}</div>
                <div className="segmented" role="group" aria-label="优先级">{['P0', 'P1', 'P2'].map(value => <button className={item.priority === value ? 'on' : ''} aria-pressed={item.priority === value} disabled={disabled} key={value} onClick={() => update(item.id, { priority: value })}>{value}</button>)}</div>
              </div>
              <label className="field">验收条件<textarea rows={2} value={item.criteria.join('\n')} readOnly={disabled} onChange={e => update(item.id, { criteria: e.target.value.split('\n') })} /></label>
            </details>
          </article>)}
        </div>
      </section>
    </div>}
    {warning && <p className="error ai-chat-error" role="alert">{warning}</p>}
    {error && <p className="error ai-chat-error" role="alert">{error}</p>}
    {!showHistory && confirmation === 'discard' && <p className="ai-chat-error" role="status">放弃会清空当前输入、对话草稿和候选，已保存的聊天历史仍可查看。</p>}
    <div className="dialog-foot">
      {!showHistory && (confirmation === 'discard' ? <>
        <button className="btn" disabled={disabled} onClick={() => setConfirmation('')}>取消放弃</button>
        <button className="btn danger" disabled={disabled} onClick={() => void run('discard', async () => { await persist(null); setConfirmation(''); })}>确认放弃草稿</button>
      </> : <button className="btn ai-chat-discard" disabled={disabled || !hasDraft} onClick={() => setConfirmation('discard')}>放弃草稿…</button>)}
      <button className="btn" disabled={closeDisabled} onClick={() => void close()}>{submitted ? '重试清理并关闭' : sending ? '保留草稿并关闭' : '关闭'}</button>
      {!showHistory && <button className="btn primary" disabled={disabled || !selected.length || selected.some(item => !item.body.trim())} onClick={() => void run('save', async () => {
        if (!await insert(selected)) throw Error('提交失败，候选需求已保留，请重试。');
        setSubmitted(true);
        try { await finishSubmission(); }
        catch (error) { throw Error(`已提交到需求池，清理会话草稿失败：${(error as Error).message}`); }
        onClose();
      })}>{action === 'save' ? '处理中…' : `提交到需求池 · ${selected.length} 条`}</button>}
    </div>
  </div></div>;
}
