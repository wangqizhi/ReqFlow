import { useEffect, useState } from 'react';
import { bridge } from './api';
import type { AISettings, AIRequestLog } from '../core/ai';
import { emptyBackup, type BackupSettings, type BackupStatus, type RemoteSettings } from '../core/remote';
import { DEFAULT_BASELINE_TEMPLATE, DEFAULT_PUBLISH_TEMPLATE } from '../core/domain';
import { Eye, X, FolderOpen } from './icons';

export function RemoteFields({ value, change, disabled }: { value: RemoteSettings; change(v: RemoteSettings): void; disabled: boolean }) {
  return <fieldset className="remote-fields" disabled={disabled}>
    <div className="segmented" role="group" aria-label="仓库平台">{(['github', 'gitlab'] as const).map((provider) => <button key={provider} type="button" aria-pressed={value.provider === provider} className={value.provider === provider ? 'on' : ''} onClick={() => change({ ...value, provider })}>{provider === 'github' ? 'GitHub' : 'GitLab'}</button>)}</div>
    <label className="field">仓库地址<input value={value.url} onChange={(e) => change({ ...value, url: e.target.value })} placeholder="git@github.com:owner/repo.git 或 HTTPS 地址" /></label>
    <div className="settings-columns"><label className="field">分支<input value={value.branch} onChange={(e) => change({ ...value, branch: e.target.value })} /></label>
      <label className="field">SSH Key 文件<div className="input-action"><input value={value.sshKeyPath} onChange={(e) => change({ ...value, sshKeyPath: e.target.value })} placeholder="留空使用系统 SSH 配置" /><button type="button" className="icon-btn" aria-label="选择 SSH 私钥" disabled={!bridge.pickSSHKey} onClick={async () => { const r = await bridge.pickSSHKey?.(); if (r?.path) change({ ...value, sshKeyPath: r.path }); }}><FolderOpen /></button></div></label></div>
  </fieldset>;
}

