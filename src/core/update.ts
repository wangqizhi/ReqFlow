export type UpdateState = {
  phase: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  version?: string;
  progress?: number;
  downloaded?: number;
  total?: number;
  error?: string;
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
