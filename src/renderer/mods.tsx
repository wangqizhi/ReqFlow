import protocol from '../../docs/mod-protocol.md?raw';
import { bridge, type LocalAgent } from './api';
import { useCallback, useEffect, useState } from 'react';
import { renderMarkdown } from './markdown';
import { X, Layers, ExternalLink, Copy } from './icons';
import { AGENT_MENTION, useAssignSetting } from './assignment';
import { useTerminalSetting } from './publish-terminal';

// 实验室：通过深链调起 Codex 窗口
const LAB_AGENTS = [
  { id: 'codex', name: 'Codex', mention: AGENT_MENTION }
] as const;

// REQ-213/REQ-216：Local Agent 实验室主动检测系统里的 Agent 是否安装、版本是否需要更新。
// 结果缓存 5 分钟并复用进行中的检测，打开面板、进入页签或窗口重新聚焦时自动刷新。
const AGENT_CATALOG = [['codex', 'Codex', '@openai/codex'], ['pi', 'Pi', '@earendil-works/pi-coding-agent'], ['opencode', 'OpenCode', 'opencode-ai'], ['zcode', 'ZCode', ''], ['claude-code', 'Claude Code', '@anthropic-ai/claude-code'], ['dsh', 'DeepSeek Harness', '@deepseek-ai/dsh']] as const;
const AGENT_PROBE_TTL = 5 * 60 * 1000;
let agentProbeCache: { at: number; agents: LocalAgent[] } | null = null;
let agentProbeRunning: Promise<LocalAgent[]> | null = null;
const probeTime = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
function probeLocalAgents(force = false): Promise<LocalAgent[]> {
  if (!force && agentProbeCache && Date.now() - agentProbeCache.at < AGENT_PROBE_TTL) return Promise.resolve(agentProbeCache.agents);
  if (agentProbeRunning) return agentProbeRunning;
  if (!bridge.detectLocalAgents) return Promise.reject(Error('检测仅桌面版可用'));
  agentProbeRunning = bridge.detectLocalAgents().then(r => {
    if (!r?.ok) throw Error(r?.error || '检测仅桌面版可用');
    const found = r.agents || [];
    agentProbeCache = { at: Date.now(), agents: found };
    return found;
  }).finally(() => { agentProbeRunning = null; });
  return agentProbeRunning;
}

