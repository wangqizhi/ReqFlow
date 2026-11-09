import { useEffect, useRef, useState } from 'react';
import type { ChatDraft, ChatSources, ChatTurn } from '../core/ai-chat';
import { bridge } from './api';

const writes = new Map<string, Promise<void>>();

function saveDraft(project: string, draft: ChatDraft | null, turn?: ChatTurn) {
  const write = (writes.get(project) || Promise.resolve()).catch(() => {}).then(async () => {
    const result = await bridge.saveAIChatDraft?.(project, draft, turn);
    if (!result?.ok) throw Error(result?.error || '本地草稿存储不可用');
  });
  writes.set(project, write);
  const release = () => { if (writes.get(project) === write) writes.delete(project); };
  void write.then(release, release);
  return write;
}

function emptyDraft(): ChatDraft {
  return { id: crypto.randomUUID(), input: '', images: [], messages: [], drafts: [] };
}

export function useAIChatSession(project: string) {
  const [draft, setDraft] = useState(emptyDraft);
  const [sources, setSources] = useState<ChatSources>({});
  const [ready, setReady] = useState(false);
  const [warning, setWarning] = useState('');
  const current = useRef(draft);
  const pending = useRef<ChatDraft | null | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  function replace(next: ChatDraft) {
    current.current = next;
    setDraft(next);
  }

  function flush(turn?: ChatTurn) {
    clearTimeout(timer.current);
    const value = pending.current;
    pending.current = undefined;
    if (value === undefined) return writes.get(project) || Promise.resolve();
    return saveDraft(project, value, turn).catch(error => {
      if (current.current === value) pending.current = value;
      throw error;
    });
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await writes.get(project)?.catch(() => {});
        const result = await bridge.getAIChatState?.(project);
        if (!active) return;
        if (!result?.ok) throw Error(result?.error || '本地草稿存储不可用');
        if (result.draft) {
          const value = result.draft;
          if (!value.id || typeof value.input !== 'string' || !Array.isArray(value.images) || !Array.isArray(value.messages) || !Array.isArray(value.drafts)) {
            throw Error('保存的草稿格式无效');
          }
          replace(value);
        }
        setSources(result.sources || {});
      } catch (error) {
        if (active) setWarning(`无法恢复聊天室草稿：${(error as Error).message}`);
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
      void flush().catch(() => {});
    };
  }, [project]);

  function edit(patch: Partial<ChatDraft> | ((current: ChatDraft) => Partial<ChatDraft>)) {
    const next = { ...current.current, ...(typeof patch === 'function' ? patch(current.current) : patch) };
    replace(next);
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flush().then(() => setWarning('')).catch(error => {
        setWarning(`未能自动保存草稿：${error.message}`);
      });
    }, 280);
  }

  async function persist(next: ChatDraft | null) {
    clearTimeout(timer.current);
    const unsaved = pending.current;
    pending.current = undefined;
    try {
      await saveDraft(project, next);
      replace(next || emptyDraft());
      setWarning('');
    } catch (error) {
      pending.current = unsaved;
      throw error;
    }
  }

  return { draft, sources, setSources, ready, warning, edit, persist, flush };
}
