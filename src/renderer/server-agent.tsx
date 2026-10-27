import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge, type ServerAgentDraft, type ServerAgentEntry } from './api';
import { Check, Eye, FolderOpen, Globe, Plus, ShieldAlert, Trash, X } from './icons';
import { trustServerAgentDraft } from './server-agent-trust';

// Server Agent 设置页（REQ-237/238/239）：管理多套远程同步服务端配置，
// 展示连接状态（已连接 / 断开 / 证书异常 / 待确认信任）与失败原因；
// 首次连接需确认服务端证书指纹，指纹变化时阻断并提供手动重置入口。

type Editor = ServerAgentDraft & { token?: string };
const emptyEditor: Editor = { name: '', host: '', port: 8787, tlsMode: 'pin', autoConnect: false, token: '' };

function statusLabel(status?: ServerAgentEntry['status']): { text: string; cls: string } {
  switch (status?.state) {
    case 'connected': return { text: '已连接', cls: 'on' };
    case 'cert_error': return { text: '证书异常', cls: 'cert' };
    case 'need_trust': return { text: '待确认信任', cls: 'cert' };
    default: return { text: '断开', cls: 'off' };
  }
}
function failureText(kind?: string, message?: string): string {
  if (!message) return '';
  if (kind === 'network') return '网络不可达：' + message;
  if (kind === 'cert') return '证书不匹配：' + message;
  if (kind === 'auth') return '认证失败：' + message;
  return message;
}
function formatFingerprint(value?: string): string {
  return (value || '').toUpperCase().replace(/(.{2})(?=.)/g, '$1:');
}
function timeLabel(value?: string): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString('zh-CN') : '—';
}

