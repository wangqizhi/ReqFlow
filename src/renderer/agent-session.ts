import { activeAIExecution, type Item } from '../core/domain';

export type AgentSession = {
  runId: string;
  open: boolean;
  items: string[];
  versions: Record<string, number>;
  agent: string;
  startedAt: number;
  needsInput?: boolean;
  done?: boolean;
};

// A rejected or edited requirement belongs to a new round, even if the old TUI stays open.
export function sessionOwnsItem(item: Item, session?: AgentSession) {
  return !!session && !session.done && session.items.includes(item.id)
    && session.versions[item.id] === item.version && !item.archived && item.status !== 'archived';
}

export function itemExecuting(item: Item, session?: AgentSession) {
  return !item.archived && item.status !== 'archived' && item.status !== 'pending_verification'
    && (!!activeAIExecution(item) || sessionOwnsItem(item, session));
}

// REQ-248：同一会话中已有需求转入待验证、但仍有需求停留在执行中时，返回仍需推动的需求。
export function stalledSessionItems(items: Item[], session?: AgentSession) {
  if (!session) return { finished: [] as Item[], stalled: [] as Item[] };
  const owned = items.filter(i => session.items.includes(i.id) && session.versions[i.id] === i.version && !i.archived);
  const finished = owned.filter(i => i.status === 'pending_verification');
  const stalled = owned.filter(i => i.status !== 'pending_verification' && i.status !== 'archived'
    && (!!activeAIExecution(i) || (!session.done && sessionOwnsItem(i, session))));
  return { finished, stalled };
}

export function continuePrompt(stalled: Item[]) {
  const list = stalled.map(i => (i.number || i.id) + (i.title ? ' ' + i.title : '')).join('、');
  return '以下需求仍在执行中：' + list + '。请继续完成这些需求并提交到待验证；如果确实无法完成，请说明原因并结束会话，ReqFlow 会把它们退回排期表。\r';
}
