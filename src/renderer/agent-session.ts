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