export function ServerAgentPage({ notify }: { notify(text: string, kind?: 'ok' | 'err'): void }) {
  const [servers, setServers] = useState<ServerAgentEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState<{ server: ServerAgentEntry; draft?: ServerAgentDraft; fingerprint?: string; code?: string; message?: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [install, setInstall] = useState({ open: false, ssh: '', port: 8787, dataDir: '' });
  const [uninstall, setUninstall] = useState({ open: false, ssh: '', serverId: '', cleanData: false, previewDataDir: '' });
  const [update, setUpdate] = useState<{ server: ServerAgentEntry; ssh: string } | null>(null);
  const pollRef = useRef(false);

  const refresh = useCallback(async (quiet = true) => {
    if (!bridge.getServerAgents) { if (!quiet) setError('Server Agent 仅桌面版可用'); setLoaded(true); return; }
    try {
      const r = await bridge.getServerAgents();
      if (!r.ok) throw Error(r.error || '读取服务端配置失败');
      setServers(r.servers || []);
      setError('');
    } catch (e: any) {
      if (!quiet) setError(e.message);
    } finally { setLoaded(true); }
  }, []);

  useEffect(() => { void refresh(false); }, [refresh]);
  useEffect(() => {
    if (pollRef.current) return;
    pollRef.current = true;
    const timer = window.setInterval(() => void refresh(true), 5000);
    return () => { pollRef.current = false; window.clearInterval(timer); };
  }, [refresh]);

  async function run(key: string, action: () => Promise<any>, success: string) {
    if (busy) return;
    setBusy(key);
    try {
      const r = await action();
      if (r && r.ok === false && !r.kind) throw Error(r.error || '操作失败');
      await refresh(true);
      if (r?.ok === false) return r;
      notify(success);
      return r;
    } catch (e: any) {
      notify(e.message, 'err');
      return null;
    } finally { setBusy(''); }
  }

  async function connect(server: ServerAgentEntry) {
    const r = await run(server.id, () => bridge.connectServerAgent!(server.id), '已连接 ' + server.name);
    if (r && r.ok === false) handleProbeResult(server, r);
  }

  // NEED_TRUST（首次）与 CERT_CHANGED（指纹变化）都进入确认弹窗，由用户显式确认或重置。
  function handleProbeResult(server: ServerAgentEntry, result: { ok: boolean; code?: string; fingerprint?: string; error?: string }) {
    if (result.code === 'NEED_TRUST' || result.code === 'CERT_CHANGED') {
      setConfirm({ server, fingerprint: result.fingerprint, code: result.code, message: result.error });
      notify(result.code === 'NEED_TRUST' ? '首次连接需确认证书指纹' : '服务端证书已变更，连接已被阻断', 'err');
    } else if (result.error) {
      notify(failureText(undefined, result.error), 'err');
    }
  }

  async function testEditor() {
    if (!editor) return;
    const draft = { ...editor, id: editingId || undefined };
    const r = await bridge.testServerAgent?.(draft);
    if (!r) { notify('连接测试仅桌面版可用', 'err'); return; }
    if (r.ok) notify('连接测试通过：网络、证书与令牌全部有效');
    else {
      notify('测试失败 — ' + failureText(r.kind, r.error), 'err');
      if ((r.code === 'NEED_TRUST' || r.code === 'CERT_CHANGED') && editor.name) setConfirm({ server: { ...emptyEditor, ...draft } as ServerAgentEntry, draft, fingerprint: r.fingerprint, code: r.code, message: r.error });
    }
  }

  async function saveEditor() {
    if (!editor) return;
    if (!editor.name?.trim() || !editor.host?.trim()) { notify('请填写名称与地址', 'err'); return; }
    const r = await run('save', () => bridge.saveServerAgent!({ ...editor, id: editingId || undefined }), '服务端配置已保存');
    if (r?.ok) { setEditor(null); setEditingId(null); setTokenVisible(false); }
  }

  async function confirmTrust() {
    if (!confirm || busy) return;
    setBusy('trust');
    let id: string;
    try {
      id = await trustServerAgentDraft(bridge, confirm.server.id, confirm.draft, confirm.fingerprint, savedId => {
        setEditingId(savedId);
        setConfirm(current => current ? { ...current, server: { ...current.server, id: savedId }, draft: current.draft ? { ...current.draft, id: savedId } : undefined } : current);
      });
    } catch (e: any) {
      notify(e.message, 'err');
      return;
    } finally {
      setBusy('');
      await refresh(true);
    }
    notify('已信任该证书指纹');
    setConfirm(null);
    if (confirm.draft) { setEditor(null); setEditingId(null); setTokenVisible(false); }
    await run(id, () => bridge.connectServerAgent!(id), '已连接 ' + confirm.server.name);
  }

  async function resetTrust(server: ServerAgentEntry) {
    const r = await run(server.id, () => bridge.resetServerAgentTrust!(server.id), '已清除信任记录，下次连接需重新确认指纹');
    void r;
  }

  async function requestToken() {
    if (!editor || !bridge.requestServerToken) return;
    const target = editor.ssh?.trim() || (editor.host ? 'root@' + editor.host : '');
    if (!target) { notify('请先填写服务端地址及 SSH 用户', 'err'); return; }
    setBusy('token');
    try {
      const result = await bridge.requestServerToken(target);
      if (!result?.ok || !result.token) throw Error(result?.error || '获取令牌失败');
      setEditor({ ...editor, ssh: target, token: result.token });
      notify('已通过免密 SSH 获取访问令牌，请保存服务端配置');
    } catch (e: any) { notify((e.message || 'SSH 连接失败') + '；请先检查免密 SSH 和主机信任配置。', 'err'); }
    finally { setBusy(''); }
  }

  async function runInstall() {
    if (!install.ssh.trim() || install.ssh.endsWith('@')) { notify('请填写免密 SSH 目标', 'err'); return; }
    const result = await run('install', () => bridge.installServerAgent!({ ssh: install.ssh.trim(), port: install.port, dataDir: install.dataDir.trim() || undefined }), '安装完成');
    if (result?.ok) {
      setInstall({ open: false, ssh: '', port: 8787, dataDir: '' });
      setEditingId(null);
      setEditor({ name: result.name || 'ReqFlow Server', host: result.host, port: result.port || 8787, tlsMode: 'pin', autoConnect: false, token: result.token, ssh: result.ssh || install.ssh.trim() });
      setTokenVisible(true);
      notify('服务端数据目录：' + result.dataDir + '；已生成配置草稿，保存后测试连接');
    }
  }

  async function runUninstall(preview: boolean) {
    const result = await run('uninstall', () => bridge.uninstallServerAgent!({ ssh: uninstall.ssh.trim(), serverId: uninstall.serverId || undefined, cleanData: uninstall.cleanData, preview, confirmedDataDir: preview ? undefined : uninstall.previewDataDir }), preview ? '已读取远程部署，请核对卸载范围' : '远程服务端已卸载');
    if (!result?.ok) return;
    if (preview) setUninstall({ ...uninstall, previewDataDir: result.dataDir || '' });
    else {
      setUninstall({ open: false, ssh: '', serverId: '', cleanData: false, previewDataDir: '' });
      notify(result.dataRemoved ? '已卸载服务端并清理数据目录' : '已卸载服务端，数据目录已保留：' + result.dataDir);
    }
  }

  async function runUpdate() {
    if (!update || !update.ssh.trim()) return;
    const result = await run('update-' + update.server.id, () => bridge.updateServerAgent!({ id: update.server.id, ssh: update.ssh.trim() }), 'Server 更新完成，版本与远程 flow 接口检查通过');
    if (result?.ok) {
      setUpdate(null);
      notify('Server 已更新至 ' + result.version + '；数据目录：' + result.dataDir);
      if (result.warning) notify(result.warning, 'err');
    }
  }

  // REQ-251：新增、安装、卸载与配置改为弹出浮层，不在页面底部追加区域
  const closeEditor = () => { setEditor(null); setEditingId(null); setTokenVisible(false); };
  const closeInstall = () => setInstall({ open: false, ssh: '', port: 8787, dataDir: '' });
  const closeUninstall = () => setUninstall({ open: false, ssh: '', serverId: '', cleanData: false, previewDataDir: '' });
  const backdrop = (close: () => void) => (e: { target: EventTarget; currentTarget: EventTarget }) => { if (e.target === e.currentTarget && !busy) close(); };

  return <section className="server-agent-page" aria-label="Server Agent">
    <p className="settings-hint">关联项目后，flow 操作直接由远程服务器执行，配置、需求和步骤保存在服务端 SQLite 中。本地保存已确认结果的备份；中断远程同步后可继续使用本地备份。</p>
    {!bridge.getServerAgents && <p className="settings-message" role="alert">Server Agent 仅桌面版可用。</p>}
    {error && <p className="settings-message" role="alert">{error}</p>}
    <div className="agent-server-list">
      {loaded && !servers.length && <div className="empty agent-empty">还没有远程服务端配置；新增服务端或通过 SSH 自动安装。</div>}
      {servers.map(server => {
        const status = statusLabel(server.status);
        const failure = failureText(server.status?.kind, server.status?.error) || server.status?.lastSyncError || '';
        return <article className={'agent-server-card' + (server.status?.state === 'connected' ? ' connected' : '')} key={server.id}>
          <div className="agent-server-head">
            <Globe size={16} />
            <strong>{server.name}</strong>
            <code>{server.host}:{server.port}</code>
            <span className={'agent-state ' + status.cls}>{status.text}</span>
            <span className="agent-mode">{server.tlsMode === 'ca' ? '受信任 CA' : '自签 + 指纹'}</span>
            {server.autoConnect && <span className="agent-mode">开机自动连接</span>}
          </div>
          <div className="agent-server-meta">
            <span>最近连接：{timeLabel(server.status?.lastConnectedAt)}</span>
            <span>最近备份：{timeLabel(Object.values(server.status?.lastSync || {})[0])}</span>
            {server.status?.version && <span>服务端版本：{server.status.version}</span>}
            <span title={server.fingerprint ? '已信任指纹 ' + formatFingerprint(server.fingerprint) : ''}>{server.trusted ? '已信任证书指纹' : '尚未确认指纹'}</span>
          </div>
          {failure && <p className="agent-server-error" role="alert">{failure}</p>}
          <div className="agent-server-actions">
            <button className="btn sm" disabled={!!busy} onClick={() => server.status?.state === 'connected' ? run(server.id, () => bridge.disconnectServerAgent!(server.id), '已断开 ' + server.name) : connect(server)}>
              {server.status?.state === 'connected' ? '断开' : '连接'}
            </button>
            <button className="btn sm" disabled={!!busy || !bridge.testServerAgent} onClick={async () => {
              const r = await bridge.testServerAgent!({ id: server.id });
              if (r.ok) notify('连接测试通过');
              else { notify('测试失败 — ' + failureText(r.kind, r.error), 'err'); handleProbeResult(server, r); }
            }}>测试连接</button>
            <button className="btn sm" disabled={!!busy} onClick={() => { setEditor({ ...server, token: '' }); setEditingId(server.id); setTokenVisible(false); }}>编辑</button>
            {server.trusted && <button className="btn sm" disabled={!!busy} title="清除已保存的证书指纹，下次连接重新确认" onClick={() => void resetTrust(server)}><ShieldAlert size={14} />重置信任</button>}
            <button className="btn sm" disabled={!!busy || !bridge.updateServerAgent} onClick={() => setUpdate({ server, ssh: server.ssh || '' })}>{busy === 'update-' + server.id ? '更新中…' : '更新 Server'}</button>
            <button className="btn sm" disabled={!!busy} onClick={() => void run(server.id, () => bridge.deleteServerAgent!(server.id), '已删除 ' + server.name)}><Trash size={14} />删除</button>
          </div>
        </article>;
      })}
    </div>

    <div className="settings-actions">
      <button className="btn" disabled={!!busy || !bridge.saveServerAgent} onClick={() => { setAddOpen(true); setInstall({ ...install, open: false }); }}><Plus size={16} />新增服务端</button>
      <button className="btn" disabled={!!busy || !bridge.uninstallServerAgent} onClick={() => setUninstall({ ...uninstall, open: true })}><Trash size={16} />远程卸载…</button>
    </div>

    {addOpen && <div className="overlay" style={{ zIndex: 80 }} role="dialog" aria-modal="true" aria-label="新增服务端" onClick={backdrop(() => setAddOpen(false))}><div className="dialog agent-dialog">
      <div className="dialog-head"><div><h3>新增服务端</h3><p>选择已配置的服务端进行编辑，或新增已有服务端；也可以通过免密 SSH 安装新服务端。</p></div><button type="button" className="icon-btn" aria-label="关闭" onClick={() => setAddOpen(false)}><X size={18} /></button></div>
      <div className="settings-actions">
        {servers.map(server => <button type="button" className="btn" key={server.id} onClick={() => { setEditor({ ...server, token: '' }); setEditingId(server.id); setTokenVisible(false); setAddOpen(false); }}>{server.name}</button>)}
        <button type="button" className="btn" onClick={() => { setEditor({ ...emptyEditor }); setEditingId(null); setTokenVisible(false); setAddOpen(false); }}>配置已有服务端</button>
        <button type="button" className="btn primary" disabled={!bridge.installServerAgent} onClick={() => { setAddOpen(false); setInstall({ ...install, open: true, ssh: 'root@' }); }}><Plus size={16} />SSH 自动安装</button>
      </div>
    </div></div>}

    {install.open && <div className="overlay" style={{ zIndex: 80 }} role="dialog" aria-modal="true" aria-label="SSH 自动安装" onClick={backdrop(closeInstall)}><div className="dialog agent-dialog">
      <div className="dialog-head"><h3>自动安装到免密登录的服务器</h3><button type="button" className="icon-btn" disabled={!!busy} aria-label="关闭" onClick={closeInstall}><X size={18} /></button></div>
      <p className="settings-hint">通过已配置免密（公钥）登录的 SSH 上传 reqflow-server 到 Linux 服务器，自动生成配置与访问令牌，并以 crontab / systemd 方式常驻。要求本机可直连该服务器。</p>
      <div className="settings-columns"><label className="field">SSH 用户名<input value={install.ssh.includes('@') ? install.ssh.split('@')[0] : 'root'} onChange={e => setInstall({ ...install, ssh: e.target.value + '@' + (install.ssh.includes('@') ? install.ssh.split('@').slice(1).join('@') : install.ssh) })} placeholder="root" /></label><label className="field">服务器地址及 SSH 端口<input value={install.ssh.includes('@') ? install.ssh.split('@').slice(1).join('@') : install.ssh} onChange={e => setInstall({ ...install, ssh: (install.ssh.includes('@') ? install.ssh.split('@')[0] : 'root') + '@' + e.target.value })} placeholder="nas.lan 或 192.168.1.10:22" /></label></div>
      <div className="settings-columns">
        <label className="field">服务端端口<input type="number" min={1} max={65535} value={install.port} onChange={e => setInstall({ ...install, port: Number(e.target.value) })} /></label>
        <label className="field">数据目录（可选）<input value={install.dataDir} onChange={e => setInstall({ ...install, dataDir: e.target.value })} placeholder="默认 ~/reqflow-server/data" /></label>
      </div>
      <div className="settings-actions">
        <button className="btn" disabled={!!busy} onClick={closeInstall}>取消</button>
        <button className="btn primary" disabled={!!busy || !install.ssh.trim() || install.ssh.endsWith('@')} onClick={() => void runInstall()}>{busy === 'install' ? '安装中…' : '安装到服务器'}</button>
      </div>
    </div></div>}

    {uninstall.open && <div className="overlay" style={{ zIndex: 80 }} role="dialog" aria-modal="true" aria-label="远程卸载" onClick={backdrop(closeUninstall)}><div className="dialog agent-dialog">
      <div className="dialog-head"><h3>卸载远程 Server Agent</h3><button type="button" className="icon-btn" disabled={!!busy} aria-label="关闭" onClick={closeUninstall}><X size={18} /></button></div>
      <p className="settings-hint">停止服务并移除开机自启、服务端程序和部署配置。默认保留数据。卸载成功后会移除对应配置并让关联项目使用本地备份。</p>
      <label className="field">对应服务端<select value={uninstall.serverId} disabled={!!busy} onChange={e => { const selected = servers.find(s => s.id === e.target.value); setUninstall({ ...uninstall, serverId: e.target.value, ssh: selected ? (selected.ssh || 'root@' + selected.host) : '', previewDataDir: '' }); }}><option value="">手动输入 SSH 目标</option>{servers.map(s => <option key={s.id} value={s.id}>{s.name} · {s.host}</option>)}</select></label>
      <label className="field">SSH 目标<input disabled={!!busy} value={uninstall.ssh} onChange={e => setUninstall({ ...uninstall, ssh: e.target.value, previewDataDir: '' })} placeholder="user@nas.lan 或 user@192.168.1.10:22" /></label>
      <label className="agent-check"><input type="checkbox" disabled={!!busy} checked={uninstall.cleanData} onChange={e => setUninstall({ ...uninstall, cleanData: e.target.checked, previewDataDir: '' })} />同时清理远程数据目录（不可恢复）</label>
      {uninstall.previewDataDir && <p className="agent-preview" role="alert">{uninstall.cleanData ? '将永久清理' : '将保留'}数据目录：<code>{uninstall.previewDataDir}</code></p>}
      <div className="settings-actions">
        <button type="button" className="btn" disabled={!!busy} onClick={closeUninstall}>取消</button>
        <button type="button" className={'btn' + (uninstall.previewDataDir ? '' : ' primary')} disabled={!!busy || !uninstall.ssh.trim()} onClick={() => void runUninstall(true)}>检查卸载范围</button>
        {uninstall.previewDataDir && <button type="button" className={'btn primary' + (uninstall.cleanData ? ' danger' : '')} disabled={!!busy} onClick={() => void runUninstall(false)}>{busy === 'uninstall' ? '处理中…' : uninstall.cleanData ? '确认卸载并清理数据' : '确认卸载并保留数据'}</button>}
      </div>
    </div></div>}

    {editor && <div className="overlay" style={{ zIndex: 80 }} role="dialog" aria-modal="true" aria-label={editingId ? '编辑服务端' : '配置服务端'} onClick={backdrop(closeEditor)}><form className="dialog agent-dialog" onSubmit={e => { e.preventDefault(); void saveEditor(); }}>
      <div className="dialog-head"><h3>{editingId ? '编辑服务端' : '配置已有服务端'}</h3><button type="button" className="icon-btn" disabled={!!busy} aria-label="关闭" onClick={closeEditor}><X size={18} /></button></div>
      <label className="field">名称<input value={editor.name || ''} autoFocus onChange={e => setEditor({ ...editor, name: e.target.value })} placeholder="如 家庭 NAS" /></label>
      <div className="settings-columns">
        <label className="field">地址<input value={editor.host || ''} onChange={e => setEditor({ ...editor, host: e.target.value })} placeholder="nas.lan 或 192.168.1.10" /></label>
        <label className="field">端口<input type="number" min={1} max={65535} value={editor.port || 8787} onChange={e => setEditor({ ...editor, port: Number(e.target.value) })} /></label>
      </div>
      <div className="field"><span>证书模式</span>
        <div className="segmented" role="group" aria-label="证书模式">
          {([['pin', '自签 + 指纹确认'], ['ca', '受信任 CA 证书']] as const).map(([id, label]) =>
            <button type="button" key={id} aria-pressed={(editor.tlsMode || 'pin') === id} className={(editor.tlsMode || 'pin') === id ? 'on' : ''} onClick={() => setEditor({ ...editor, tlsMode: id })}>{label}</button>)}
        </div>
      </div>
      <label className="field">SSH 目标<input value={editor.ssh || (editor.host ? 'root@' + editor.host : '')} onChange={e => setEditor({ ...editor, ssh: e.target.value })} placeholder="root@服务器地址，可修改用户名和端口" /></label>
      <div className="settings-actions"><button type="button" className="btn" disabled={!!busy || !bridge.requestServerToken || !editor.host?.trim()} onClick={() => void requestToken()}>{busy === 'token' ? '获取中…' : '通过免密 SSH 获取访问令牌'}</button></div>
      <label className="field">访问令牌<div className="input-action">
        <input autoComplete="off" type={tokenVisible ? 'text' : 'password'} value={editor.token || ''} onChange={e => setEditor({ ...editor, token: e.target.value })} placeholder={editingId ? '留空保留已保存的令牌' : '服务端 server token 命令输出的令牌'} />
        <button type="button" className="icon-btn" aria-label={tokenVisible ? '隐藏令牌' : '显示令牌'} aria-pressed={tokenVisible} onClick={() => setTokenVisible(!tokenVisible)}><Eye />{tokenVisible && <span className="eye-slash" />}</button>
      </div></label>
      <div className="validation-setting"><div><label htmlFor={'agent-auto-' + (editingId || 'new')}>开机自动连接</label><p>ReqFlow 启动时自动连接该服务端，定期更新本地备份。</p></div>
        <label className="switch"><input id={'agent-auto-' + (editingId || 'new')} type="checkbox" checked={!!editor.autoConnect} onChange={e => setEditor({ ...editor, autoConnect: e.target.checked })} /><span className="slider" /><span className="switch-state">{editor.autoConnect ? '已开启' : '已关闭'}</span></label></div>
      <div className="settings-actions">
        <button type="button" className="btn" disabled={!!busy || !bridge.testServerAgent || !editor.host?.trim()} onClick={() => void testEditor()}>测试连接</button>
        <button type="button" className="btn" disabled={!!busy} onClick={closeEditor}>取消</button>
        <button className="btn primary" disabled={!!busy}>{busy === 'save' ? '保存中…' : '保存服务端'}</button>
      </div>
    </form></div>}

    {update && <div className="overlay" role="dialog" aria-modal="true" aria-label="更新 Server" style={{ zIndex: 80 }}>
      <div className="dialog">
        <div className="dialog-head"><h3>更新 Server · {update.server.name}</h3><button type="button" className="icon-btn" disabled={!!busy} aria-label="关闭" onClick={() => setUpdate(null)}><X size={18} /></button></div>
        <p className="settings-hint">通过免密 SSH 更新 {update.server.host}:{update.server.port} 的服务端程序，并短暂重启服务。使用原有令牌、证书、端口和数据目录，完成后检查服务端版本及远程 flow 接口。</p>
        <label className="field">原部署的 SSH 目标<input disabled={!!busy} value={update.ssh} onChange={e => setUpdate({ ...update, ssh: e.target.value })} placeholder="如 root@nas.lan 或 user@nas.lan:2222" /></label>
        <p className="settings-hint">请填写原来安装 Server 的 SSH 用户和端口，例如 root@{update.server.host}。只填 IP 会使用 SSH 配置或本机用户名，可能导致认证失败；更新成功后会记住该目标。</p>
        <div className="settings-actions">
          <button type="button" className="btn" disabled={!!busy} onClick={() => setUpdate(null)}>取消</button>
          <button type="button" className="btn primary" disabled={!!busy || !update.ssh.trim()} onClick={() => void runUpdate()}>{busy === 'update-' + update.server.id ? '更新并检查中…' : '更新 Server'}</button>
        </div>
      </div>
    </div>}

    {confirm && <div className="overlay" role="dialog" aria-modal="true" aria-label="确认服务端证书指纹" style={{ zIndex: 80 }}>
      <div className="dialog">
        <div className="dialog-head">
          <div>
            <h3>{confirm.code === 'CERT_CHANGED' ? '服务端证书已变更' : '首次连接 · 确认证书指纹'}</h3>
            <p>{confirm.code === 'CERT_CHANGED'
              ? '已信任的「' + confirm.server.name + '」指纹发生变化，为防止中间人攻击已阻断连接。请确认是服务器重签证书后，重置信任并确认新指纹。'
              : '请核对「' + confirm.server.name + '」返回的证书指纹与服务端 server run 日志中的指纹一致后，再建立信任。'}</p>
          </div>
          <button className="icon-btn" aria-label="关闭" onClick={() => setConfirm(null)}><X size={18} /></button>
        </div>
        <p className="agent-fingerprint" title={confirm.fingerprint || ''}>{formatFingerprint(confirm.fingerprint)}</p>
        {confirm.message && <p className="settings-hint">{confirm.message}</p>}
        <div className="settings-actions">
          <button className="btn" onClick={() => setConfirm(null)}>取消</button>
          <button className="btn primary" disabled={!!busy} onClick={() => void confirmTrust()}><Check size={15} />{busy === 'trust' ? '确认中…' : confirm.code === 'CERT_CHANGED' ? '重置并确认新指纹' : '信任并连接'}</button>
        </div>
      </div>
    </div>}
  </section>;
}
