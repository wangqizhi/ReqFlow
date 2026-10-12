import protocol from '../../docs/mod-protocol.md?raw';
import { bridge, type LocalAgent } from './api';
import { useEffect, useState } from 'react';
import { renderMarkdown } from './markdown';
import { X, Layers } from './icons';
export function ModsOverlay({ onClose, initialTab = 'protocol' }: { onClose(): void; initialTab?: string }) {
  const [tab, setTab] = useState(initialTab), [enabled, setEnabled] = useState<string[]>([]), [agents, setAgents] = useState<LocalAgent[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [loaded, setLoaded] = useState(false);
  useEffect(() => { bridge.getLocalAgents?.().then(r => { if (!r.ok) throw Error(r.error); setEnabled(r.enabled || []); setLoaded(true); }).catch(e => setError(e.message)); }, []);
  async function detect() { if (busy) return; setBusy(true); setError(''); try { const r = await bridge.detectLocalAgents?.(); if (!r?.ok) throw Error(r?.error || '检测仅桌面版可用'); setAgents(r.agents || []); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }
  async function configure(id: string, value: boolean) { if (busy) return; const next = value ? [...enabled, id] : enabled.filter(x => x !== id); setBusy(true); setError(''); try { const r = await bridge.saveLocalAgents?.(next); if (!r?.ok) throw Error(r?.error || '配置仅桌面版可用'); setEnabled(next); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }
  // REQ-062：Esc 关闭插件/MOD/AGENT 说明浮层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="help-panel" role="dialog" aria-modal="true" aria-label="插件/MOD/AGENT">
      <header className="help-header"><div><h2><Layers /> 插件 / MOD / AGENT</h2><p>对接规范草案 · 尚未开放插件安装与运行功能</p></div><button className="icon-btn" aria-label="关闭插件/MOD/AGENT" onClick={onClose}><X /></button></header>
      <div className="settings-tabs" role="tablist">{[['protocol', '插件 / MOD 说明'], ['agents', 'Local Agent']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
      {tab === 'agents' ? <div className="local-agent-body"><p className="settings-hint">配置后可以在排期表中指派。当前只保存配置、检测安装与版本，执行接口预留。</p><div className="settings-actions"><button className="btn" disabled={busy || !bridge.detectLocalAgents} onClick={detect}>{busy ? '处理中…' : '检测安装 / 检查更新'}</button></div>{error && <p role="alert">{error}</p>}{[['opencode', 'OpenCode', 'opencode-ai'], ['pi', 'pi', '@earendil-works/pi-coding-agent']].map(([id, name, pkg]) => { const agent = agents.find(a => a.id === id); return <section className="local-agent-card" key={id}><div className="validation-setting"><h3>{name}</h3><label className="switch"><input type="checkbox" aria-label={'配置 ' + name} disabled={busy || !loaded} checked={enabled.includes(id)} onChange={e => configure(id, e.target.checked)} /><span className="slider" /><span className="switch-state">{enabled.includes(id) ? '已配置' : '未配置'}</span></label></div><p>{agent ? (agent.installed ? '已安装 · ' + (agent.version || '版本未知') : '未检测到可用安装') : '尚未检测'}</p>{agent && <p className="settings-hint">{agent.latest ? '最新版本 ' + agent.latest + ' · ' + (agent.update === undefined ? '版本比较未知' : agent.update ? '有可用更新' : '无需更新') : agent.registryError}{agent.error && ' · ' + agent.error}</p>}<p className="settings-hint">安装 / 更新命令：<code>npm install -g {pkg}</code></p><p className="settings-hint">执行器标识：agent:{id} · 通过本机 PATH 检测 {id} --version</p></section>; })}<p className="settings-hint">接口约定：输入项目目录、需求 ID / 版本、批次 Prompt；输出执行状态、摘要与验证结果。OpenCode 预留 CLI / SDK 适配，pi 预留 RPC 适配；任务启动、结果回写与取消均尚未开放。</p><p className="settings-hint">插件可沿用说明页的协议；这里暂只支持 OpenCode、pi 本机配置。</p></div> : <article className="help-body fb-md mod-document" dangerouslySetInnerHTML={{ __html: renderMarkdown(protocol) }} />}
    </section>
  </div>;
}
