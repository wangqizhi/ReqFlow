import type { AIDraft } from './ai';

export const chatSources = [
  ['overview', '项目说明'], ['guidance', '引导词与守则'], ['git', '近期 Git 记录'],
  ['requirements', '近期需求'], ['files', '项目文件'], ['images', '图片'],
] as const;
export type ChatSource = typeof chatSources[number][0];
export type ChatSources = Partial<Record<ChatSource, boolean>>;
export type ChatSourceCounts = Partial<Record<ChatSource, number>>;
export type ChatImage = { name: string; size: number; url: string };
export type AIRequirementToolCall = { name: string; operations: ('create' | 'update' | 'list')[] };
export type ChatMessage = {
  role: 'user' | 'assistant'; content: string; time?: string; images?: ChatImage[]; reasoning?: string;
  toolCalls?: AIRequirementToolCall[]; changes?: { action: '新增' | '修改'; item: AIDraft }[]; sourceCounts?: ChatSourceCounts;
  interrupted?: boolean;
};
export type ChatCandidate = { item: AIDraft & { id: string }; selected: boolean };
export type ChatDraft = {
  id: string; input: string; images: ChatImage[]; messages: ChatMessage[]; drafts: ChatCandidate[];
  outgoing?: ChatMessage; queued?: boolean; usage?: ChatUsage;
};
export type ChatUsage = {
  contextTokens: number; inputTokens: number; outputTokens: number; tps: number; estimated: boolean;
  compressedMessages?: number; estimatedTotals?: boolean; partialTotals?: boolean;
};
export type ChatTurnUsage = ChatUsage & { capacity: number };
export type ChatTurn = { session: string; time: string; title: string; messages: ChatMessage[] };
export type ChatHistoryEntry = { id: string; time: string; title: string };
