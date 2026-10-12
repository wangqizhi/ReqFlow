import { useEffect, useState } from 'react';
import { bridge } from './api';

// 已配置的 Local Agent（排期指派用）；每次 active 变为 true 时重新拉取，agents 为 null 表示尚未加载
export function useLocalAgents(active: boolean) {
  const [agents, setAgents] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    if (!bridge.getLocalAgents) { setAgents([]); return; }
    bridge.getLocalAgents().then(r => {
      if (cancelled) return;
      if (!r.ok) setError(r.error || '读取配置失败');
      setAgents(r.enabled || []);
    }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [active]);
  return { agents, error };
}

export function agentName(id: string) {
  return id === 'opencode' ? 'OpenCode' : id;
}

// 执行方式显示名：agent:opencode → OpenCode，未知标识原样展示
export function executorLabel(executor: string | undefined) {
  const value = executor || 'ai';
  if (value === 'ai') return 'AI 执行';
  if (value === 'human') return '人工执行';
  if (value.startsWith('agent:')) return agentName(value.slice('agent:'.length));
  return value;
}
