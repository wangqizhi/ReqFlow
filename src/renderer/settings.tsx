import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { bridge } from './api';
import type { AISettings, AIRequestLog, AICLIStatus, AIProviderCLI, AIReasoningEffort } from '../core/ai';
import type { PublishRequestLog } from '../core/publish-log';
import { emptyBackup, type BackupSettings, type BackupStatus, type RemoteSettings } from '../core/remote';
import { DEFAULT_BASELINE_TEMPLATE, DEFAULT_PUBLISH_TEMPLATE } from '../core/domain';
import { Eye, FolderOpen, Download, Plus, Trash } from './icons';

export const settingsTabs = [['ai', 'AI 供应商'], ['template', '需求模板'], ['backup', '同步备份'], ['logs', '请求日志'], ['data', '数据']] as const;
const cliNames = { codex: 'Codex', zcode: 'ZCode', pi: 'Pi', claude: 'Claude Code' };

type DataUsage = { dataDir: string; backend: string; dirSize: number; databasePath: string; databaseSize: number };

function formatSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return (unit === 0 ? String(value) : value.toFixed(1)) + ' ' + units[unit];
}

/** 数据用量与归档（REQ-112）：大小每 2 秒刷新，归档后立即能看到清理效果。 */
function DataSettings({ notify, onArchived, onExport }: { notify(text: string, kind?: 'ok' | 'err'): void; onArchived?(): void; onExport(): Promise<void> }) {
  const [contextDir, setContextDir] = useState('');
  const [contextMoving, setContextMoving] = useState(false);
  useEffect(() => { void bridge.getContextSettings?.().then(r => { if (r.ok) setContextDir(r.dir || ''); }); }, []);
  const [usage, setUsage] = useState<DataUsage | null>(null);
  const [usageError, setUsageError] = useState('');
  const [date, setDate] = useState('');
  const [preview, setPreview] = useState<{ items: number; batches: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [message, setMessage] = useState('');
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    if (!bridge.getDataUsage) { setUsageError('数据大小统计仅桌面版可用'); return; }
    const refresh = () => bridge.getDataUsage!().then((r) => {
      if (!r.ok) throw Error(r.error || '统计数据大小失败');
      setUsage({ dataDir: r.dataDir!, backend: r.backend!, dirSize: r.dirSize || 0, databasePath: r.databasePath!, databaseSize: r.databaseSize || 0 });
      setUsageError('');
    }).catch((e: any) => setUsageError(e.message));
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setConfirming(false);
    setMessage(''); setPreview(null);
    if (!date) { setPreview(null); return; }
    if (!bridge.previewDataArchive) return;
    let cancelled = false;
    bridge.previewDataArchive(date).then((r) => {
      if (cancelled) return;
      if (!r.ok) { setPreview(null); setMessage(r.error || '统计归档数据失败'); return; }
      setPreview({ items: r.items || 0, batches: r.batches || 0 });
    }).catch(() => { if (!cancelled) setPreview(null); });
    return () => { cancelled = true; };
  }, [date]);
  async function archive(mode: 'export' | 'clear') {
    const operation = mode === 'export' ? bridge.exportArchivedData : bridge.clearArchivedData;
    if (archiving || !date || !operation) return;
    setArchiving(true); setMessage('');
    try {
      const r = await operation(date);
      if (!r.ok) throw Error(r.error || '数据归档失败');
      if (!('canceled' in r && r.canceled)) {
        setConfirming(false);
        const counts = `${r.items || 0} 条需求、${r.batches || 0} 个批次`;
        setMessage(mode === 'export' ? ('file' in r && r.file ? `已导出 ${counts} 到 ${r.file}。` : '没有可导出的归档数据。') : `已清理 ${counts}。`);
        notify(mode === 'export' ? '归档导出完成' : '归档清理完成');
        if (mode === 'clear') { setPreview({ items: 0, batches: 0 }); onArchived?.(); }
      }
    } catch (e: any) { setMessage(e.message); notify(e.message, 'err'); }
    finally { setArchiving(false); }
  }
  return <>
    <div className="data-archive-section"><h3>上下文数据目录</h3><label className="field">目录<input value={contextDir} disabled={contextMoving} onChange={e => setContextDir(e.target.value)} /></label><p className="settings-hint">上下文以 JSON 和 Markdown 保存在此目录；系统存在 Git 时每次更新自动提交。迁移到空目录，原目录保留为恢复副本，工作区保留关联索引。</p><div className="settings-actions"><button className="btn" disabled={contextMoving || !bridge.pickDir} onClick={async () => { const dir = await bridge.pickDir?.(); if (dir?.ok && dir.dir) setContextDir(dir.dir); }}><FolderOpen size={16} />选择目录</button><button className="btn primary" disabled={contextMoving || !contextDir.trim() || !bridge.saveContextSettings} onClick={async () => { setContextMoving(true); try { const r = await bridge.saveContextSettings!(contextDir); if (!r.ok) throw Error(r.error || '迁移失败'); setContextDir(r.dir || contextDir); notify('上下文目录已迁移，原目录保留为恢复副本'); } catch (e: any) { notify(e.message, 'err'); } finally { setContextMoving(false); } }}>{contextMoving ? '迁移中…' : '保存并迁移上下文'}</button></div></div>
    <div className="data-export-section"><div><h3>完整数据备份</h3><p className="settings-hint">导出全部项目、需求、上下文与历史记录为 JSON 文件，便于备份或迁移。</p></div><button className="btn primary" disabled={exporting} onClick={async () => { setExporting(true); try { await onExport(); } catch (e: any) { notify(e.message, 'err'); } finally { setExporting(false); } }}><Download size={16} />{exporting ? '正在导出…' : '导出全部数据'}</button></div>
    <p className="settings-hint" title={usage?.dataDir}>{usage?.dataDir || usageError || '读取中…'}</p>
    <div className="validation-setting"><div><label>数据目录总大小</label><p>目录内全部文件（含图片附件、日志与备份配置）</p></div><span>{usage ? formatSize(usage.dirSize) : '—'}</span></div>
    <div className="validation-setting"><div><label>{usage?.backend === 'sqlite' ? 'SQLite 数据库大小' : '工作区文件大小'}</label><p title={usage?.databasePath}>{usage?.backend === 'sqlite' ? 'requirements.sqlite 实时大小，清理后立即变小' : 'workspace.json 当前大小'}</p></div><span>{usage ? formatSize(usage.databaseSize) : '—'}</span></div>
    <div className="data-archive-section">
      <div className="validation-setting"><div><label>数据归档</label><p>处理归档时间早于所选日期的已归档需求（含历史）与不再被排期引用的历史批次。导出会保存 JSON 文件，清理会从工作区删除这些内容。</p></div></div>
      <div className="settings-actions data-archive-actions">
        <label className="field archive-date"><input type="date" aria-label="归档日期" disabled={archiving} value={date} onChange={(e) => setDate(e.target.value)} max={new Date().toISOString().slice(0, 10)} /></label>
        <button className="btn primary" disabled={!date || archiving || !bridge.exportArchivedData} onClick={() => void archive('export')}>导出归档</button>
        {!confirming ? <button className="btn danger" disabled={!date || archiving || !bridge.clearArchivedData} onClick={() => setConfirming(true)}>清理归档…</button>
          : <>
            <button className="btn danger" disabled={archiving} onClick={() => void archive('clear')}>{archiving ? '处理中…' : '确认清理'}</button>
            <button className="btn" disabled={archiving} onClick={() => setConfirming(false)}>取消</button>
          </>}
      </div>
      {date && preview && <p className="settings-hint">所选范围内有 {preview.items} 条已归档需求、{preview.batches} 个历史批次；没有可归档数据时不会生成文件。</p>}
      {confirming && <p className="settings-message" role="alert">清理后无法恢复，请先导出需要保留的归档数据，再确认清理。</p>}
      {message && <p className="settings-message" role="status">{message}</p>}
    </div>
  </>;
}

