export type UpdateState = {
  phase: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  version?: string;
  progress?: number;
  downloaded?: number;
  total?: number;
  error?: string;
  retry?: 'check' | 'download' | 'install';
  /** REQ-283：安装前检测到执行中任务时返回的数量，前端据此弹出一次确认。 */
  confirmTasks?: number;
  /** REQ-287：安装流程当前阶段的可见状态说明。 */
  step?: string;
};

export function newerVersion(candidate: string, current: string): boolean {
  const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
  const next = parse(candidate), installed = parse(current);
  if (!next || !installed) return false;
  for (let i = 0; i < 3; i++) {
    if (next[i] !== installed[i]) return next[i] > installed[i];
  }
  return false;
}