export function SettingsOverlay({ onClose, notify }: { onClose(): void; notify(text: string, kind?: 'ok' | 'err'): void }) {
  const [tab, setTab] = useState('ai');
  const [form, setForm] = useState<AISettings>({ provider: '', url: '', apiKey: '' });
  const [backup, setBackup] = useState<BackupSettings>({ ...emptyBackup });
  const [status, setStatus] = useState<BackupStatus>({ running: false });
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [backupLoaded, setBackupLoaded] = useState(false);
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState('');
  const [logs, setLogs] = useState<AIRequestLog[]>([]);
  const [logError, setLogError] = useState('');
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
      setTemplateVersion(r.version);
    }).catch(() => { /* 读取失败时模板tab仍可查看，保存时报错 */ });
  }, []);
  useEffect(() => {
    if (tab !== 'logs') return;
    let cancelled = false;
    const refresh = async () => {
      try { const r = await bridge.getAIRequestLogs?.(); if (cancelled) return; if (!r?.ok) throw Error(r?.error || '请求日志仅桌面版可用'); setLogs(r.entries || []); setLogError(''); }
      catch (e: any) { if (!cancelled) setLogError(e.message); }
    };
    void refresh(); const timer = setInterval(refresh, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [tab]);
  useEffect(() => {
    bridge.getAISettings().then((r) => { if (!r.ok) throw Error(r.error); setForm(r.settings); setLoaded(true); }).catch((e) => notify(e.message, 'err'));
    bridge.getBackupSettings?.().then((r) => { if (r.ok) { setBackup(r.settings); setStatus(r.status); setBackupLoaded(true); } }).catch((e) => notify(e.message, 'err'));
    const timer = setInterval(() => bridge.getBackupSettings?.().then((r) => { if (r.ok) setStatus(r.status); }).catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, []);
  // REQ-062：Esc 关闭设置弹窗（保存中不打断，与关闭按钮一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  async function perform(action: () => Promise<any>, success: string) {
    setBusy(true); setMessage('');
    try { const r = await action(); if (!r?.ok) throw Error(r?.error || '操作失败'); setMessage(success); notify(success); }
    catch (e: any) { setMessage(e.message); notify(e.message, 'err'); }
    finally { setBusy(false); }
  }
  return <div className="overlay" onClick={(e) => { if (!busy && e.target === e.currentTarget) onClose(); }}>
    <div className="dialog settings-dialog" role="dialog" aria-label="设置">
      <div className="dialog-head"><div><h3>设置</h3><p>配置 AI、需求模板与数据备份；项目仓库请从浏览目录中设置</p></div><button className="icon-btn" disabled={busy} aria-label="关闭设置" onClick={onClose}><X /></button></div>
      <div className="settings-tabs" role="tablist">{[['ai', 'AI 供应商'], ['template', '需求模板'], ['backup', '同步备份'], ['logs', '请求日志']].map(([id, title]) => <button key={id} role="tab" aria-selected={tab === id} disabled={busy} className={tab === id ? 'on' : ''} onClick={() => { setTab(id); setMessage(''); }}>{title}</button>)}</div>
      <div className="settings-body">
        {tab === 'ai' && <form onSubmit={(e) => { e.preventDefault(); void perform(() => bridge.saveAISettings(form), 'AI 设置已保存'); }}>
          <p className="settings-hint">用于 AI 需求整理、建议讨论与 Git 提交文案。AI 配置独立保存在本机，不同步到远程仓库。</p>
          <div className="field"><span>API 格式</span><div className="segmented" role="group" aria-label="API 格式" data-api-format="true">{(['openai', 'anthropic'] as const).map((format) => <button key={format} type="button" disabled={busy || !loaded} aria-pressed={(form.format || 'openai') === format} className={(form.format || 'openai') === format ? 'on' : ''} onClick={() => setForm({ ...form, format })}>{format === 'openai' ? 'OpenAI' : 'Anthropic'}</button>)}</div></div>
          <label className="field">供应商名字<input value={form.provider} disabled={busy || !loaded} onChange={(e) => setForm({ ...form, provider: e.target.value })} placeholder="如 OpenAI 或兼容服务" /></label>
          <label className="field">调用 URL<input type="url" value={form.url} disabled={busy || !loaded} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://api.example.com/v1" /></label>
          <label className="field">模型名称 · 可填写或修改<input aria-label="模型名称" value={form.model || ''} disabled={busy || !loaded} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="例如 deepseek-flash" /></label>
          <label className="field">API Key<div className="input-action"><input autoComplete="off" type={visible ? 'text' : 'password'} value={form.apiKey} disabled={busy || !loaded} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /><button type="button" className="icon-btn" aria-label={visible ? '隐藏 API Key' : '显示 API Key'} aria-pressed={visible} onClick={() => setVisible(!visible)}><Eye />{visible && <span className="eye-slash" />}</button></div></label>
          <div className="settings-actions"><button className="btn primary" disabled={busy || !loaded}>保存 AI 设置</button></div>
        </form>}
        {tab === 'template' && <form onSubmit={(e) => {
          e.preventDefault();
          void perform(async () => {
            const r = await bridge.apply({ op: templateKind === 'publish' ? 'globalPublishTemplate' : 'globalBaselineTemplate', text: templateKind === 'publish' ? publishTpl : baselineTpl, expectedVersion: templateVersion === null ? undefined : templateVersion });
            if (!r.ok) throw Error(r.error || '保存失败');
            setTemplateVersion(r.version);
            return r;
          }, templateKind === 'publish' ? '全局发布模板已保存' : '全局基准模板已保存');
        }}>
          <div className="segmented" role="group" aria-label="需求模板类型">{[['baseline', '基线需求'], ['publish', '发布功能需求']].map(([id, label]) => <button type="button" key={id} disabled={busy} aria-pressed={templateKind === id} className={templateKind === id ? 'on' : ''} onClick={() => { setTemplateKind(id); setMessage(''); }}>{label}</button>)}</div>
          <p className="settings-hint">{templateKind === 'publish' ? '「记录新需求 → 发布功能需求」使用这里的模板。发布入口应调用用户部署脚本；没有部署配置时先确认目标位置和部署细节。' : '「记录新需求 → 基线需求」用这里的模板预填一条需求。优先级：项目模板 > 全局模板 > 内置默认模板。'}</p>
          <label className="field">{templateKind === 'publish' ? '全局发布需求模板' : '全局基准需求模板'}<textarea rows={8} value={templateKind === 'publish' ? publishTpl : baselineTpl} disabled={busy} onChange={(e) => templateKind === 'publish' ? setPublishTpl(e.target.value) : setBaselineTpl(e.target.value)} placeholder="清空并保存即可恢复内置默认模板" /></label>
          <div className="settings-actions"><button className="btn primary" disabled={busy || templateVersion === null}>保存全局模板</button></div>
          <p className="settings-hint">{templateKind === 'baseline' ? '每个项目可在「编辑设置 → 基线需求模板」里单独覆盖；' : ''}清空并保存则恢复内置默认模板。</p>
        </form>}
        {tab === 'logs' && <>
          <div className="validation-setting"><div><label htmlFor="ai-request-logging">记录 AI 请求日志</label><p>默认开启，记录请求时间、模型、响应状态和耗时；关闭后停止新增记录。</p></div><label className="switch"><input id="ai-request-logging" type="checkbox" checked={form.requestLogging ?? true} disabled={busy || !loaded} onChange={(e) => setForm({ ...form, requestLogging: e.target.checked })} /><span className="slider" /><span className="switch-state">{form.requestLogging === false ? '已关闭' : '已开启'}</span></label></div>
          <div className="settings-actions"><button className="btn primary" disabled={busy || !loaded} onClick={() => perform(() => bridge.saveAISettings(form), '日志设置已保存')}>保存日志设置</button></div>
          <p className="settings-hint">仅保存在本机，保留最近 500 条记录；不记录密钥、URL、需求正文和响应文案。每 2 秒刷新。</p>
          <div className="ai-log-terminal" role="region" aria-label="AI 请求日志" tabIndex={0}><pre>{logError || (logs.length ? logs.map((entry) => '[' + new Date(entry.time).toLocaleString('zh-CN', { hour12: false }) + '] ' + entry.requestId + ' ' + ({ request: 'SEND', response: 'RESPONSE', complete: 'DONE', error: 'ERROR' }[entry.phase]) + ' ' + entry.format + ' model=' + entry.model + (entry.reasoningEffort ? ' reasoning=' + entry.reasoningEffort : '') + (entry.status ? ' HTTP ' + entry.status : '') + ' +' + entry.elapsedMs + 'ms').join('\n') : '$ 暂无请求日志，生成提交文案后将显示请求与耗时。')}</pre></div>
        </>}
        {tab === 'backup' && <>
          <p className="settings-hint">使用专用 GitHub / GitLab 仓库保存配置、全部需求、历史和参考图片。</p>
          <RemoteFields value={backup} change={(v) => setBackup({ ...backup, ...v })} disabled={busy || !backupLoaded} />
          <div className="validation-setting"><div><label htmlFor="backup-auto">自动同步 · 每 1 分钟</label><p>默认开启，应用运行期间生效；也可关闭后手动同步。</p></div><label className="switch"><input id="backup-auto" type="checkbox" checked={backup.autoSync} disabled={busy || !backupLoaded} onChange={(e) => setBackup({ ...backup, autoSync: e.target.checked })} /><span className="slider" /><span className="switch-state">{backup.autoSync ? '已开启' : '已关闭'}</span></label></div>
          <p className="settings-hint">AI 配置（含供应商、URL、模型和密钥）与私钥文件不上传。备份文件中的 workspace 可作为完整工作区导入。</p>
          <div className="settings-actions"><button className="btn primary" disabled={busy || !backupLoaded || status.running} onClick={() => perform(() => bridge.saveBackupSettings!(backup), '备份设置已保存')}>保存备份设置</button><button className="btn" disabled={busy || !backupLoaded || !backup.url || status.running} onClick={() => perform(async () => { const saved = await bridge.saveBackupSettings!(backup); if (!saved.ok) return saved; const r = await bridge.syncBackup!(); setStatus(r.status); return r; }, '备份同步完成')}>保存并立即同步</button><button className="btn" disabled={busy || !backup.url || !bridge.testRemote} onClick={() => perform(() => bridge.testRemote!(backup), '备份仓库连接成功')}>测试连接</button></div>
          <p className="backup-status" role="status">{!backupLoaded ? '同步备份仅桌面版可用' : status.running ? '正在同步…' : status.error ? '同步失败：' + status.error : status.lastSuccess ? '最近同步：' + new Date(status.lastSuccess).toLocaleString('zh-CN') : '尚未同步'}</p>
        </>}
      </div>
      {message && <p className="settings-message" role="status">{message}</p>}
      <div className="settings-footer"><button className="btn open-config-dir" disabled={busy || !bridge.openConfigDir} title={bridge.openConfigDir ? '从资源管理器打开当前配置与数据目录' : '仅桌面版可用'} onClick={() => perform(() => bridge.openConfigDir!(), '已打开配置目录')}><FolderOpen />打开配置目录</button><button className="btn" disabled={busy} onClick={onClose}>完成</button></div>
    </div>
  </div>;
}
