import protocol from '../../docs/mod-protocol.md?raw';
import { bridge, type LocalAgent } from './api';
import { useEffect, useState } from 'react';
import { renderMarkdown } from './markdown';
import { X, Layers, ExternalLink, Copy } from './icons';

const AGENT_MENTION = '[@ReqFlow Agent](plugin://reqflow-agent@reqflow-local)';

export function ModsOverlay({ onClose, initialTab = 'protocol', projectDir }: { onClose(): void; initialTab?: string; projectDir?: string }) {
  const [tab, setTab] = useState(initialTab), [enabled, setEnabled] = useState<string[]>([]), [agents, setAgents] = useState<LocalAgent[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [loaded, setLoaded] = useState(false);
  const [labBusy, setLabBusy] = useState(false), [labStatus, setLabStatus] = useState(''), [labError, setLabError] = useState('');
  const labUrl = projectDir ? 'codex://threads/new?path=' + encodeURIComponent(projectDir) + '&prompt=' + encodeURIComponent(AGENT_MENTION) : '';
  useEffect(() => { bridge.getLocalAgents?.().then(r => { if (!r.ok) throw Error(r.error); setEnabled(r.enabled || []); setLoaded(true); }).catch(e => setError(e.message)); }, []);
  async function detect() { if (busy) return; setBusy(true); setError(''); try { const r = await bridge.detectLocalAgents?.(); if (!r?.ok) throw Error(r?.error || '检测仅桌面版可用'); setAgents(r.agents || []); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }
  async function configure(id: string, value: boolean) { if (busy) return; const next = value ? [...enabled, id] : enabled.filter(x => x !== id); setBusy(true); setError(''); try { const r = await bridge.saveLocalAgents?.(next); if (!r?.ok) throw Error(r?.error || '配置仅桌面版可用'); setEnabled(next); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }
  async function copyMention() { try { await navigator.clipboard.writeText(AGENT_MENTION); setLabStatus('Agent 引用已复制到剪贴板。'); } catch { setLabStatus('复制失败，请手动复制下方引用。'); } }
  async function openCodex() {
    if (labBusy || !projectDir || !labUrl) return;
    setLabBusy(true); setLabError(''); setLabStatus('');
    try {
      await navigator.clipboard.writeText(AGENT_MENTION);
      const r = await bridge.openCodexDeepLink?.(labUrl);
      if (!r?.ok) throw Error(r?.error || '调起仅桌面版可用');
      setLabStatus('已调起 Codex 窗口；Agent 引用已复制到剪贴板，若输入框未自动填入请手动粘贴发送。');
    } catch (e: any) { setLabError(e.message); } finally { setLabBusy(false); }
  }
  // REQ-062：Esc 关闭插件/MOD/AGENT 说明浮层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="help-panel" role="dialog" aria-modal="true" aria-label="插件/MOD/AGENT">
      <header className="help-header"><div><h2><Layers /> 插件 / MOD / AGENT</h2><p>对接规范草案 · 尚未开放插件安装与运行功能</p></div><button className="icon-btn" aria-label="关闭插件/MOD/AGENT" onClick={onClose}><X /></button></header>
      <div className="settings-tabs" role="tablist">{[['protocol', '插件 / MOD 说明'], ['agents', 'Local Agent'], ['lab', '实验室']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
      {tab === 'agents' ? <div className="local-agent-body"><p className="settings-hint">配置后可以在排期表中指派。当前只保存配置、检测安装与版本，执行接口预留。</p><div className="settings-actions"><button className="btn" disabled={busy || !bridge.detectLocalAgents} onClick={detect}>{busy ? '处理中…' : '检测安装 / 检查更新'}</button></div>{error && <p role="alert">{error}</p>}{[['opencode', 'OpenCode', 'opencode-ai'], ['pi', 'pi', '@earendil-works/pi-coding-agent']].map(([id, name, pkg]) => { const agent = agents.find(a => a.id === id); return <section className="local-agent-card" key={id}><div className="validation-setting"><h3>{name}</h3><label className="switch"><input type="checkbox" aria-label={'配置 ' + name} disabled={busy || !loaded} checked={enabled.includes(id)} onChange={e => configure(id, e.target.checked)} /><span className="slider" /><span className="switch-state">{enabled.includes(id) ? '已配置' : '未配置'}</span></label></div><p>{agent ? (agent.installed ? '已安装 · ' + (agent.version || '版本未知') : '未检测到可用安装') : '尚未检测'}</p>{agent && <p className="settings-hint">{agent.latest ? '最新版本 ' + agent.latest + ' · ' + (agent.update === undefined ? '版本比较未知' : agent.update ? '有可用更新' : '无需更新') : agent.registryError}{agent.error && ' · ' + agent.error}</p>}<p className="settings-hint">安装 / 更新命令：<code>npm install -g {pkg}</code></p><p className="settings-hint">执行器标识：agent:{id} · 通过本机 PATH 检测 {id} --version</p></section>; })}<p className="settings-hint">接口约定：输入项目目录、需求 ID / 版本、批次 Prompt；输出执行状态、摘要与验证结果。OpenCode 预留 CLI / SDK 适配，pi 预留 RPC 适配；任务启动、结果回写与取消均尚未开放。</p><p className="settings-hint">插件可沿用说明页的协议；这里暂只支持 OpenCode、pi 本机配置。</p></div> : tab === 'lab' ? <div className="local-agent-body lab-body">
        <p className="settings-hint">实验功能：通过 Codex Deep Link 在当前项目目录调起 Codex 桌面窗口，并尝试把 ReqFlow Agent 引用预填到输入框。path 为官方 CLI 使用的参数；prompt 预填为实验参数，若输入框未自动填入请手动粘贴，引用会自动复制到剪贴板。</p>
        <div className="lab-target"><span>项目目录</span><code title={projectDir}>{projectDir || '当前项目未关联本地目录，请先在首页「浏览项目 / 关联目录」绑定'}</code></div>
        <div className="settings-actions">
          <button className="btn primary" disabled={labBusy || !projectDir || !bridge.openCodexDeepLink} onClick={() => void openCodex()} title={projectDir ? '在项目目录调起 Codex 桌面窗口' : '先关联本地项目目录'}><ExternalLink size={15} />{labBusy ? '调起中…' : '调起 Codex 窗口'}</button>
          <button className="btn" onClick={() => void copyMention()}><Copy size={15} />复制 Agent 引用</button>
        </div>
        {labStatus && <p role="status">{labStatus}</p>}
        {labError && <p role="alert">{labError}</p>}
        <p className="settings-hint">本次调起链接：<code className="lab-link">{labUrl || '—'}</code></p>
        <p className="settings-hint">链接格式：<code>codex://threads/new?path=&lt;项目目录&gt;&amp;prompt=&lt;Agent引用&gt;</code></p>
        <p className="settings-hint">Agent 引用：<code>{AGENT_MENTION}</code>。在绑定 ReqFlow 项目目录的 Codex 聊天中只发送该引用，即可授权读取排期并开始实现，完成后回写待验证（见「插件 / MOD 说明」0.2.1）。</p>
      </div> : <article className="help-body fb-md mod-document" dangerouslySetInnerHTML={{ __html: renderMarkdown(protocol) }} />}
    </section>
  </div>;
}