export function RemoteFields({ value, change, disabled }: { value: RemoteSettings; change(v: RemoteSettings): void; disabled: boolean }) {
  return <fieldset className="remote-fields" disabled={disabled}>
    <div className="segmented" role="group" aria-label="仓库平台">{(['github', 'gitlab'] as const).map((provider) => <button key={provider} type="button" aria-pressed={value.provider === provider} className={value.provider === provider ? 'on' : ''} onClick={() => change({ ...value, provider })}>{provider === 'github' ? 'GitHub' : 'GitLab'}</button>)}</div>
    <label className="field">仓库地址<input value={value.url} onChange={(e) => change({ ...value, url: e.target.value })} placeholder="git@github.com:owner/repo.git 或 HTTPS 地址" /></label>
    <div className="settings-columns"><label className="field">分支<input value={value.branch} onChange={(e) => change({ ...value, branch: e.target.value })} /></label>
      <label className="field">SSH Key 文件<div className="input-action"><input value={value.sshKeyPath} onChange={(e) => change({ ...value, sshKeyPath: e.target.value })} placeholder="留空使用系统 SSH 配置" /><button type="button" className="icon-btn" aria-label="选择 SSH 私钥" disabled={!bridge.pickSSHKey} onClick={async () => { const r = await bridge.pickSSHKey?.(); if (r?.path) change({ ...value, sshKeyPath: r.path }); }}><FolderOpen /></button></div></label></div>
  </fieldset>;
}

