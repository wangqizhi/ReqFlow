import { useEffect, useState, useSyncExternalStore } from 'react';
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
      setAgents(r.enabled || []);
    }).catch(e => { if (!cancelled) setError(e.message); });
    void refresh();
    window.addEventListener('reqflow-agents-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => { cancelled = true; window.removeEventListener('reqflow-agents-changed', refresh); window.removeEventListener('focus', refresh); };
  }, [active]);
  return { agents, error };
}

// 实验室「指派」开关（REQ-207）：关闭时「提交验证」弹窗只保留是否确认完成，不显示指派浮层。
// 与 Terminal 开关一样保存在应用数据目录，重启后保持；浏览器预览退回 localStorage。
const assignKey = 'reqflow-lab-assign';
const assignEvent = 'reqflow-assign-changed';
function readAssign() { try { return localStorage.getItem(assignKey) === 'true'; } catch { return false; } }
function subscribeAssign(listener: () => void) {
  window.addEventListener(assignEvent, listener);
  window.addEventListener('storage', listener);
  return () => { window.removeEventListener(assignEvent, listener); window.removeEventListener('storage', listener); };
}
let assignLoaded = false;
let assignSaving = false;
async function loadAssignSetting() {
  if (assignLoaded || !bridge.getAssignSetting) return;
  assignLoaded = true;
  try {
    const r = await bridge.getAssignSetting();
    if (!r.ok) throw Error('读取指派设置失败');
    if (assignSaving) return;
    if (r.settings) localStorage.setItem(assignKey, String(r.settings.enabled));
    else await bridge.saveAssignSetting?.(readAssign());
    window.dispatchEvent(new Event(assignEvent));
  } catch { assignLoaded = false; }
}
export function useAssignSetting(): [boolean, (enabled: boolean) => Promise<void>] {
  useEffect(() => { void loadAssignSetting(); }, []);
  const enabled = useSyncExternalStore(subscribeAssign, readAssign);
  return [enabled, async value => {
    assignSaving = true;
    const result = await bridge.saveAssignSetting?.(value);
    if (result && !result.ok) throw Error(result.error || '无法保存指派设置');
    localStorage.setItem(assignKey, String(value));
    window.dispatchEvent(new Event(assignEvent));
  }];
}

export function agentName(id: string) {
  return id === 'opencode' ? 'OpenCode' : id === 'codex' ? 'Codex' : id === 'pi' ? 'Pi' : id === 'zcode' ? 'ZCode' : id === 'claude-code' ? 'Claude Code' : id === 'dsh' ? 'DeepSeek Harness' : id;
}

// 支持在交互终端执行单条需求的 Agent（REQ-206：pi 与 Codex 同样支持；REQ-216 新增 Claude Code / DeepSeek Harness）
export const TERMINAL_AGENTS = ['codex', 'pi', 'zcode', 'claude-code', 'dsh'];

// 只读任务日志模式：一次性执行、输出日志，不支持继续输入（ZCode）
export const LOG_AGENTS = ['zcode'];
export function agentLogOnly(agent: string) {
  return LOG_AGENTS.includes(agent) || LOG_AGENTS.some(id => agentName(id) === agent);
}

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
