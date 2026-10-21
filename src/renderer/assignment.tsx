import { useEffect, useState } from 'react';
import { bridge } from './api';

// 已配置的 Local Agent（提交验证弹窗指派用）；每次 active 变为 true 时重新拉取，agents 为 null 表示尚未加载
export function useLocalAgents(active: boolean) {
  const [agents, setAgents] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    if (!bridge.getLocalAgents) { setAgents([]); return; }
    const refresh = () => bridge.getLocalAgents!().then(r => {
      if (cancelled) return;
      setError(r.ok ? '' : r.error || '读取配置失败');
      setAgents((r.enabled || []).filter(id => id !== 'zcode'));
    }).catch(e => { if (!cancelled) setError(e.message); });
    void refresh();
    window.addEventListener('reqflow-agents-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => { cancelled = true; window.removeEventListener('reqflow-agents-changed', refresh); window.removeEventListener('focus', refresh); };
  }, [active]);
  return { agents, error };
}

export function agentName(id: string) {
  return id === 'opencode' ? 'OpenCode' : id === 'codex' ? 'Codex' : id === 'pi' ? 'Pi' : id;
}

// 支持在交互终端执行单条需求的 Agent（REQ-206：pi 与 Codex 同样支持）
export const TERMINAL_AGENTS = ['codex', 'pi'];

// Codex 版插件引用（与 docs/reqflow-codex-plugin.md、mods.tsx 同源使用）
export const AGENT_MENTION = '[@ReqFlow Agent](plugin://reqflow-agent@reqflow-local)';

// 执行方式显示名：agent:opencode → OpenCode，未知标识原样展示
export function executorLabel(executor: string | undefined) {
  const value = executor || 'ai';
  if (value === 'ai') return 'AI 执行';
  if (value === 'human') return '人工执行';
  if (value.startsWith('agent:')) return agentName(value.slice('agent:'.length));
  return value;
}