export function ModsOverlay({ onClose, initialTab = 'protocol', projectDir }: { onClose(): void; initialTab?: string; projectDir?: string }) {
  const [terminalEnabled, setTerminalEnabled] = useTerminalSetting();
  // REQ-207：实验室「指派」开关，控制「提交验证」弹窗是否显示指派浮层
  const [assignEnabled, setAssignEnabled] = useAssignSetting();
  const [tab, setTab] = useState(initialTab), [enabled, setEnabled] = useState<string[]>([]), [agents, setAgents] = useState<LocalAgent[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [loaded, setLoaded] = useState(false);
  const [detecting, setDetecting] = useState(false), [probedAt, setProbedAt] = useState(0), [probeError, setProbeError] = useState('');
  const [labBusyId, setLabBusyId] = useState(''), [labStatus, setLabStatus] = useState(''), [labError, setLabError] = useState('');
  const [backend, setBackend] = useState(''), [migrating, setMigrating] = useState(false);
  useEffect(() => { bridge.getStorageStatus?.().then(r => { if (!r.ok) throw Error(r.error); setBackend(r.backend || ''); }).catch(e => setLabError(e.message)); }, []);
  async function migrate() {
    if (migrating) return;
    setMigrating(true); setLabError(''); setLabStatus('');
    try {
      const r = await bridge.migrateStorage?.();
      if (!r?.ok) throw Error(r?.error || '迁移仅桌面版可用');
      setBackend(r.backend || 'sqlite'); setLabStatus('需求已迁移到 SQLite，原始文件已保留备份。');
    } catch (e: any) { setLabError(e.message); }
    finally { setMigrating(false); }
  }
  const labUrl = projectDir ? 'codex://threads/new?path=' + encodeURIComponent(projectDir) + '&prompt=' + encodeURIComponent(AGENT_MENTION) : '';
  const agentTotals = { installed: agents.filter(a => a.installed).length, updates: agents.filter(a => a.update === true).length, unchecked: agents.filter(a => a.registryError).length };
  const detectStatus = !bridge.detectLocalAgents ? '检测仅在桌面版可用'
    : detecting
    ? (agents.length ? '正在检查最新版本…' : '正在检测系统里的 Agent 安装状态…')
    : probedAt
      ? probeTime(probedAt) + ' 检测完成 · 已安装 ' + agentTotals.installed + '/' + AGENT_CATALOG.length
        + (agentTotals.updates ? ' · ' + agentTotals.updates + ' 个有可用更新' : '')
        + (agentTotals.unchecked ? ' · ' + agentTotals.unchecked + ' 个无法比较版本' : '')
      : '尚未检测';
  useEffect(() => { bridge.getLocalAgents?.().then(r => { if (!r.ok) throw Error(r.error); setEnabled(r.enabled || []); setLoaded(true); }).catch(e => setError(e.message)); }, []);
  const runDetect = useCallback(async (force = false) => {
    if (!bridge.detectLocalAgents) return;
    setDetecting(true); setProbeError('');
    try { const found = await probeLocalAgents(force); setAgents(found); setProbedAt(agentProbeCache?.at || Date.now()); }
    catch (e: any) { setProbeError(e?.message || '检测失败，请检查网络与安装权限后重试'); }
    finally { setDetecting(false); }
  }, []);
  // REQ-213：打开面板立即在后台主动检测，不阻塞界面；进入 Local Agent 页签或窗口重新聚焦时刷新过期结果
  useEffect(() => { void runDetect(); }, [runDetect]);
  useEffect(() => {
    if (tab !== 'agents') return;
    void runDetect();
    const onFocus = () => void runDetect();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [tab, runDetect]);
  async function detect() { if (detecting || !bridge.detectLocalAgents) return; await runDetect(true); }
  async function install(id: string) {
    if (busy) return; setBusy(true); setError('');
    try { const r = await bridge.installLocalAgent?.(id); if (!r?.ok) throw Error(r?.error || '安装仅 Go 桌面版可用'); await runDetect(true); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function configure(id: string, value: boolean) { if (busy) return; const next = value ? [...enabled, id] : enabled.filter(x => x !== id); setBusy(true); setError(''); try { const r = await bridge.saveLocalAgents?.(next); if (!r?.ok) throw Error(r?.error || '配置仅桌面版可用'); setEnabled(next); window.dispatchEvent(new Event('reqflow-agents-changed')); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }
  async function copyMention(mention: string, name: string) { try { await navigator.clipboard.writeText(mention); setLabStatus(name + ' Agent 引用已复制到剪贴板。'); } catch { setLabStatus('复制失败，请手动复制下方引用。'); } }
  async function openAgent(id: string) {
    if (labBusyId || !projectDir) return;
    const agent = LAB_AGENTS.find((a) => a.id === id)!;
    setLabBusyId(id); setLabError(''); setLabStatus('');
    try {
      await navigator.clipboard.writeText(agent.mention);
      const r = await bridge.openCodexDeepLink?.(labUrl);
      if (!r?.ok) throw Error(r?.error || '调起仅桌面版可用');
      setLabStatus('已调起 ' + agent.name + ' 窗口' + '；Agent 引用已复制到剪贴板，若输入框未自动填入请手动粘贴发送。');
    } catch (e: any) { setLabError(e.message); } finally { setLabBusyId(''); }
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
      <div className="settings-tabs" role="tablist">{[['protocol', '插件 / MOD 说明'], ['agents', 'Local Agent'], ['lab', '实验室']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}{id === 'agents' && agentTotals.updates > 0 && <span className="tab-badge" title={agentTotals.updates + ' 个 Agent 有可用更新'}>{agentTotals.updates}</span>}</button>)}</div>
      {tab === 'agents' ? <div className="local-agent-body">
        <p className="settings-hint">打开本页会自动检测系统里的 Agent 是否已安装、版本是否需要更新；结果缓存 5 分钟，窗口重新获得焦点或点击「重新检测」会刷新。配置后可以在「提交验证」弹窗中指派（需先在实验室打开「指派」）。Codex 默认可指派；其他 Agent 在此开启后出现在指派选项中。</p>
        <div className="settings-actions">
          <button className="btn" disabled={detecting || !bridge.detectLocalAgents} onClick={() => void detect()}>{detecting ? '检测中…' : '重新检测'}</button>
        </div>
        <p className="settings-hint agent-detect-status" role="status">{detectStatus}</p>
        {error && <p role="alert">{error}</p>}
        {probeError && <p role="alert">{probeError}</p>}
        {AGENT_CATALOG.map(([id, name, pkg]) => {
          const agent = agents.find(a => a.id === id);
          const state = agent ? (agent.installed ? '已安装 · ' + (agent.version || '版本未知') : '未检测到可用安装') : (detecting ? '检测中…' : '尚未检测');
          const detail = [agent?.latest ? '最新版本 ' + agent.latest + ' · ' + (agent.update === undefined ? '版本比较未知' : agent.update ? '有可用更新' : '已是最新') : agent?.registryError || '', agent?.error || ''].filter(Boolean).join(' · ');
          return <section className="local-agent-card" key={id}>
            <div className="validation-setting"><h3>{name}</h3>{id === 'codex' ? <span>默认可指派</span> : <label className="switch"><input type="checkbox" aria-label={'配置 ' + name} disabled={busy || !loaded} checked={enabled.includes(id)} onChange={e => configure(id, e.target.checked)} /><span className="slider" /><span className="switch-state">{enabled.includes(id) ? '已配置' : '未配置'}</span></label>}</div>
            <p className="agent-status">{state}</p>
            {detail && <p className="settings-hint">{detail}</p>}
            {pkg ? <div className="settings-actions"><button className="btn" disabled={busy || !bridge.installLocalAgent} onClick={() => void install(id)}>{busy ? '处理中…' : agent?.installed ? '更新到最新版' : '安装'}</button><code>npm install -g {pkg}@latest</code></div> : <p className="settings-hint">仅检测官方安装；请使用 ZCode 官方安装程序。自定义入口可设置 REQFLOW_ZCODE_CLI。指派采用任务日志模式（build 权限），不支持继续输入；请先在 ZCode 完成模型与登录配置。</p>}
          </section>;
        })}
        <p className="settings-hint">Codex / Pi / Claude Code / DeepSeek Harness 使用交互终端；ZCode 显示任务日志（headless 一次执行、不支持继续输入），完成状态以插件回写为准。OpenCode 支持配置、检测与安装，指派执行适配尚未开放。DeepSeek Harness 的交互终端先执行指派任务，之后可在同一终端继续输入；使用 headless profile，需在该 profile 安装 reqflow-agent-dsh 插件并配置模型，详见插件 README。</p>
      </div> : tab === 'lab' ? <div className="local-agent-body lab-body">
        <div className="lab-target"><span>项目目录</span><code title={projectDir}>{projectDir || '当前项目未关联本地目录，请先在首页「浏览项目 / 关联目录」绑定'}</code></div>
        <section>
          <div className="validation-setting"><h3>Terminal</h3><label className="switch"><input type="checkbox" aria-label="启用 Terminal" checked={terminalEnabled} disabled={!bridge.getPublishOutput} onChange={async e => { try { await setTerminalEnabled(e.target.checked); } catch { setLabError('无法保存 Terminal 设置，请检查本地存储'); } }} /><span className="slider" /><span className="switch-state">{terminalEnabled ? '已开启' : '已关闭'}</span></label></div>
            <p className="settings-hint">开启后立即显示终端，发布时实时显示脚本日志；可收起、重新打开或在独立窗口查看。指派 Codex / Pi / ZCode / Claude Code / DeepSeek Harness 时使用独立会话，可最大化到独立窗口继续查看。</p>
        </section>
        <section>
          <div className="validation-setting"><h3>指派</h3><label className="switch"><input type="checkbox" aria-label="启用指派" checked={assignEnabled} onChange={async e => { try { await setAssignEnabled(e.target.checked); } catch { setLabError('无法保存指派设置，请检查本地存储'); } }} /><span className="slider" /><span className="switch-state">{assignEnabled ? '已开启' : '已关闭'}</span></label></div>
          <p className="settings-hint">开启后，排期表单条与整个列表的「提交验证」弹窗才会出现指派浮层，单条入口可独立指派，列表入口合并 Prompt 统一指派 Codex / pi / Claude Code 在交互终端执行，或由 ZCode / DeepSeek Harness 执行任务日志；关闭时弹窗只有是否确认完成。</p>
        </section>
        <section>
          <div className="validation-setting"><h3>Agent 安装与更新</h3><span>{agentTotals.updates ? agentTotals.updates + ' 个可更新' : '已安装 ' + agentTotals.installed + '/' + AGENT_CATALOG.length}</span></div>
          <p className="settings-hint">{detectStatus}{probeError ? ' · ' + probeError : ''}。打开「Local Agent」页签会自动检测安装状态与版本，可在其中安装或更新。</p>
          <div className="settings-actions"><button className="btn" disabled={detecting || !bridge.detectLocalAgents} onClick={() => void detect()}>{detecting ? '检测中…' : '检测安装 / 检查更新'}</button></div>
        </section>
        {LAB_AGENTS.map((agent) => <section key={agent.id}>
          <div className="validation-setting"><h3>调起 {agent.name} 窗口（实验功能）</h3></div>
          <p className="settings-hint">开启「指派」后，「提交验证」弹窗可指派 Codex，在 Terminal 中以完全控制模式（--sandbox danger-full-access）执行单条需求并继续沟通。</p>
          <div className="settings-actions">
            <button className="btn primary" disabled={labBusyId !== '' || !projectDir || !bridge.openCodexDeepLink}
              onClick={() => void openAgent(agent.id)}
              title={projectDir ? '在项目目录调起 Codex 桌面窗口' : '先关联本地项目目录'}>
              <ExternalLink size={15} />{labBusyId === agent.id ? '调起中…' : '调起 Codex 窗口'}
            </button>
            <button className="btn" onClick={() => void copyMention(agent.mention, agent.name)}><Copy size={15} />复制 Agent 引用</button>
          </div>
        </section>)}
        {labStatus && <p role="status">{labStatus}</p>}
        {labError && <p role="alert">{labError}</p>}
        {error && <p role="alert">{error}</p>}
        <hr />
        <div className="validation-setting"><h3>需求数据库</h3><span>{backend === 'sqlite' ? 'SQLite' : backend === 'json' ? '文件存储' : '不可用'}</span></div>
        <div className="settings-actions"><button className="btn" disabled={migrating || backend !== 'json'} onClick={() => void migrate()}>{migrating ? '迁移中…' : '迁移到 SQLite'}</button></div>
        <p className="settings-hint">Codex 本次调起链接：<code className="lab-link">{labUrl || '—'}</code></p>
        <p className="settings-hint">链接格式：<code>codex://threads/new?path=&lt;项目目录&gt;&amp;prompt=&lt;Agent引用&gt;</code></p>
        <p className="settings-hint">Agent 引用：<code>{AGENT_MENTION}</code>（Codex）。在绑定 ReqFlow 项目目录的聊天中只发送对应引用，即可授权读取排期并开始实现，完成后回写待验证（见「插件 / MOD 说明」）。</p>
      </div> : <article className="help-body fb-md mod-document" dangerouslySetInnerHTML={{ __html: renderMarkdown(protocol) }} />}
    </section>
  </div>;
}
