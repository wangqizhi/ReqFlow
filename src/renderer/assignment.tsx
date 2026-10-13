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
    const refresh = () => bridge.getLocalAgents!().then(r => {
      if (cancelled) return;
      setError(r.ok ? '' : r.error || '读取配置失败');
      setAgents(r.enabled || []);
    }).catch(e => { if (!cancelled) setError(e.message); });
    void refresh();
    window.addEventListener('reqflow-agents-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => { cancelled = true; window.removeEventListener('reqflow-agents-changed', refresh); window.removeEventListener('focus', refresh); };
  }, [active]);
  return { agents, error };
}

export function agentName(id: string) {
  return id === 'opencode' ? 'OpenCode' : id === 'codex' ? 'Codex' : id;
}

// Codex 版插件引用（与 docs/reqflow-codex-plugin.md、mods.tsx 同源使用）
export const AGENT_MENTION = '[@ReqFlow Agent](plugin://reqflow-agent@reqflow-local)';

export async function sendToCodex(projectDir: string, prompt: string) {
  const url = 'codex://threads/new?path=' + encodeURIComponent(projectDir) + '&prompt=' + encodeURIComponent(prompt);
  await navigator.clipboard.writeText(prompt);
  const result = await bridge.openCodexDeepLink?.(url);
  if (!result?.ok) throw Error(result?.error || '调起 Codex 仅桌面版可用');
}

// REQ-114：ZCode 版实验功能。ZCode 是 CLI，没有深链协议：复制 Agent 引用后在项目目录
// 打开新终端窗口运行 zcode；引用里的 marketplace 标识与 plugins/marketplace.json 同源。
export const ZCODE_MENTION = '[@reqflow-agent-zcode](plugin://reqflow-agent-zcode@dev-reqflow-0621a305)';

export async function sendToZcode(projectDir: string, prompt: string) {
  await navigator.clipboard.writeText(prompt);
  const result = await bridge.openZcode?.(projectDir);
  if (!result?.ok) throw Error(result?.error || '调起 ZCode 仅桌面版可用');
}

// 执行方式显示名：agent:opencode → OpenCode，未知标识原样展示
export function executorLabel(executor: string | undefined) {
  const value = executor || 'ai';
  if (value === 'ai') return 'AI 执行';
  if (value === 'human') return '人工执行';
  if (value.startsWith('agent:')) return agentName(value.slice('agent:'.length));
  return value;
}