export type SettingsPageHandle = { requestLeave(): void };
function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
}
export const SettingsPage = forwardRef<SettingsPageHandle, { tab: string; notify(text: string, kind?: 'ok' | 'err'): void; onArchived?(): void; onExport(): Promise<void>; onBusyChange(busy: boolean): void; onLeave(): void }>(function SettingsPage({ tab, notify, onArchived, onExport, onBusyChange, onLeave }, ref) {
  const [form, setForm] = useState<AISettings>({ provider: '', url: '', apiKey: '' });
  const [backup, setBackup] = useState<BackupSettings>({ ...emptyBackup });
  const [status, setStatus] = useState<BackupStatus>({ running: false });
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [backupLoaded, setBackupLoaded] = useState(false);
  const [importConfirm, setImportConfirm] = useState(false);
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState('');
  const [cliStatuses, setCLIStatuses] = useState<AICLIStatus[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState('');
  const [modelPicker, setModelPicker] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [savedAI, setSavedAI] = useState('');
  const [savedBackup, setSavedBackup] = useState('');
  const [savedTemplates, setSavedTemplates] = useState({ baseline: '', publish: '' });
  const [savedPublishLogging, setSavedPublishLogging] = useState(true);
  const profiles = form.profiles || [];
  function draftProfiles(): AISettings[] {
    const { profiles: _, activeProfileId: __, ...current } = form;
    return profiles.map(profile => profile.id === form.activeProfileId ? current : profile);
  }
  function configuration(): AISettings { return { ...form, profiles: draftProfiles() }; }
  const selectedCLI = cliStatuses.find(status => status.id === form.cli);
  const cliModels = selectedCLI?.models || [];
  const selectedModel = cliModels.find(model => model.id === form.model);
  const reasoningLabels: Record<AIReasoningEffort, string> = { none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: '超高' };
  const reasoningLevels = selectedModel?.reasoningEfforts || [];
  function chooseProfile(id: string) {
    const drafts = draftProfiles(); const profile = drafts.find(profile => profile.id === id);
    if (profile) { setForm({ ...profile, profiles: drafts, activeProfileId: id, requestLogging: form.requestLogging }); setVisible(false); setMessage(''); }
  }
  function addProfile() {
    const profile: AISettings = { id: crypto.randomUUID(), provider: '新配置', kind: 'api', url: '', apiKey: '', format: 'openai', model: '' };
    setForm({ ...profile, profiles: [...draftProfiles(), profile], activeProfileId: profile.id, requestLogging: form.requestLogging }); setVisible(false);
  }
  function removeProfile() {
    const remaining = draftProfiles().filter(profile => profile.id !== form.activeProfileId);
    if (remaining.length) { setForm({ ...remaining[0], profiles: remaining, activeProfileId: remaining[0].id, requestLogging: form.requestLogging }); setVisible(false); }
  }
  async function detectCLIs() {
    if (!bridge.detectAIProviderCLIs || detecting) return;
    setDetecting(true); setDetectError('');
    try { const r = await bridge.detectAIProviderCLIs(); if (!r.ok) throw Error(r.error || 'CLI 检测失败'); setCLIStatuses(r.agents || []); }
    catch (e: any) { setDetectError(e.message); }
    finally { setDetecting(false); }
  }
  useEffect(() => { void detectCLIs(); }, []);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => { setMessage(''); setImportConfirm(false); }, [tab]);
  useEffect(() => {
    if (!importConfirm || busy) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setImportConfirm(false); } };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [importConfirm, busy]);
  const [logs, setLogs] = useState<AIRequestLog[]>([]);
  const [logError, setLogError] = useState('');
  const [logKind, setLogKind] = useState('ai');
  const [publishLogs, setPublishLogs] = useState<PublishRequestLog[]>([]);
  const [publishLogError, setPublishLogError] = useState('');
  const [publishLogging, setPublishLogging] = useState(true);
  const [publishLogLoaded, setPublishLogLoaded] = useState(false);
  const [baselineTpl, setBaselineTpl] = useState(''); // 全局基准需求模板（REQ-071）
  const [publishTpl, setPublishTpl] = useState('');
  const [templateKind, setTemplateKind] = useState('baseline');
  const [templateVersion, setTemplateVersion] = useState<number | null>(null); // 保存时做乐观并发校验
  useEffect(() => {
    bridge.getWorkspace().then((r) => {
      if (!r.ok) return;
      // REQ-071 验证退回：默认模板要直接预填成可编辑的正文，而不是灰色占位文字
      setBaselineTpl(r.state.baselineTemplate || DEFAULT_BASELINE_TEMPLATE);
      setPublishTpl(r.state.publishTemplate || DEFAULT_PUBLISH_TEMPLATE);
      setSavedTemplates({ baseline: r.state.baselineTemplate || DEFAULT_BASELINE_TEMPLATE, publish: r.state.publishTemplate || DEFAULT_PUBLISH_TEMPLATE });
      setTemplateVersion(r.version);
    }).catch(() => { /* 读取失败时模板tab仍可查看，保存时报错 */ });
  }, []);
  useEffect(() => {
    if (tab !== 'logs') return;
    let cancelled = false;
    const refresh = async () => {
      await Promise.allSettled([
        (async () => {
          try { const r = await bridge.getAIRequestLogs?.(); if (cancelled) return; if (!r?.ok) throw Error(r?.error || '请求日志仅桌面版可用'); setLogs(r.entries || []); setLogError(''); }
          catch (e: any) { if (!cancelled) setLogError(e.message); }
        })(),
        (async () => {
          try { const r = await bridge.getPublishRequestLogs?.(); if (cancelled) return; if (!r?.ok) throw Error(r?.error || '发布日志仅桌面版可用'); setPublishLogs(r.entries || []); setPublishLogError(''); }
          catch (e: any) { if (!cancelled) setPublishLogError(e.message); }
        })(),
      ]);
    };
    void refresh(); const timer = setInterval(refresh, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [tab]);
  useEffect(() => {
    bridge.getAISettings().then((r) => {
      if (!r.ok) throw Error(r.error);
      const settings = r.settings;
      let next = settings;
      if (!settings.profiles?.length) { const id = settings.id || crypto.randomUUID(); const profile = { ...settings, id }; next = { ...profile, profiles: [profile], activeProfileId: id }; }
      setForm(next);
      const { profiles: _, activeProfileId: __, ...current } = next;
      setSavedAI(fingerprint({ ...next, profiles: next.profiles!.map(profile => profile.id === next.activeProfileId ? current : profile) }));
      setLoaded(true);
    }).catch((e) => notify(e.message, 'err'));
    bridge.getPublishLogSettings?.().then((r) => { if (!r.ok || !r.settings) throw Error(r.error || '读取发布日志设置失败'); setPublishLogging(r.settings.enabled); setSavedPublishLogging(r.settings.enabled); setPublishLogLoaded(true); }).catch((e) => notify(e.message, 'err'));
    bridge.getBackupSettings?.().then((r) => { if (r.ok) { setBackup(r.settings); setSavedBackup(fingerprint(r.settings)); setStatus(r.status); setBackupLoaded(true); } }).catch((e) => notify(e.message, 'err'));
    const timer = setInterval(() => bridge.getBackupSettings?.().then((r) => { if (r.ok) setStatus(r.status); }).catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, []);
  async function perform(action: () => Promise<any>, success: string): Promise<boolean> {
    setBusy(true); setMessage('');
    try { const r = await action(); if (!r?.ok) throw Error(r?.error || '操作失败'); setMessage(success); notify(success); return true; }
    catch (e: any) { setMessage(e.message); notify(e.message, 'err'); return false; }
    finally { setBusy(false); }
  }
  async function importRemoteBackup() {
    if (busy || !bridge.importBackup) return;
    let summary = '';
    const success = await perform(async () => {
      const result = await bridge.importBackup!(backup);
      if (result.settings) { setBackup(result.settings); setSavedBackup(fingerprint(result.settings)); }
      if (result.status) setStatus(result.status);
      if (result.ok) summary = '已从远端导入 ' + (result.projects || 0) + ' 个新项目、' + (result.items || 0) + ' 条新需求；已有内容保留。';
      return result;
    }, '远端备份导入完成');
    if (success) { setImportConfirm(false); setMessage(summary); onArchived?.(); }
  }
  // 各分类共用固定底部保存按钮，保存后继续停留在设置工作台。
  // 数据 tab（REQ-112）无保存项，操作即时生效
  const tabReady = tab === 'ai' ? loaded
    : tab === 'template' ? templateVersion !== null
    : tab === 'logs' ? loaded && (!bridge.savePublishLogSettings || publishLogLoaded)
    : tab === 'data' ? true
    : backupLoaded && !status.running;
  async function saveCurrentTab(): Promise<boolean> {
    if (tab === 'ai') return perform(async () => { const r = await bridge.saveAISettings(configuration()); if (r.ok) setSavedAI(fingerprint(configuration())); return r; }, 'AI 配置已保存，当前供应商已生效');
    if (tab === 'template') return perform(async () => {
      const r = await bridge.apply({ op: templateKind === 'publish' ? 'globalPublishTemplate' : 'globalBaselineTemplate', text: templateKind === 'publish' ? publishTpl : baselineTpl, expectedVersion: templateVersion === null ? undefined : templateVersion });
      if (!r.ok) throw Error(r.error || '保存失败');
      setTemplateVersion(r.version);
      setSavedTemplates(previous => ({ ...previous, [templateKind]: templateKind === 'publish' ? publishTpl : baselineTpl }));
      return r;
    }, templateKind === 'publish' ? '全局发布模板已保存' : '全局基准模板已保存');
    if (tab === 'logs') return perform(async () => {
      const aiResult = await bridge.saveAISettings(configuration());
      if (!aiResult.ok) return aiResult;
      setSavedAI(fingerprint(configuration()));
      const r = bridge.savePublishLogSettings ? await bridge.savePublishLogSettings({ enabled: publishLogging }) : aiResult;
      if (r.ok) setSavedPublishLogging(publishLogging);
      return r;
    }, '日志设置已保存');
    if (tab === 'data') return true;
    return perform(async () => { const r = await bridge.saveBackupSettings!(backup); if (r.ok) setSavedBackup(fingerprint(backup)); return r; }, '备份设置已保存');
  }
  async function saveAndFinish() {
    await saveCurrentTab();
  }
  const aiDirty = loaded && fingerprint(configuration()) !== savedAI;
  const backupDirty = backupLoaded && fingerprint(backup) !== savedBackup;
  const templateDirty = templateVersion !== null && (baselineTpl !== savedTemplates.baseline || publishTpl !== savedTemplates.publish);
  const logDirty = publishLogLoaded && publishLogging !== savedPublishLogging;
  const dirty = aiDirty || backupDirty || templateDirty || logDirty;
  useImperativeHandle(ref, () => ({ requestLeave() { if (busy) return; if (dirty) setLeaveConfirm(true); else onLeave(); } }));
  useEffect(() => {
    if (!leaveConfirm || busy) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setLeaveConfirm(false); } };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [leaveConfirm, busy]);
  async function saveAllAndLeave() {
    if (busy) return;
    const success = await perform(async () => {
      if (aiDirty) { const r = await bridge.saveAISettings(configuration()); if (!r.ok) return r; setSavedAI(fingerprint(configuration())); }
      if (templateDirty) {
        let version = templateVersion;
        for (const [kind, text, saved] of [['baseline', baselineTpl, savedTemplates.baseline], ['publish', publishTpl, savedTemplates.publish]]) {
          if (text === saved) continue;
          const r = await bridge.apply({ op: kind === 'publish' ? 'globalPublishTemplate' : 'globalBaselineTemplate', text, expectedVersion: version });
          if (!r.ok) return r;
          version = r.version; setTemplateVersion(version); setSavedTemplates(previous => ({ ...previous, [kind]: text }));
        }
      }
      if (backupDirty) { const r = await bridge.saveBackupSettings!(backup); if (!r.ok) return r; setSavedBackup(fingerprint(backup)); }
      if (logDirty) { const r = await bridge.savePublishLogSettings!({ enabled: publishLogging }); if (!r.ok) return r; setSavedPublishLogging(publishLogging); }
      return { ok: true };
    }, '设置已保存');
    if (success) onLeave();
  }
  return <section className="settings-page" aria-label="设置">
      <div className="settings-page-head"><div className="eyebrow">SETTINGS</div><h1>{settingsTabs.find(([id]) => id === tab)?.[1]}</h1><p>配置 AI、需求模板、同步备份与本机数据</p></div>
      <div className="settings-body">
        {tab === 'ai' && <form onSubmit={(e) => { e.preventDefault(); if (!busy && tabReady) void saveAndFinish(); }}>
          <p className="settings-hint">用于 AI 需求整理、建议讨论与 Git 提交文案。AI 配置独立保存在本机，不同步到远程仓库。</p>
          <div className="ai-profile-toolbar"><div className="ai-profile-list" role="group" aria-label="AI 配置">{profiles.map(profile => <button className={'tag-btn' + (form.activeProfileId === profile.id ? ' on' : '')} type="button" key={profile.id} disabled={busy || !loaded} aria-pressed={form.activeProfileId === profile.id} onClick={() => chooseProfile(profile.id!)}>{form.activeProfileId === profile.id ? form.provider || '未命名配置' : profile.provider || '未命名配置'}</button>)}</div><button type="button" className="btn" disabled={busy || !loaded || profiles.length >= 50} onClick={addProfile}><Plus size={16} />新增配置</button><button type="button" className="btn" disabled={busy || !loaded || profiles.length < 2} onClick={removeProfile}><Trash size={16} />删除配置</button></div>
          <p className="settings-hint">选择配置后点击「保存设置」切换供应商；切换前的编辑会保留在本页，返回项目菜单前请保存。</p>
          <label className="field">配置名称<input value={form.provider} disabled={busy || !loaded} onChange={(e) => setForm({ ...form, provider: e.target.value })} placeholder="如工作 API、个人 Codex" /></label>
          <div className="field"><span>调用方式</span><div className="segmented" role="group" aria-label="AI 调用方式">{(['api', 'cli'] as const).map(kind => <button key={kind} type="button" disabled={busy || !loaded} aria-pressed={(form.kind || 'api') === kind} className={(form.kind || 'api') === kind ? 'on' : ''} onClick={() => setForm({ ...form, kind, model: kind !== form.kind ? '' : form.model, cli: form.cli || 'codex' })}>{kind === 'api' ? 'API 服务' : '本地 CLI'}</button>)}</div></div>
          {form.kind !== 'cli' ? <>
          <div className="field"><span>API 格式</span><div className="segmented" role="group" aria-label="API 格式" data-api-format="true">{(['openai', 'anthropic'] as const).map((format) => <button key={format} type="button" disabled={busy || !loaded} aria-pressed={(form.format || 'openai') === format} className={(form.format || 'openai') === format ? 'on' : ''} onClick={() => setForm({ ...form, format })}>{format === 'openai' ? 'OpenAI' : 'Anthropic'}</button>)}</div></div>
          <label className="field">调用 URL<input type="url" value={form.url} disabled={busy || !loaded} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://api.example.com/v1" /></label>
          <label className="field">模型名称 · 可填写或修改<input aria-label="模型名称" value={form.model || ''} disabled={busy || !loaded} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="例如 deepseek-flash" /></label>
          <label className="field">API Key<div className="input-action"><input autoComplete="off" type={visible ? 'text' : 'password'} value={form.apiKey} disabled={busy || !loaded} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /><button type="button" className="icon-btn" aria-label={visible ? '隐藏 API Key' : '显示 API Key'} aria-pressed={visible} onClick={() => setVisible(!visible)}><Eye />{visible && <span className="eye-slash" />}</button></div></label>
          </> : <>
            <div className="cli-detection-head"><h3>本地 CLI</h3><button className="btn" type="button" disabled={detecting || !bridge.detectAIProviderCLIs} onClick={() => void detectCLIs()}>{detecting ? '检测中…' : '重新检测'}</button></div>
            {!bridge.detectAIProviderCLIs && <p className="settings-hint">本地 CLI 检测与生成仅桌面版可用。</p>}
            {detectError && <p className="settings-message" role="alert">{detectError}</p>}
            <div className="cli-provider-list" role="group" aria-label="CLI 供应商">{(Object.keys(cliNames) as AIProviderCLI[]).map(id => {
              const status = cliStatuses.find(status => status.id === id);
              return <button type="button" className={'cli-provider-card' + (form.cli === id ? ' on' : '')} key={id} disabled={busy || !loaded} aria-pressed={form.cli === id} onClick={() => { if (id !== form.cli) { setForm({ ...form, cli: id, model: '', reasoningEffort: 'none' }); setModelPicker(false); } }}><strong>{cliNames[id]}</strong><span>{status?.installed ? `已安装 ${status.version || ''}` : detecting ? '检测中…' : status?.error || '尚未检测'}</span>{status?.path && <small title={status.path}>{status.path}</small>}{status?.usage?.map(usage => <small key={usage.label}>{usage.label}：{usage.usedPercent.toFixed(1)}% · 本地快照 {new Date(usage.updatedAt).toLocaleString('zh-CN')} · 重置 {new Date(usage.resetsAt * 1000).toLocaleString('zh-CN')}</small>)}</button>;
            })}</div>
            <label className="field">模型名称 · 可选<input aria-label="CLI 模型名称" value={form.model || ''} disabled={busy || !loaded} onChange={e => setForm({ ...form, model: e.target.value, reasoningEffort: 'none' })} placeholder="留空使用 CLI 默认模型" /></label>
            {!!cliModels.length && <div className="cli-model-picker" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setModelPicker(false); }}>
              <button className="btn" type="button" disabled={busy || !loaded} aria-expanded={modelPicker} aria-controls="cli-model-list" onClick={() => { setModelSearch(''); setModelPicker(!modelPicker); }}>选择可用模型（{cliModels.length}）</button>
              {modelPicker && <div className="cli-model-list" id="cli-model-list" role="group" aria-label="可用 CLI 模型" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setModelPicker(false); } }}>
                <label className="field"><input autoFocus aria-label="筛选 CLI 模型" placeholder="输入模型或供应商名称筛选" value={modelSearch} onChange={e => setModelSearch(e.target.value)} /></label>
                <button type="button" className="tag-btn" aria-pressed={!form.model} onClick={() => { setForm({ ...form, model: '', reasoningEffort: 'none' }); setModelPicker(false); }}>CLI 默认模型</button>
                {cliModels.filter(model => !modelSearch || (model.id + ' ' + model.name).toLowerCase().includes(modelSearch.toLowerCase())).map(model => <button type="button" className="tag-btn" key={model.id} aria-pressed={form.model === model.id} title={model.id} onClick={() => { setForm({ ...form, model: model.id, reasoningEffort: 'none' }); setModelPicker(false); }}>{model.name}</button>)}
              </div>}
            </div>}
            <p className="settings-hint">{detecting ? '正在读取可用模型…' : selectedCLI?.modelsNote || '未读取到模型列表，可留空使用 CLI 默认模型或手工填写。'}</p>
            {!!reasoningLevels.length && <div className="field"><span>思考等级</span><div className="segmented" role="group" aria-label="CLI 思考等级">{(['none', ...reasoningLevels.filter(level => level !== 'none')] as AIReasoningEffort[]).map(level => <button key={level} className={(form.reasoningEffort || 'none') === level ? 'on' : ''} type="button" disabled={busy || !loaded} aria-pressed={(form.reasoningEffort || 'none') === level} onClick={() => setForm({ ...form, reasoningEffort: level })}>{reasoningLabels[level]}</button>)}</div>{!reasoningLevels.includes('none') && <p className="settings-hint">此模型不能完全关闭思考；选择关闭时使用模型支持的最低等级。</p>}</div>}
            <p className="settings-hint">复用本机 CLI 登录与供应商配置。请先在终端完成登录；选择后保存即可用于所有 AI 优化与内容生成。仅显示可读取的周/月额度快照。</p>
          </>}
        </form>}
        {tab === 'template' && <form onSubmit={(e) => {
          e.preventDefault();
          if (!busy && tabReady) void saveAndFinish();
        }}>
          <div className="segmented" role="group" aria-label="需求模板类型">{[['baseline', '基线需求'], ['publish', '发布功能需求']].map(([id, label]) => <button type="button" key={id} disabled={busy} aria-pressed={templateKind === id} className={templateKind === id ? 'on' : ''} onClick={() => { setTemplateKind(id); setMessage(''); }}>{label}</button>)}</div>
          <p className="settings-hint">{templateKind === 'publish' ? '「记录新需求 → 发布功能需求」使用这里的模板。发布入口应调用用户部署脚本；没有部署配置时先确认目标位置和部署细节。' : '「记录新需求 → 基线需求」用这里的模板预填一条需求。优先级：项目模板 > 全局模板 > 内置默认模板。'}</p>
          <label className="field">{templateKind === 'publish' ? '全局发布需求模板' : '全局基准需求模板'}<textarea rows={8} value={templateKind === 'publish' ? publishTpl : baselineTpl} disabled={busy || templateVersion === null} onChange={(e) => templateKind === 'publish' ? setPublishTpl(e.target.value) : setBaselineTpl(e.target.value)} placeholder="清空并保存即可恢复内置默认模板" /></label>
          <p className="settings-hint">{templateKind === 'baseline' ? '每个项目可在「编辑设置 → 基线需求模板」里单独覆盖；' : ''}清空并保存则恢复内置默认模板。修改完成后点击右下角「保存设置」。</p>
        </form>}
        {tab === 'logs' && <>
          <div className="validation-setting"><div><label htmlFor="ai-request-logging">记录 AI 请求日志</label><p>默认开启，记录请求时间、模型、响应状态和耗时；关闭后停止新增记录。</p></div><label className="switch"><input id="ai-request-logging" type="checkbox" checked={form.requestLogging ?? true} disabled={busy || !loaded} onChange={(e) => setForm({ ...form, requestLogging: e.target.checked })} /><span className="slider" /><span className="switch-state">{form.requestLogging === false ? '已关闭' : '已开启'}</span></label></div>
          <div className="validation-setting"><div><label htmlFor="publish-request-logging">记录发布请求日志</label><p>默认开启，实时记录构建、打包、Git 推送与附件上传阶段、脚本输出和耗时。</p></div><label className="switch"><input id="publish-request-logging" type="checkbox" checked={publishLogging} disabled={busy || !publishLogLoaded} onChange={(e) => setPublishLogging(e.target.checked)} /><span className="slider" /><span className="switch-state">{publishLogging ? '已开启' : '已关闭'}</span></label></div>
          <p className="settings-hint">开关修改完成后，点击右下角「保存设置」统一保存。</p>
          <div className="segmented request-log-kind" role="group" aria-label="请求日志类型">{[['ai', 'AI 请求'], ['publish', '发布请求']].map(([id, label]) => <button key={id} type="button" aria-pressed={logKind === id} className={logKind === id ? 'on' : ''} onClick={() => setLogKind(id)}>{label}</button>)}</div>
          <p className="settings-hint">{logKind === 'ai' ? 'AI 日志仅保存请求元数据，保留最近 500 条；不记录密钥、URL、需求正文和响应文案。' : '发布日志仅保存在本机，保留最近 2000 条（最多约 512 KB）；记录阶段、累计/阶段耗时、脚本输出及结果，隐藏常见密钥字段。关闭后停止新增，已有记录保留。'}每 2 秒刷新。</p>
          {logKind === 'ai' ? <div className="ai-log-terminal" role="region" aria-label="AI 请求日志" tabIndex={0}><pre>{logError || (logs.length ? logs.slice().reverse().map((entry) => '[' + new Date(entry.time).toLocaleString('zh-CN', { hour12: false }) + '] ' + entry.requestId + ' ' + ({ request: 'SEND', response: 'RESPONSE', complete: 'DONE', error: 'ERROR' }[entry.phase]) + ' ' + entry.format + ' model=' + entry.model + (entry.reasoningEffort ? ' reasoning=' + entry.reasoningEffort : '') + (entry.status ? ' HTTP ' + entry.status : '') + ' +' + entry.elapsedMs + 'ms').join('\n') : '$ 暂无请求日志，生成提交文案后将显示请求与耗时。')}</pre></div>
          : <div className="ai-log-terminal publish-log-terminal" role="region" aria-label="发布请求日志" tabIndex={0}><pre>{publishLogError || (publishLogs.length ? publishLogs.slice().reverse().map(entry => '[' + new Date(entry.time).toLocaleString('zh-CN', { hour12: false }) + '] ' + entry.requestId + ' ' + entry.project + ' ' + ({ request: '开始', stage_start: '阶段开始', stage_complete: '阶段完成', output: '输出', progress: '执行中', complete: '成功', error: '失败' }[entry.phase]) + ' · ' + entry.stage + ' · 累计 ' + (entry.elapsedMs / 1000).toFixed(1) + 's' + (entry.durationMs !== undefined ? ' · 阶段 ' + (entry.durationMs / 1000).toFixed(1) + 's' : '') + (entry.text ? '\n  ' + entry.text : '')).join('\n') : '$ 暂无发布日志，通过项目的发布按钮运行脚本后，将实时显示阶段、输出和耗时。')}</pre></div>}
        </>}
        {tab === 'backup' && <>
          <p className="settings-hint">使用专用 GitHub / GitLab 仓库保存配置、全部需求、历史和参考图片。</p>
          <RemoteFields value={backup} change={(v) => setBackup({ ...backup, ...v })} disabled={busy || !backupLoaded} />
          <div className="validation-setting"><div><label htmlFor="backup-auto">自动同步 · 每 1 分钟</label><p>默认关闭，可手动同步或按需开启；已保存的开关设置继续生效。</p></div><label className="switch"><input id="backup-auto" type="checkbox" checked={backup.autoSync} disabled={busy || !backupLoaded} onChange={(e) => setBackup({ ...backup, autoSync: e.target.checked })} /><span className="slider" /><span className="switch-state">{backup.autoSync ? '已开启' : '已关闭'}</span></label></div>
          <p className="settings-hint">AI 配置（含供应商、URL、模型和密钥）与私钥文件不上传。备份文件中的 workspace 可作为完整工作区导入。</p>
          <div className="settings-actions"><button className="btn" disabled={busy || !backupLoaded || !backup.url || status.running} onClick={() => perform(async () => { const saved = await bridge.saveBackupSettings!(backup); if (!saved.ok) return saved; setSavedBackup(fingerprint(backup)); const r = await bridge.syncBackup!(); setStatus(r.status); return r; }, '备份同步完成')}>立即同步</button><button className="btn" disabled={busy || !backupLoaded || !backup.url || !bridge.testRemote} onClick={() => perform(() => bridge.testRemote!(backup), '备份仓库连接成功')}>测试连接</button></div>
          <div className="settings-actions"><button className="btn" disabled={busy || !backupLoaded || !backup.url || status.running || !bridge.importBackup} onClick={() => setImportConfirm(true)}><Download size={16} />从远端导入</button></div>
          <p className="settings-hint">导入会读取远端备份，补充缺失项目、需求与历史；相同 ID 保留本机内容。导入前保留本机恢复副本，不上传本机数据。</p>
          <p className="backup-status" role="status">{!backupLoaded ? '同步备份仅桌面版可用' : status.running ? '正在同步…' : status.error ? '同步失败：' + status.error : status.lastSuccess ? '最近同步：' + new Date(status.lastSuccess).toLocaleString('zh-CN') : '尚未同步'}</p>
        </>}
        {tab === 'data' && <DataSettings notify={notify} onArchived={onArchived} onExport={onExport} />}
      </div>
      {message && <p className="settings-message" role="status">{message}</p>}
      <div className="settings-footer"><button className="btn open-config-dir" disabled={busy || !bridge.openConfigDir} title={bridge.openConfigDir ? '从资源管理器打开当前配置与数据目录' : '仅桌面版可用'} onClick={() => perform(() => bridge.openConfigDir!(), '已打开配置目录')}><FolderOpen />打开配置目录</button>{tab !== 'data' && <button className="btn primary" disabled={busy || !tabReady} onClick={() => void saveAndFinish()}>保存设置</button>}</div>
      {importConfirm && <div className="overlay"><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="remote-import-title"><div className="dialog-head"><h2 id="remote-import-title">从远端导入备份</h2></div><p>将先保存当前备份仓库设置，再读取所选分支的备份。仅补充本机缺失内容，相同 ID 的项目设置与需求保留本机版本；远端执行锁不会恢复。</p><p>导入前的本机工作区会保存在数据目录的 before-remote-import.json 中。</p>{message && <p role="alert">{message}</p>}<div className="dialog-actions"><button className="btn" disabled={busy} onClick={() => setImportConfirm(false)}>取消</button><button className="btn primary" disabled={busy || status.running} onClick={() => void importRemoteBackup()}>{busy ? '正在导入…' : '确认导入'}</button></div></div></div>}
      {leaveConfirm && <div className="overlay"><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="unsaved-settings-title"><div className="dialog-head"><h2 id="unsaved-settings-title">设置尚未保存</h2></div><p>存在未保存的设置，是否保存后返回项目菜单？</p>{message && <p role="alert">{message}</p>}<div className="dialog-actions"><button className="btn" disabled={busy} onClick={() => setLeaveConfirm(false)}>继续编辑</button><button className="btn" disabled={busy} onClick={onLeave}>放弃更改</button><button className="btn primary" disabled={busy || (backupDirty && status.running)} onClick={() => void saveAllAndLeave()}>{busy ? '保存中…' : '保存并返回'}</button></div></div></div>}
  </section>;
});
