// ReqFlow 主界面 —— 移植自线上 app/page.tsx 的完整工作台逻辑，
// 交互与状态流与线上一致；新增「帮助 / CLI 参考」入口。

import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_BASELINE_TEMPLATE, DEFAULT_DELIVERY, DEFAULT_PUBLISH_TEMPLATE, DEFAULT_CONTEXT_RULES_LIMIT, MIN_CONTEXT_RULES_LIMIT, MAX_CONTEXT_RULES_LIMIT, buildPrompt, requirementSettings, unresolvedFailures, pendingCommitItems, compareArchivedItems, mutationProjectIds, projectConcurrencyToken,
  scheduledBatch, activeAIExecution, type Item, type Project, type Workspace
} from '../core/domain';
import { bridge, type PublishSession } from './api';
import { publishProject } from './publish';
import { PublishTerminal, useTerminalSetting } from './publish-terminal';
import {
  Check, ChevronDown, Download, FileText, FolderOpen, HelpCircle, History,
  Layers, Maximize2, Play, Plus, RefreshCw, Rocket, Search, Server, Trash, X, ImageIcon, Settings, EyeOff, BarChart
} from './icons';
import { HelpOverlay } from './help';
import { UpdateButton } from './update';
import { ProjectBrowser } from './browser';
import { SettingsPage, settingsTabs, type SettingsPageHandle } from './settings';
import { GuidanceField, FileMentionTextarea } from './guide-fields';
import { AIRequirements } from './ai-requirements';
import { ProjectCreate } from './project-create';
import { ProjectManager } from './project-manager';
import { SSHDirectory, isSSH } from './ssh-directory';
import { projectDragType, projectDrop, projectDragOver, projectDragLeave, projectDragEnd } from './project-drag';
import { renderMarkdown } from './markdown';
import { ContentWorkspace } from './content';
import { executorLabel, useLocalAgents, agentName, sendToCodex } from './assignment';
import { ModsOverlay } from './mods';
import { StatsPanel } from './stats-panel';
import { localDate, matchesSchedule } from '../core/dates';

const labels: Record<string, string> = {
  feature: '新需求', improvement: '优化', bug: '修复',
  ready: '待执行', in_progress: '待开发', pending_verification: '待验证', archived: '已归档'
};
const phases: [string, string][] = [
  ['feature', '需求池'], ['generate', '排期表'],
  ['pending_verification', '待验证'], ['archived', '归档']
];
const clientLabels = { codex: 'Codex', zcode: 'ZCode', pi: 'Pi', 'claude-code': 'Claude Code', dsh: 'DSH', opencode: 'OpenCode' };
function executionDuration(start: string, end = Date.now()) {
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1000));
  return seconds < 60 ? seconds + ' 秒' : seconds < 3600 ? Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒' : Math.floor(seconds / 3600) + ' 小时 ' + Math.floor(seconds % 3600 / 60) + ' 分';
}
const emptyForm = { title: '', body: '', criteria: '', type: 'feature', priority: 'P1', executor: 'ai' };
// 上次使用的项目（REQ-029）：启动时恢复；项目切换即记录，关闭程序时最近一次选择已保存
const LAST_PROJECT_KEY = 'reqflow-last-project';

export default function App() {
  const [data, setData] = useState<Workspace | null>(null);
  const [version, setVersion] = useState(0);
  const [appVersion, setAppVersion] = useState('');
  const [pid, setPid] = useState('');
  const [tab, setTab] = useState('feature');
  const [executionClock, setExecutionClock] = useState(Date.now());
  const [releaseItem, setReleaseItem] = useState<Item | null>(null);
  const [archiveView, setArchiveView] = useState('items');
  const [scheduleMode, setScheduleMode] = useState('through');
  const [scheduleDate, setScheduleDate] = useState(localDate());
  const [selected, setSelected] = useState<string[]>([]);
  const [batchId, setBatchId] = useState('');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [archiveDate, setArchiveDate] = useState('');
  // REQ-142：从批次历史进入某一批次后，归档列表只显示该批次的需求
  const [archiveBatchId, setArchiveBatchId] = useState('');
  // REQ-131：归档日期按「年 → 月 → 日」文件夹树展开浏览；同一层只保留一个展开项
  const [archiveOpenYear, setArchiveOpenYear] = useState('');
  const [archiveOpenMonth, setArchiveOpenMonth] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('已保存');
  const [modal, setModal] = useState('');
  const [editing, setEditing] = useState<Item | null>(null);
  const [form, setForm] = useState<any>(emptyForm);
  const [guide, setGuide] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [note, setNote] = useState('');
  const [fixedIdx, setFixedIdx] = useState<number[]>([]); // 二次退回时确认「已修复」的旧问题下标
  const [delivery, setDelivery] = useState('');
  const [verifyKind, setVerifyKind] = useState<'none' | 'exe' | 'url'>('none'); // 验证源类型（REQ-060）
  const [verifyValue, setVerifyValue] = useState('');
  const [baselineTpl, setBaselineTpl] = useState(''); // 基线需求模板（REQ-064），空串表示使用默认模板
  const [deleteRulesConfirm, setDeleteRulesConfirm] = useState(false);
  const [rulesLimit, setRulesLimit] = useState(DEFAULT_CONTEXT_RULES_LIMIT); // 守则字数上限（REQ-185）
  const [guideTab, setGuideTab] = useState('guide'); // REQ-151：编辑设置浮层按功能分 tab
  const [publishMode, setPublishMode] = useState('auto');
  const [publishPath, setPublishPath] = useState('');
  const [settingsTab, setSettingsTab] = useState('ai');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const settingsPage = useRef<SettingsPageHandle>(null);
  const [modsOpen, setModsOpen] = useState(false);
  const [modsTab, setModsTab] = useState('protocol');
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [mode, setMode] = useState<'FLOW' | 'CONTENT' | 'SETTINGS' | 'STATS'>('FLOW');
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<{ id: string; name: string } | null>(null); // REQ-111 文件夹删除确认
  const [targetProject, setTargetProject] = useState('');
  const [browserOpen, setBrowserOpen] = useState(false);
  const [directoryPicker, setDirectoryPicker] = useState(false);
  const [sshPicker, setSSHPicker] = useState(false);
  const [sshConnections, setSSHConnections] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const remoteRoots = data?.projects.filter(pr => isSSH(pr.dir)).map(pr => pr.dir!).join('\n') || '';
  useEffect(() => {
    if (!bridge.sshStatus || !remoteRoots) return;
    let cancelled = false, running = false;
    const check = async () => {
      if (running) return;
      running = true;
      try { await Promise.all([...new Set(remoteRoots.split('\n'))].map(async root => {
        const result = await bridge.sshStatus!(root).catch(e => ({ ok: false, error: e.message }));
        if (!cancelled) setSSHConnections(previous => ({ ...previous, [root]: result }));
      })); } finally { running = false; }
    };
    void check(); const timer = window.setInterval(check, 15000);
    window.addEventListener('focus', check);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', check); };
  }, [remoteRoots]);
  const [advanced, setAdvanced] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!newMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!newMenuRef.current?.contains(event.target as Node)) setNewMenu(false);
    };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setNewMenu(false); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [newMenu]);
  const [aiOpen, setAiOpen] = useState(false);
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [publishScript, setPublishScript] = useState(''); // 发布脚本相对路径（REQ-070），空串表示未检测到
  const [contextWizard, setContextWizard] = useState(false);
  const [contextFeature, setContextFeature] = useState('');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [terminalEnabled] = useTerminalSetting();
  const [publishStates, setPublishStates] = useState<Record<string, PublishSession & { idle?: boolean; resultDismissed?: boolean; terminalRunId?: string; terminalOpen?: boolean; terminalProject?: string }>>({});
  const [detachedTerminals, setDetachedTerminals] = useState<Record<string, boolean>>({});
  const publishingIds = useRef(new Set<string>());
  const p = data?.projects.find((x) => x.id === pid && !x.hidden) || data?.projects.find(x => !x.hidden) || data?.projects[0];
  const publishing = !!publishStates[p?.id || '']?.running;
  const publishStep = publishStates[p?.id || '']?.step || '';
  const publishResult = publishStates[p?.id || '']?.resultDismissed ? null : publishStates[p?.id || '']?.result || null;
  const terminalSession = publishStates[p?.id || ''];
  const terminalRunId = terminalSession?.terminalRunId;
  const terminalDetached = !!terminalRunId && !!detachedTerminals[terminalRunId];
  function rememberTerminal(id: string, open: boolean) {
    try { localStorage.setItem('reqflow-terminal-open:' + id, String(open)); } catch {}
  }
  function setTerminalOpen(id: string, open: boolean) {
    rememberTerminal(id, open);
    setPublishStates(states => ({ ...states, [id]: { ...states[id], terminalOpen: open } }));
  }
  useEffect(() => {
    if (!terminalEnabled || !p || !bridge.getPublishOutput) return;
    const id = p.id, name = p.name;
    setPublishStates(states => {
      if (states[id]?.terminalRunId) return states;
      let open = false;
      // Each application session starts with the terminal collapsed.
      const now = Date.now();
      const session = states[id] || { running: false, step: '', result: null, startedAt: now, endedAt: now, revision: 1, idle: true };
      return { ...states, [id]: { ...session, terminalRunId: crypto.randomUUID(), terminalProject: name, terminalOpen: open } };
    });
  }, [terminalEnabled, p?.id, p?.name]);
  useEffect(() => {
    for (const session of Object.values(publishStates)) {
      if (session.terminalRunId && session.terminalProject) {
        void bridge.syncPublishTerminal?.(session.terminalRunId, { ...session, project: session.terminalProject, result: session.result ? { ok: session.result.ok, error: session.result.error } : null }).catch(() => {});
      }
    }
  }, [publishStates]);
  useEffect(() => {
    if (!terminalRunId || !bridge.getPublishTerminal) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await bridge.getPublishTerminal!(terminalRunId);
        if (!cancelled && result.ok) setDetachedTerminals(previous => previous[terminalRunId] === result.detached ? previous : { ...previous, [terminalRunId]: result.detached });
      } finally { if (!cancelled) timer = setTimeout(() => void poll().catch(() => {}), 500); }
    };
    void poll().catch(() => {});
    return () => { cancelled = true; clearTimeout(timer); };
  }, [terminalRunId]);
  async function detachTerminal() {
    if (!terminalSession?.terminalRunId || !p || !bridge.openPublishTerminal || !bridge.syncPublishTerminal) throw Error('独立终端仅桌面版支持');
    const synced = await bridge.syncPublishTerminal(terminalSession.terminalRunId, { ...terminalSession, project: p.name, result: terminalSession.result ? { ok: terminalSession.result.ok, error: terminalSession.result.error } : null });
    if (!synced.ok) throw Error(synced.error || '无法同步终端状态');
    const opened = await bridge.openPublishTerminal(terminalSession.terminalRunId);
    if (!opened.ok) throw Error(opened.error || '无法打开独立终端');
    setDetachedTerminals(previous => ({ ...previous, [terminalSession.terminalRunId!]: true }));
  }
  const [publishConfirm, setPublishConfirm] = useState(false); // 待验证需求未处理时确认是否先验证（REQ-090）
  const [dirConfirm, setDirConfirm] = useState(false); // REQ-146：点击项目目录后确认是否从资源管理器打开
  useEffect(() => {
    if (!publishConfirm) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !publishing) setPublishConfirm(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [publishConfirm, publishing]);
  const [completeConfirm, setCompleteConfirm] = useState<{ project: string; items: { id: string; version: number; number: string }[] } | null>(null);
  const completingRef = useRef(false);
  const [completing, setCompleting] = useState(false);
  useEffect(() => {
    if (!completeConfirm) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !completingRef.current) setCompleteConfirm(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [completeConfirm]);
  // REQ-101：指派入口移入提交验证弹窗，仅在弹窗打开时加载已配置的 Agent
  const { agents: localAgents } = useLocalAgents(!!completeConfirm || tab === 'generate');
  const [codexBusy, setCodexBusy] = useState(false);
  const [bodyOverflows, setBodyOverflows] = useState(false); // 需求说明超出输入框（REQ-074）
  const [bodyExpanded, setBodyExpanded] = useState(false); // 打开放大编辑需求说明的大输入框
  const [sort, setSort] = useState('desc');
  const [folderName, setFolderName] = useState('');
  const [folderForm, setFolderForm] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [backgroundEditing, setBackgroundEditing] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null); // 需求说明输入框（REQ-074 溢出检测）

  const versionRef = useRef(0);
  const workspaceRef = useRef<Workspace | null>(null);
  const busyRef = useRef(false);
  const autoRef = useRef<any>(null);
  const formRef = useRef(form);
  const dirtyRef = useRef(false);
  formRef.current = form;

  function setPublishResult(result: { ok: boolean; output: string; error?: string } | null) {
    if (p) setPublishStates(states => ({ ...states, [p.id]: { ...states[p.id], running: !!states[p.id]?.running, step: states[p.id]?.step || '', result: result || states[p.id]?.result || null, resultDismissed: !result } }));
  }

  function notify(text: string, kind: 'ok' | 'err' = 'ok') {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 1800);
  }

  function switchProject(id: string) {
    setMode('FLOW');
    setNewMenu(false);
    setBackgroundEditing(false);
    setPid(id); setSelected([]); setBatchId(''); setQuery(''); setTab('feature');
    setBrowserOpen(false); setTypeFilter('all'); setArchiveDate(''); setArchiveBatchId('');
    setPublishConfirm(false); setPublishScript('');
    void load({ quiet: true }); // REQ-076：切换项目时立即刷新 flow 状态
  }

  // 浏览项目：未关联目录先弹出系统目录选择框，关联后打开文件浏览器
  async function browseProject() {
    if (!bridge.pickDir || !bridge.listDir) {
      notify('文件浏览仅桌面版支持（浏览器预览无本地文件访问）', 'err');
      return;
    }
    if (!p?.dir) {
      setDirectoryPicker(true);
      return;
    }
    setBrowserOpen(true);
  }

  // REQ-146：确认后用系统资源管理器打开项目目录；浏览器预览无本地能力时降级提示
  async function openProjectDir() {
    if (!p?.dir) return;
    if (!bridge.openProjectDir) { notify('仅桌面版支持从资源管理器打开', 'err'); setDirConfirm(false); return; }
    const r = await bridge.openProjectDir(p.dir);
    setDirConfirm(false);
    if (!r.ok) notify(r.error || '打开目录失败', 'err');
  }

  async function load(opts: { quiet?: boolean } = {}) {
    try {
      const r = await bridge.getWorkspace();
      if (!r.ok) throw Error(r.error);
      setData(r.state); workspaceRef.current = r.state; setVersion(r.version); versionRef.current = r.version; setError('');
    } catch (e: any) {
      if (opts.quiet) return; // 后台自动刷新失败时保持现状，不打扰用户（手动刷新仍会提示）
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
    bridge.appInfo().then((i) => setAppVersion(i.version)).catch(() => { /* 取不到版本号时仅不显示 */ });
  }, []);

  // REQ-076：flow 状态自动更新 —— 每 15 秒静默轮询，窗口重获焦点时也刷新；
  // 切换模块（changeTab）与切换项目（switchProject）会各自立即刷新。
  // 弹窗打开或保存进行中时跳过，避免打断编辑或引发版本冲突
  useEffect(() => {
    const refresh = () => { if (!busyRef.current && !modal) void load({ quiet: true }); };
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [modal]);

  // REQ-029：首次数据加载后恢复上次使用的项目（项目已被删除时回退第一个）
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!data || restoredRef.current) return;
    restoredRef.current = true;
    try {
      const last = localStorage.getItem(LAST_PROJECT_KEY);
      if (last && data.projects.some((x) => x.id === last)) setPid(last);
    } catch { /* localStorage 不可用时保持默认项目 */ }
  }, [data]);
  useEffect(() => {
    if (!p) return;
    try { localStorage.setItem(LAST_PROJECT_KEY, p.id); } catch { /* 记录失败不影响使用 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.id]);

  // 数据刷新后同步弹窗持有的条目快照：弹窗标题/正文始终显示该需求最新信息，
  // 避免连续操作多条需求时显示退回前的旧条目
  useEffect(() => {
    if (!editing || !data) return;
    const fresh = p?.items.find((x) => x.id === editing.id);
    if (fresh && fresh !== editing) setEditing(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // REQ-062：Esc 关闭当前弹窗（复用关闭按钮逻辑：编辑中内容自动保存，保存中不打断）；
  // REQ-074：需求说明处于放大编辑时，Esc 先收起放大框而不关闭整个弹窗
  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (deleteRulesConfirm) { if (!busy) setDeleteRulesConfirm(false); return; }
      if (bodyExpanded) { setBodyExpanded(false); return; }
      void closeModal();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal, editing, bodyExpanded, deleteRulesConfirm, busy]);

  // REQ-074：需求说明超出输入框高度时，在「展开更多设置」旁显示「放大编辑」按钮
  useEffect(() => {
    if (modal !== 'item') { setBodyOverflows(false); return; }
    const el = bodyInput.current;
    setBodyOverflows(!!el && el.scrollHeight > el.clientHeight + 1);
  }, [modal, form.body]);

  // 发布脚本检测（REQ-070）：检测到 scripts/ 或项目根目录下的 publish 脚本时，「浏览项目」旁显示「发布」按钮，
  // 菜单不再显示「发布功能需求」。脚本常由 AI 在应用外创建，窗口重获焦点或关闭文件浏览器时重查。
  useEffect(() => {
    let cancelled = false;
    const detect = async () => {
      if (isSSH(p?.dir)) { setPublishScript(''); return; }
      if (p?.publishScript !== undefined) { setPublishScript(p.publishScript); return; }
      if (!p?.dir || !bridge.detectPublish) { setPublishScript(''); return; }
      const r = await bridge.detectPublish(p.dir);
      if (!cancelled && r.ok) setPublishScript(r.script || '');
    };
    void detect();
    window.addEventListener('focus', detect);
    return () => { cancelled = true; window.removeEventListener('focus', detect); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.dir, p?.publishScript, browserOpen]);

  // REQ-070：Esc 关闭发布输出弹窗
  useEffect(() => {
    if (!publishResult || (terminalEnabled && terminalSession?.terminalRunId)) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPublishResult(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [publishResult, terminalEnabled, terminalSession?.terminalRunId]);

  // REQ-146：Esc 关闭目录打开确认浮层
  useEffect(() => {
    if (!dirConfirm) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDirConfirm(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirConfirm]);

  async function act(a: any, quiet = false): Promise<(Workspace & { createdProjectId?: string }) | false> {
    if (busyRef.current) {
      if (!quiet) notify('正在保存，请稍后再试', 'err');
      return false;
    }
    busyRef.current = true; setBusy(true); setSaved('保存中…');
    try {
      // 默认作用于当前项目；操作显式携带 project 时（如删除其他项目）以传入值为准
      const action = { project: p?.id, ...a };
      const initialDraft = JSON.stringify(workspaceRef.current?.projects.find(pr => pr.id === action.project)?.requirementDraft);
      const canRebase = action.op === 'requirementDraft' || (action.op === 'item' && !action.id);
      const save = async () => {
        const scopes = mutationProjectIds(action);
        const expectedProjectVersions = scopes ? Object.fromEntries(scopes.map(id => [id, workspaceRef.current?.projects.find(pr => pr.id === id)?.revision ?? 0])) : undefined;
        const expectedProjectSignatures = scopes ? Object.fromEntries(await Promise.all(scopes.map(async id => {
          const project = workspaceRef.current?.projects.find(pr => pr.id === id);
          if (!project) throw Error('项目已不存在，请刷新后重试');
          return [id, await projectConcurrencyToken(project)];
        }))) : undefined;
        return bridge.apply({ ...action, expectedVersion: versionRef.current, expectedProjectVersions, expectedProjectSignatures });
      };
      let r = await save();
      if (!r.ok && r.code === 'VERSION_CONFLICT') {
        // Refresh concurrency metadata without touching the local form. Only a
        // new requirement/draft can merge unrelated Agent status changes.
        const latest = await bridge.getWorkspace();
        if (!latest.ok) throw Error(latest.error);
        const project = latest.state.projects.find(pr => pr.id === action.project);
        const sameDraft = project && JSON.stringify(project.requirementDraft) === initialDraft;
        setData(latest.state); workspaceRef.current = latest.state;
        setVersion(latest.version); versionRef.current = latest.version;
        if (canRebase && sameDraft) r = await save();
      }
      if (!r.ok) throw Error(r.error);
      if (r.version >= versionRef.current) { setData(r.state); workspaceRef.current = r.state; setVersion(r.version); versionRef.current = r.version; }
      setSaved('已保存'); setError(r.warning || '');
      if (r.warning) notify(r.warning, 'err');
      else if (!quiet) notify(r.summary || '已保存');
      return { ...r.state, createdProjectId: r.createdProjectId };
    } catch (e: any) {
      setError(e.message); setSaved('保存失败');
      notify(e.message, 'err');
      return false;
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }

  function defaultRequirementForm() {
    return {
      ...emptyForm, aiValidation: false,
      deliveryGuidance: p!.deliveryGuidance === DEFAULT_DELIVERY
        ? '说明改动、未解决的问题。' : p!.deliveryGuidance
    };
  }

  async function clearRequirement() {
    if (editing || busyRef.current || uploading) return;
    clearTimeout(autoRef.current);
    const defaults = defaultRequirementForm();
    if (!await act({ op: 'requirementDraft', draft: defaults }, true)) return;
    dirtyRef.current = false;
    formRef.current = defaults;
    setForm(defaults);
    setAdvanced(false); setBodyExpanded(false); setBodyOverflows(false);
    if (imageInput.current) imageInput.current.value = '';
    bodyInput.current?.focus();
  }

  function edit(i?: Item) {
    dirtyRef.current = false;
    clearTimeout(autoRef.current);
    setEditing(i || null);
    setForm(i
      ? { ...i, ...requirementSettings(p!, i), criteria: i.criteria.join('\n') }
      : p!.requirementDraft || defaultRequirementForm());
    setAdvanced(false); setNewMenu(false);
    setModal('item');
  }

  // 基线需求（REQ-064）：项目模板 > 全局模板（REQ-071，设置中统一配置）> 默认模板
  function editBaseline() {
    setNewMenu(false);
    dirtyRef.current = false;
    clearTimeout(autoRef.current);
    setEditing(null);
    setForm({
      ...emptyForm, type: 'improvement', aiValidation: false,
      deliveryGuidance: p!.deliveryGuidance === DEFAULT_DELIVERY
        ? '说明改动、未解决的问题。' : p!.deliveryGuidance,
      body: p!.baselineTemplate || data?.baselineTemplate || DEFAULT_BASELINE_TEMPLATE
    });
    setAdvanced(false);
    setModal('item');
  }

  // 发布功能需求（REQ-070）：预填一条在 scripts/ 下创建 publish 发布脚本的需求；
  // AI 完成后应用检测到脚本，「浏览项目」旁出现「发布」按钮，菜单里此项随之隐藏
  function editPublish() {
    setNewMenu(false);
    dirtyRef.current = false;
    clearTimeout(autoRef.current);
    setEditing(null);
    setForm({
      ...emptyForm, title: '创建发布脚本', type: 'improvement', aiValidation: false,
      deliveryGuidance: p!.deliveryGuidance === DEFAULT_DELIVERY
        ? '说明改动、未解决的问题。' : p!.deliveryGuidance,
      body: data?.publishTemplate || DEFAULT_PUBLISH_TEMPLATE
    });
    setAdvanced(false);
    setModal('item');
  }

  // 执行发布脚本（REQ-070）：运行项目目录下的 publish 脚本，完成后弹窗展示输出（含产物位置）
  async function runPublish() {
    if (!p?.dir || !publishScript || publishingIds.current.has(p.id)) return;
    if (!bridge.runPublish) { notify('发布仅桌面版支持（浏览器预览无本地脚本访问）', 'err'); return; }
    setPublishConfirm(false);
    const project = p, script = publishScript;
    publishingIds.current.add(project.id);
    const update = (patch: Partial<typeof publishStates[string]>) => setPublishStates(states => ({ ...states, [project.id]: { ...(states[project.id] || { running: false, step: '', result: null, startedAt: 0 }), ...patch, revision: (states[project.id]?.revision || 0) + 1 } }));
    const terminalRunId = terminalEnabled && bridge.getPublishOutput ? crypto.randomUUID() : undefined;
    if (terminalRunId) rememberTerminal(project.id, true);
    update({ running: true, idle: false, step: '', result: null, resultDismissed: false, startedAt: Date.now(), endedAt: undefined, terminalRunId, terminalOpen: !!terminalRunId, terminalProject: project.name });
    try {
      const r = await publishProject(project, script, bridge, step => update({ step }), terminalRunId);
      update({ result: { ok: !!r.ok, output: r.output || '', error: r.error } });
      // REQ-110：整个发布流程结束时上报，窗口不在最前端时由主进程弹系统通知
      void bridge.publishNotice?.({ ok: !!r.ok, project: project.name, detail: r.ok ? '发布脚本已执行完毕，产物位置见应用内发布输出。' : r.error || '发布脚本执行失败' });
    } catch (e: any) {
      update({ result: { ok: false, output: '', error: e?.message || '执行发布脚本失败' } });
      void bridge.publishNotice?.({ ok: false, project: project.name, detail: e?.message || '发布流程执行失败' });
    } finally {
      publishingIds.current.delete(project.id);
      update({ running: false, step: '', endedAt: Date.now() });
      void load({ quiet: true });
    }
  }

  async function dispatchCodex(item: Item) {
    if (!p?.dir || codexBusy) return;
    setCodexBusy(true);
    try {
      await sendToCodex(p.dir, '[@ReqFlow Agent](plugin://reqflow-agent@reqflow-local)\n\n本轮只执行 ' + item.number + '（需求 ID：' + item.id + '），其他排期需求不属于本轮。');
      notify('已调起 Codex，任务内容已复制');
    } catch (e: any) { notify(e.message, 'err'); }
    finally { setCodexBusy(false); }
  }

  // 运行验证源（REQ-077）：按钮移到顶部「浏览项目 / 发布」旁，仅项目配置了验证源时出现
  async function runVerifySource() {
    if (!p?.verifySource) return;
    if (!bridge.openVerifySource) { notify('运行验证源仅桌面版支持', 'err'); return; }
    const r = await bridge.openVerifySource(p.verifySource);
    if (!r.ok) notify(r.error || '打开验证源失败', 'err');
  }

  async function uploadImages(files: FileList | File[] | null) {
    if (!files?.length || uploading) return;
    setUploading(true);
    try {
      const additions = [];
      const current = formRef.current.attachments || [];
      if (current.length + files.length > 12) throw Error('最多上传 12 张图片');
      let next = Math.max(0, ...current.map((a: any) => Number(a.label.replace('图片', '')))) + 1;
      for (const file of Array.from(files)) {
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 10 * 1024 * 1024)
          throw Error('支持 PNG/JPG/WebP/GIF，每张最多 10MB');
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(Error('读取图片失败')); reader.readAsDataURL(file);
        });
        additions.push({ id: crypto.randomUUID(), label: '图片' + next++, name: file.name, dataUrl });
      }
      change({ ...formRef.current, attachments: [...current, ...additions] });
    } catch (e: any) { notify(e.message, 'err'); }
    finally { setUploading(false); }
  }

  function change(f: any) {
    dirtyRef.current = true;
    formRef.current = f;
    setForm(f);
    if (editing) {
      setSaved('等待保存…');
      clearTimeout(autoRef.current);
      autoRef.current = setTimeout(async () => {
        if (f.deliveryGuidance?.trim() && await act({ op: 'item', ...f, id: editing.id }, true)) {
          if (formRef.current === f) dirtyRef.current = false;
        }
      }, 800);
    }
  }

  // 执行中的需求也可参与生成：前一轮未完成时可与新需求累积生成，或单独生成
  const eligible = (i: Item) => !i.archived && !activeAIExecution(i) && (i.status === 'ready' || i.status === 'in_progress');
  const bulkEligible = (i: Item) => eligible(i) && !i.deferred;
  const picked = selected.map((id) => p?.items.find((i) => i.id === id)).filter((i): i is Item => !!i && eligible(i));
  // 「提交验证」页顶部按钮：把待执行与执行中的全部需求合成一条 Prompt
  const executingItems = (p?.items || []).filter(i => !!activeAIExecution(i));
  const allInProgress = (p?.items || []).filter((i) => !i.archived && !activeAIExecution(i) && (i.status === 'in_progress' || (i.status === 'ready' && !!p && !!scheduledBatch(p, i))));
  // 待验证需求（REQ-090）：存在时点击「发布」先弹确认浮层，提示先完成验证
  const pendingVerifyItems = (p?.items || []).filter((i) => !i.archived && i.status === 'pending_verification');
  const inProgress = allInProgress.filter(i => matchesSchedule(i.scheduledDate, scheduleMode, scheduleDate)
    && (typeFilter === 'all' || i.type === typeFilter)
    && [i.title, i.number, i.body].join(' ').toLowerCase().includes(query.toLowerCase()));
  useEffect(() => {
    if (!executingItems.length) { setTab(current => current === 'executing' ? 'generate' : current); return; }
    const timer = window.setInterval(() => setExecutionClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [executingItems.length, tab]);
  const shownPhases: [string, string][] = executingItems.length ? [...phases.slice(0, 2), ['executing', '执行中'], ...phases.slice(2)] : phases;
  const viewingHistory = tab === 'archived' && archiveView === 'batches';
  const visible = (p?.items || []).filter((i) =>
    (tab === 'executing' ? !!activeAIExecution(i) : tab === 'archived' ? !!i.archived
      : !i.archived && (tab === 'feature' ? i.status === 'ready' && !scheduledBatch(p!, i) : tab === 'generate' ? allInProgress.some(item => item.id === i.id) : i.status === tab))
    && (tab !== 'generate' || matchesSchedule(i.scheduledDate, scheduleMode, scheduleDate))
    && (typeFilter === 'all' || i.type === typeFilter)
    && [i.title, i.number, i.body].join(' ').toLowerCase().includes(query.toLowerCase()));
  const archivedDate = (i: Item) => {
    const time = i.history.find(h => h.event === '归档')?.time;
    return time && Number.isFinite(Date.parse(time)) ? localDate(new Date(time)) : '日期未知';
  };
  const archiveDates = [...new Set(visible.map(archivedDate))].sort().reverse();
  // REQ-131：把归档日期组织成「年 → 月 → 日」的文件夹树（archiveDates 已按日期倒序，最新年份/月份在前）；无法解析的日期单独归为一组
  const archiveTree = (() => {
    const years: { year: string; count: number; months: { month: string; count: number; days: { day: string; date: string; count: number }[] }[] }[] = [];
    for (const date of archiveDates) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
      if (!match) continue;
      const count = visible.filter(i => archivedDate(i) === date).length;
      let year = years.find(n => n.year === match[1]);
      if (!year) { year = { year: match[1], count: 0, months: [] }; years.push(year); }
      let month = year.months.find(n => n.month === match[2]);
      if (!month) { month = { month: match[2], count: 0, days: [] }; year.months.push(month); }
      month.days.push({ day: match[3], date, count });
      month.count += count;
      year.count += count;
    }
    return { years, unknown: archiveDates.filter(date => !/^\d{4}-\d{2}-\d{2}$/.test(date)) };
  })();
  // REQ-141/142：归档列表一行一条；可按批次筛选；未选日期时显示全部归档
  const archiveBatch = archiveBatchId ? p?.batches.find((b) => b.id === archiveBatchId) : undefined;
  const shownItems = tab === 'archived'
    ? visible.filter(i => (!archiveDate || archivedDate(i) === archiveDate) && (!archiveBatch || archiveBatch.items.some((old) => old.id === i.id)))
    : visible;
  const windowControls = () => <div className="window-controls"><button aria-label="最小化" onClick={() => void bridge.windowControl?.('minimize')}><svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 8h10" stroke="currentColor" /></svg></button><button className="window-close" aria-label="关闭窗口" onClick={() => void bridge.windowControl?.('close')}><X size={16} /></button></div>;
  const windowBar = bridge.windowControl ? <div className="window-bar">{windowControls()}</div> : null;
  const batch = p?.batches.find((b) => b.id === batchId) || p?.batches.find((b) => b.mode === 'develop');
  const stale = !!batch && !!p && (
    batch.guideVersion !== p.guideVersion ||
    batch.items.some((old) => p.items.find((i) => i.id === old.id)?.version !== old.version));

  async function generate(ids = picked.map((i) => i.id)) {
    const r = await act({ op: 'generate', ids });
    if (!r) return;
    const pr = r.projects.find((x) => x.id === p?.id)!;
    const b = pr.batches[0];
    // 界面没有「确认提交」步骤：生成即提交，需求直接进入执行中（CLI 仍可 generate/submit 分步）
    if (!await act({ op: 'submit', batch: b.id }, true)) return;
    setBatchId(b.id);
    setSelected(ids);
    setTab('generate');
    notify(`已排期 ${ids.length} 条需求，进入待开发`);
  }

  // 单条提交：AI 完成这一条后，单独把它送入待验证，不影响同批其他需求
  async function submitItem(i: Item) {
    setCompleteConfirm({ project: p!.id, items: [{ id: i.id, version: i.version, number: i.number }] });
  }

  async function completeBatch() {
    if (inProgress.length) setCompleteConfirm({ project: p!.id, items: inProgress.map(({ id, version, number }) => ({ id, version, number })) });
  }
  // 指派 / 取消指派（恢复默认 AI 执行）都在提交验证弹窗内完成，不关闭弹窗
  async function assignItems(ids: string[], executor: string) {
    if (await act({ op: 'assign', ids, executor }, true))
      notify(executor === 'ai' ? '已取消指派，恢复 AI 执行' : '已指派给 ' + executorLabel(executor));
  }
  async function confirmComplete() {
    if (!completeConfirm || busyRef.current || completingRef.current) return;
    const request = completeConfirm;
    const current = workspaceRef.current?.projects.find(project => project.id === request.project);
    if (p?.id !== request.project || request.items.some(old => {
      const item = current?.items.find(i => i.id === old.id);
      return !item || item.version !== old.version || item.archived || !['ready', 'in_progress'].includes(item.status);
    })) { setCompleteConfirm(null); notify('需求已变化，请刷新后重新提交验证', 'err'); return; }
    completingRef.current = true; setCompleting(true);
    try {
      for (const item of request.items) {
        if (!await act({ op: 'complete', id: item.id }, true)) { setCompleteConfirm(null); return; }
      }
      setCompleteConfirm(null); setTab('pending_verification'); setSelected([]);
      notify(`已提交 ${request.items.length} 条需求进入待验证`);
    } finally { completingRef.current = false; setCompleting(false); }
  }
  async function recordPass(i: Item) {
    if (await act({ op: 'verify', id: i.id, pass: true })) {
      setSelected([]);
      notify('验证通过，已直接归档');
    }
  }
  async function revertItem(i: Item) {
    if (await act({ op: 'revert', id: i.id })) {
      setTab('feature');
      notify('已退回需求池，可编辑后重新排期');
    }
  }
  function changeTab(v: string) {
    setTab(v);
    void load({ quiet: true }); // REQ-076：切换模块时立即刷新 flow 状态
    if (v === 'generate') { setScheduleMode('through'); setScheduleDate(localDate()); }
    // REQ-131：进入归档页时展开最新年份与月份，直接看到最近的日期文件夹。
    // 这里必须直接统计归档需求：当前渲染的 visible 仍是旧 tab 的过滤结果，取不到归档日期
    if (v === 'archived') {
      setArchiveView('items');
      setArchiveBatchId('');
      const latest = /^(\d{4})-(\d{2})-\d{2}$/.exec([...new Set((p?.items || []).filter(i => i.archived).map(archivedDate))].sort().reverse()[0] || '');
      setArchiveOpenYear(latest?.[1] || '');
      setArchiveOpenMonth(latest?.[2] || '');
    }
    if (v !== 'feature' && v !== 'generate') setSelected([]);
  }

  async function copyPrompt(items: Item[]) {
    if (!p || !items.length) return;
    try { await navigator.clipboard.writeText(buildPrompt(p, items)); notify('Prompt 已复制'); }
    catch { notify('复制失败，请检查剪贴板权限', 'err'); }
  }

  async function closeModal() {
    setDeleteRulesConfirm(false);
    if (busyRef.current) return;
    clearTimeout(autoRef.current);
    if (modal === 'item' && !editing && dirtyRef.current) {
      if (!await act({ op: 'requirementDraft', draft: formRef.current }, true)) return;
      dirtyRef.current = false;
    }
    if (modal === 'item' && editing && dirtyRef.current) {
      if (!await act({ op: 'item', ...formRef.current, id: editing.id }, true)) return;
      dirtyRef.current = false;
    }
    setModal('');
  }

  function download(text: string, file: string) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = file; a.click();
    URL.revokeObjectURL(url);
  }

  if (!data) {
    return (
      <div className="boot">
        {windowBar}
        <img className="mark" src="./app-icon.png" alt="ReqFlow" />
        <h1>ReqFlow · 需求流</h1>
        <p>{error || '正在打开你的工作区…'}</p>
        {error && <button className="btn primary" onClick={() => void load()}>重试</button>}
      </div>
    );
  }

  function renderSidebarProject(pr: Project) {
    const activeItems = pr.items.filter((i) => !i.archived);
    const pendingCount = activeItems.filter((i) => i.status === 'pending_verification').length;
    const countLabel = `${activeItems.length} 条未归档需求，${pendingCount} 条待验证`;
    return (<div key={pr.id} role="button" tabIndex={0}
              draggable={!busy} onDragEnd={projectDragEnd} onDragStart={(e) => { e.dataTransfer.setData(projectDragType, pr.id); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={busy ? undefined : projectDragOver} onDragLeave={projectDragLeave} onDrop={e => { if (!busy) projectDrop(e, pr.id, act); }}
              data-project-id={pr.id}
              className={'side-project' + (p?.id === pr.id ? ' active' : '')}
              onClick={() => switchProject(pr.id)}
              onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); switchProject(pr.id); } }}
              title={pr.name}>
              {isSSH(pr.dir) ? <Server size={16} /> : <Layers size={16} />}
              <span className="project-name">{pr.name}</span>
              {isSSH(pr.dir) && sshConnections[pr.dir!] && (
                <span className={'ssh-status-dot' + (sshConnections[pr.dir!]?.ok ? ' on' : ' off')}
                  role="img"
                  aria-label={sshConnections[pr.dir!]?.ok ? '远程连接正常' : '远程连接已断开'}
                  title={sshConnections[pr.dir!]?.ok ? '远程连接正常' : (sshConnections[pr.dir!]?.error || '远程连接已断开')} />
              )}
              <span className={'small-count' + (pendingCount > 0 ? ' has-pending' : '')} title={countLabel} aria-label={countLabel}>{activeItems.length}</span>
              <button className="side-project-hide" aria-label={'隐藏项目 ' + pr.name} title="隐藏项目" disabled={busy} onClick={async e => {
                e.stopPropagation();
                const result = await act({ op: 'projectVisibility', project: pr.id, hidden: true });
                const next = result && result.projects.find(project => !project.hidden);
                if (result && pr.id === p?.id && next) switchProject(next.id);
              }}><EyeOff size={13} /></button>
              {data!.projects.length > 1 && (
                <button className="side-project-del" aria-label={'删除项目 ' + pr.name} title="删除项目"
                  onClick={(e) => { e.stopPropagation(); setDeleting(pr); setModal('deleteProject'); }}>
                  <Trash size={13} />
                </button>
              )}
            </div>);
  }

  return (
    <div className={"app" + (bridge.windowControl ? " desktop-app" : "")}>
      {toast && <div className={'toast ' + toast.kind}>{toast.text}</div>}

      <aside className="side">
        <div className="brand"><img className="mark" src="./app-icon.png" alt="ReqFlow" /><div>ReqFlow<small>需求流{appVersion ? ` v${appVersion}` : ''}</small></div></div>
        {mode === 'SETTINGS' ? <>
          <div className="side-label">设置</div>
          <nav className="side-projects" aria-label="设置功能菜单">
            <button className="side-project" disabled={settingsBusy} onClick={() => settingsPage.current?.requestLeave()}><FolderOpen size={16} /><span>返回项目菜单</span></button>
            {settingsTabs.map(([id, title]) => <button className={'side-project' + (settingsTab === id ? ' active' : '')} aria-current={settingsTab === id ? 'page' : undefined} key={id} disabled={settingsBusy} onClick={() => setSettingsTab(id)}><Settings size={16} /><span>{title}</span></button>)}
          </nav>
        </> : mode === 'CONTENT' ? <>
          <div className="side-label">上下文管理</div>
          <nav className="side-projects" aria-label="上下文管理功能菜单">
            <button className="side-project" onClick={() => setMode('FLOW')}><FolderOpen size={16} /><span>返回项目菜单</span></button>
            <div className="side-project active" aria-current="page"><FileText size={16} /><span>上下文 · 提示词</span></div>
          </nav>
        </> : <>
        <section className="side-project-section" aria-label="我的项目">
        <div className="side-label side-label-row">我的项目
          <div className="side-project-tools"><button className="icon-btn side-add-folder" aria-label="管理项目" title="排序、隐藏与分组" onClick={() => setProjectManagerOpen(true)}><Settings size={15} /></button>
          <button className="icon-btn side-add-folder" aria-label="新建文件夹" title="新建文件夹" disabled={busy} onClick={() => setFolderForm(!folderForm)}><Plus size={13} /></button>
          </div>
        </div>
        <nav className="side-projects side-project-scroll" aria-label="项目列表">
          {folderForm && <form className="folder-form" onKeyDown={e => { if (e.key === 'Escape' && !busy) { setFolderForm(false); setFolderName(''); } }} onSubmit={async (e) => { e.preventDefault(); if (await act({ op: 'folder', name: folderName })) { setFolderName(''); setFolderForm(false); } }}><label className="field"><input autoFocus aria-label="文件夹名称" value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="文件夹名称" /></label><button className="icon-btn" aria-label="创建文件夹" title="创建文件夹" disabled={busy || !folderName.trim()}><Check size={15} /></button><button type="button" className="icon-btn" aria-label="取消创建文件夹" title="取消" disabled={busy} onClick={() => { setFolderForm(false); setFolderName(''); }}><X size={15} /></button></form>}
          {(data.folders || [{id: 'default', name: 'default'}]).map((folder) => <details open className="project-folder" key={folder.id} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('application/reqflow-project'); if (id) void act({op: 'projectFolder', project: id, folderId: folder.id}); }}><summary><FolderOpen size={14} /><span className="folder-name" title={folder.name}>{folder.name}</span>{folder.id !== 'default' && (
            // REQ-111：鼠标悬浮显示删除按钮；default 固定不可删，删除后项目迁移到 default
            <button className="side-folder-del" aria-label={'删除文件夹 ' + folder.name} title="删除文件夹（项目迁移到 default）"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeletingFolder(folder); setModal('deleteFolder'); }}>
              <Trash size={12} />
            </button>
          )}</summary>{data.projects.filter((pr) => !pr.hidden && (pr.folderId || 'default') === folder.id).map((pr) => (
            renderSidebarProject(pr)
          ))}</details>)}
        </nav>
          <button className="side-project add" onClick={() => { setName(''); setDescription(''); setModal('project'); }}>
            <Plus size={16} /><span>新建项目</span>
          </button>
        </section>
        <button className="side-label side-label-action" onClick={() => { setMode('CONTENT'); setNewMenu(false); }}>上下文管理</button>
        <div className="side-label">协作项目</div>
        <div className="flow-note">开发中<br /><small>后续支持项目同步与协作</small></div>
        </>}
        <div className="side-foot">
          <button className="btn plain" onClick={() => { setModsTab('protocol'); setModsOpen(true); }}><Layers />插件/MOD/AGENT</button>
          <button className={'btn plain' + (mode === 'STATS' ? ' active' : '')} aria-current={mode === 'STATS' ? 'page' : undefined} onClick={() => { setMode('STATS'); setNewMenu(false); }}><BarChart />数据看板</button>
          <button className="btn plain" aria-current={mode === 'SETTINGS' ? 'page' : undefined} onClick={() => { setMode('SETTINGS'); setNewMenu(false); }}><Settings />设置</button>
          <div className="side-help-update"><button className="btn plain" title="帮助 · CLI 参考" onClick={() => setHelpOpen(true)}>
            <HelpCircle size={15} />帮助 · CLI 参考
          </button><UpdateButton /></div>
          <p className="side-hint">本地工作区 · 数据保存在本机</p>
        </div>
      </aside>

      <div className="main-column">
      <main className={"main" + (mode === 'FLOW' ? ' flow-main' : '')}>
        <header className="top">
          <div className="save">
            <Check size={14} />{saved}
            <button className="icon-btn" aria-label="刷新数据" title="数据每 15 秒自动刷新，点击立即刷新" onClick={() => void load()}><RefreshCw size={15} /></button>
          </div>
          {windowBar}
        </header>

        {error && (
          <div className="error">
            {error} <button className="btn plain" onClick={() => void load()}>刷新数据</button>
            <p>当前编辑内容会保留在编辑框中，请确认最新内容后再保存。</p>
          </div>
        )}

        {mode === 'SETTINGS' ? <SettingsPage ref={settingsPage} tab={settingsTab} onBusyChange={setSettingsBusy} onLeave={() => { setMode('FLOW'); void load({ quiet: true }); }} notify={notify} onArchived={() => void load({ quiet: true })} onExport={async () => {
          const result = await bridge.getWorkspace();
          if (!result.ok) throw Error(result.error || '读取工作区失败');
          download(JSON.stringify(result.state, null, 2), 'reqflow-backup.json');
          notify('全部数据已导出');
        }} /> : mode === 'STATS' ? <div className="stats-page"><div className="stats-page-heading"><div><h1><BarChart size={22} />数据看板</h1><p>查看需求增长与 AI 执行情况</p></div><button className="btn" onClick={() => setMode('FLOW')}><FolderOpen />返回项目</button></div><StatsPanel workspace={data} /></div> : mode === 'CONTENT' ? <ContentWorkspace projects={data.projects} prompts={data.contextPrompts || []} busy={busy} apply={act} notify={notify} /> : <>
        <section className="title-row">
          <div>
            <div className="eyebrow">PROJECT WORKSPACE</div>
            <h1>{p?.name}</h1>
            {backgroundEditing ? <form className="background-editor" onSubmit={async (e) => { e.preventDefault(); if (await act({ op: 'projectDescription', description })) setBackgroundEditing(false); }}>
              <textarea autoFocus aria-label="项目背景" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setBackgroundEditing(false); }} />
              <div className="settings-actions"><button className="btn sm primary" disabled={busy}>保存背景</button><button type="button" className="btn sm" onClick={() => setBackgroundEditing(false)}>取消</button></div>
            </form> : <button className="project-background" title="点击编辑项目背景" onClick={() => { setDescription(p?.description || ''); setBackgroundEditing(true); }}>{p?.description || '点击添加项目背景、技术栈与运行方式'}</button>}
          </div>
          <div className="title-actions">
            <button className="btn" onClick={browseProject} title={p?.dir ? '浏览项目文件：' + p.dir : '关联本地项目目录并浏览文件'}>
              <FolderOpen size={16} />{p?.dir ? '浏览项目' : '关联目录'}
            </button>
            {!!publishScript && p?.dir && (
              <button className="btn accent" disabled={publishing}
                onClick={() => { if (pendingVerifyItems.length) setPublishConfirm(true); else void runPublish(); }}
                title={pendingVerifyItems.length ? `有 ${pendingVerifyItems.length} 条需求待验证，点击发布时先确认` : '运行发布脚本：' + publishScript}>
                <Rocket size={16} />{publishing ? publishStep || '发布中…' : '发布'}
              </button>
            )}
            {terminalDetached && <button className="btn" onClick={() => void detachTerminal().catch(e => notify(e.message, 'err'))}>终端</button>}
            {!!p?.verifySource && (
              <button className="btn run" onClick={runVerifySource} title={'运行验证源：' + p.verifySource.value}>
                <Play size={16} />运行
              </button>
            )}
            <div className="new-requirement-split" ref={newMenuRef} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setNewMenu(false); }}><button className="btn primary" onClick={() => edit()}><Plus size={17} />记录新需求</button><button className="btn primary" aria-label="选择记录需求方式" aria-expanded={newMenu} onClick={() => setNewMenu(!newMenu)}><ChevronDown size={17} /></button>{newMenu && <div className="new-requirement-menu"><button type="button" onClick={() => { setNewMenu(false); setAiOpen(true); }}>AI 需求</button><button type="button" onClick={() => { setNewMenu(false); setContextFeature(''); setContextWizard(true); }}>功能转上下文</button><button type="button" onClick={editBaseline} title="按模板生成检查 .gitignore、输出目录与 scripts/ 脚本的基线需求">基线需求</button>{!publishScript && <button type="button" onClick={editPublish} title="生成在 scripts/ 下创建 publish 发布脚本的需求；完成后「浏览项目」旁出现「发布」按钮一键执行">发布功能需求</button>}</div>}</div>
          </div>
        </section>

        <section className="guidance">
          <div className="guide-symbol"><FileText size={20} /></div>
          <div className="guide-main">
            <h2>项目设置 <span>v{p?.guideVersion}</span></h2>
            <p>{p?.guidance}</p>
            <div className="guide-settings-summary">
              {p?.dir && <button type="button" className="linked-dir" title={p.dir + '（点击确认后从资源管理器打开）'} onClick={() => isSSH(p.dir) ? setBrowserOpen(true) : setDirConfirm(true)}><FolderOpen size={13} />{p.dir}</button>}
              {/* REQ-147：以简要标志说明项目设置，替代「新需求的默认设置」占位，保持一行 */}
              {p?.contextRules && <button className="btn sm" onClick={() => setRulesOpen(true)}>守则</button>}
              <span className={'guide-flag' + (p?.guidance ? ' on' : '')} title={p?.guidance ? '已配置项目引导词' : '未配置项目引导词'}>{p?.guidance && <Check size={12} />}引导词</span>
              <span className={'guide-flag' + (p?.deliveryGuidance ? ' on' : '')} title={p?.deliveryGuidance ? '已配置引导交付' : '未配置引导交付'}>{p?.deliveryGuidance && <Check size={12} />}引导交付</span>
              <span className="guide-flag" title="该项目记录的全部需求数">历史需求 {p?.items.length ?? 0} 条</span>
            </div>
          </div>
          <button className="btn plain" onClick={() => {
            setGuide(p!.guidance); setDelivery(p!.deliveryGuidance);
            setRulesLimit(p!.contextRulesLimit || DEFAULT_CONTEXT_RULES_LIMIT);
            setVerifyKind(p!.verifySource?.kind || 'none'); setVerifyValue(p!.verifySource?.value || '');
            setPublishMode(p!.publishScript === undefined ? 'auto' : p!.publishScript ? 'script' : 'none'); setPublishPath(p!.publishScript || '');
            setBaselineTpl(p!.baselineTemplate || '');
            setGuideTab('guide');
            setModal('guide');
          }}>编辑设置</button>
        </section>

        <div className="workspace-grid single">
          <section className="requirements">
            <div className="navtabs">
              {shownPhases.map(([v, l]) => (
                <button key={v} className={'navtab' + (tab === v ? ' active' : '')} onClick={() => changeTab(v)}>
                  {l}
                  <span>{v === 'executing' ? executingItems.length : v === 'generate' ? allInProgress.length
                    : p!.items.filter((i) =>
                      v === 'archived' ? !!i.archived : !i.archived && (v === 'feature' ? i.status === 'ready' && !activeAIExecution(i) && !scheduledBatch(p!, i) : i.status === v)).length}</span>
                </button>
              ))}
            </div>

            {/* REQ-139/140：批次与排序信息固定在需求列表上方，不随列表滚动 */}
            {(tab === 'feature' || tab === 'generate') && (
              <div className="list-header">
                {tab === 'feature' && <div className="requirement-sort segmented" role="group" aria-label="需求排序">{[['desc', '最新在前'], ['asc', '最早在前'], ['priority', '优先级']].map(([id, label]) => <button key={id} aria-pressed={sort === id} className={sort === id ? 'on' : ''} onClick={() => setSort(id)}>{label}</button>)}</div>}
                {tab === 'generate' && <>
                  <span className="gen-count">{batch ? '批次 ' + String(batch.number).padStart(2, '0') : '暂无批次'}</span>
                  <div className="segmented" role="group" aria-label="排期日期范围">{[['through', '日期及之前'], ['exact', '当天'], ['all', '全部日期']].map(([id, label]) => <button key={id} className={scheduleMode === id ? 'on' : ''} aria-pressed={scheduleMode === id} onClick={() => setScheduleMode(id)}>{label}</button>)}</div>
                  <input type="date" className="gen-date" aria-label="排期筛选日期" value={scheduleDate} onChange={e => { if (e.target.value) setScheduleDate(e.target.value); }} disabled={scheduleMode === 'all'} />
                  {stale && <p className="warning gen-warning">源内容已变化，请退回需求池后重新排期。</p>}
                </>}
              </div>
            )}

            <div className="list-scroll">
              {viewingHistory ? (
              <div className="batch-list">
                {p!.batches.length === 0 ? (
                  <div className="empty"><History size={28} /><h3>还没有批次</h3><p>选择待执行需求，创建第一轮排期。</p></div>
                ) : p!.batches.map((b) => (
                  <article key={b.id} className={'batch-card' + (batch?.id === b.id ? ' chosen' : '')}>
                    <button className="batch-open" title="查看该批次的归档需求" onClick={() => { setArchiveBatchId(b.id); setArchiveView('items'); setArchiveDate(''); }}>
                      <strong>批次 {String(b.number).padStart(2, '0')}</strong>
                      <span>开发任务 · {b.items.length} 条需求 · 已归档 {(p?.items || []).filter(i => i.archived && b.items.some((old) => old.id === i.id)).length} 条</span>
                      <small>{new Date(b.time).toLocaleString('zh-CN')}</small>
                    </button>
                    <span className={'batch-badge ' + b.status}>
                      {({ draft: '未提交', submitted: '已提交', cancelled: '已取消' } as any)[b.status]}
                    </span>
                    {b.status === 'submitted' && (
                      <button className="btn plain" disabled={busy} onClick={() => act({ op: 'cancel', batch: b.id })}>取消执行</button>
                    )}
                    <div className="batch-ids">{b.items.map((i) => (i.number + ' ' + i.title).trim()).join(' · ')}</div>
                  </article>
                ))}
              </div>
            ) : (
              <>
                {!shownItems.length && (
                  <div className="empty"><Layers size={28} /><h3>{archiveBatch ? '该批次还没有归档的需求' : query ? '没有匹配的需求' : tab === 'executing' ? '没有正在执行的任务' : tab === 'generate' ? '还没有待开发的需求' : '这里还没有需求'}</h3>
                    <p>{archiveBatch ? '批次中的需求完成验证后会归档到这里。'
                      : tab === 'feature' ? '记录想法，按需求说明加入下一轮任务。'
                      : tab === 'generate' ? '排期后需求进入这里跟踪；开发完成后提交验证。'
                      : '需求进入此阶段后，会在这里显示。'}</p></div>
                )}

                {tab === 'archived' && archiveBatch && (
                  <div className="archive-batch-bar">
                    <strong>批次 {String(archiveBatch.number).padStart(2, '0')}</strong>
                    <span className="gen-count">开发任务 · {archiveBatch.items.length} 条需求 · 已归档 {shownItems.length} 条 · 创建于 {new Date(archiveBatch.time).toLocaleString('zh-CN')}</span>
                    <button className="btn sm" onClick={() => setArchiveBatchId('')}>返回全部归档</button>
                  </div>
                )}

                {tab === 'archived' && !archiveBatch && archiveDates.length > 0 && (
                  <nav className="archive-folders" aria-label="归档日期文件夹">
                    <button className={'archive-row archive-root' + (!archiveDate ? ' chosen' : '')} onClick={() => setArchiveDate('')}><FolderOpen size={16} /><strong>全部日期</strong><span>{visible.length} 条需求</span></button>
                    {archiveTree.years.map(n => (
                      <div className="archive-branch" key={n.year}>
                        <button className="archive-row" aria-expanded={archiveOpenYear === n.year} onClick={() => { const opening = archiveOpenYear !== n.year; setArchiveOpenYear(opening ? n.year : ''); setArchiveOpenMonth(opening ? n.months[0]?.month || '' : ''); }}>
                          <ChevronDown size={14} className={'archive-chevron' + (archiveOpenYear === n.year ? ' open' : '')} /><FolderOpen size={17} /><strong>{n.year} 年</strong><span>{n.count} 条</span>
                        </button>
                        {archiveOpenYear === n.year && n.months.map(m => (
                          <div className="archive-branch" key={m.month}>
                            <button className="archive-row archive-month" aria-expanded={archiveOpenMonth === m.month} onClick={() => setArchiveOpenMonth(archiveOpenMonth === m.month ? '' : m.month)}>
                              <ChevronDown size={14} className={'archive-chevron' + (archiveOpenMonth === m.month ? ' open' : '')} /><FolderOpen size={16} /><strong>{Number(m.month)} 月</strong><span>{m.count} 条</span>
                            </button>
                            {archiveOpenMonth === m.month && m.days.map(d => (
                              <button key={d.date} className={'archive-row archive-day' + (archiveDate === d.date ? ' chosen' : '')} onClick={() => setArchiveDate(d.date)}>
                                <FolderOpen size={15} /><strong>{Number(d.day)} 日</strong><span>{d.count} 条</span>
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    ))}
                    {archiveTree.unknown.map(date => (
                      <button key={date} className={'archive-row archive-day' + (archiveDate === date ? ' chosen' : '')} onClick={() => setArchiveDate(date)}><FolderOpen size={16} /><strong>{date}</strong><span>{visible.filter(i => archivedDate(i) === date).length} 条</span></button>
                    ))}
                  </nav>
                )}
                {[...shownItems].sort(tab === 'archived' ? compareArchivedItems : tab === 'feature' && sort !== 'priority' ? (a, b) => (sort === 'desc' ? -1 : 1) * (Number(a.number.replace('REQ-', '')) - Number(b.number.replace('REQ-', ''))) : (a, b) => a.priority.localeCompare(b.priority)).map((i) => tab === 'archived' ? (
                  // REQ-141：归档需求合并为一行一条，正文缩略显示，其余信息放进「查看详情」
                  <article key={i.id} className="archived-item">
                    <code>{i.number}</code>
                    <span className={'badge ' + i.type}>{labels[i.type]}</span>
                    <span className="priority">{i.priority}</span>
                    <button className="archived-excerpt" title={(i.title ? i.title + '\n\n' : '') + (i.body || '暂无详细说明')} onClick={() => { setEditing(i); setModal('detail'); }}>
                      {(i.title ? i.title + ' — ' : '') + (i.body || '暂无详细说明')}
                    </button>
                    <span className="archived-date">{archivedDate(i)}</span>
                    <div className="archived-item-actions">
                      <button className="btn sm" disabled={busy} onClick={() => { setEditing(i); setNote(''); setModal('regress'); }}>重新打开</button>
                      <button className="btn sm" onClick={() => { setEditing(i); setModal('detail'); }}>查看详情</button>
                    </div>
                  </article>
                ) : (
                  <article key={i.id} className={'req-card' + (selected.includes(i.id) ? ' chosen' : '')}>
                    {tab === 'feature' && eligible(i) && (
                      <div className="card-selection">
                        <input type="checkbox" checked={selected.includes(i.id)} aria-label={'选择 ' + (i.title || i.number)}
                          onChange={(e) => setSelected(e.target.checked ? [...selected, i.id] : selected.filter((id) => id !== i.id))} />
                      </div>
                    )}
                    <div className="card-body">
                      <div className="meta">
                        <code>{i.number}</code>
                        <span className={'badge ' + i.type}>{labels[i.type]}</span>
                        <span className="priority">{i.priority}</span>
                        <span className={'status ' + (activeAIExecution(i) ? 'executing' : i.status)}>{activeAIExecution(i) ? '执行中' : labels[i.status]}</span>
                        <span className="revision">v{i.version}</span>{i.deferred && <span className="badge improvement" title="全选时跳过，仍可手动勾选或单条排期">已延迟</span>}<span className="revision">{executorLabel(i.executor)}</span>{i.scheduledDate && <span className="revision">计划 {i.scheduledDate}</span>}{pendingCommitItems(p!).some((x) => x.id === i.id) && <span className="badge improvement">待 Git 提交</span>}
                      </div>
                      {i.title && <button className="item-title" title={i.title} onClick={() => { setEditing(i); setModal('detail'); }}>{i.title}</button>}
                      <p className="body-copy" title={i.body || undefined}>{i.body || '暂无详细说明'}</p>{!!i.attachments?.length && <button className="btn sm" onClick={() => { setEditing(i); setModal('detail'); }}>参考图片 · {i.attachments.map((a) => a.label).join('、')}</button>}
                      {unresolvedFailures(i).length > 0 && (
                        <div className="failure-content">
                          <strong>未通过的问题</strong>
                          {unresolvedFailures(i).map((f, n) => (
                            <p key={n}>
                              {unresolvedFailures(i).length > 1 ? (f.current ? '【新问题】' : '【仍未修复】') : ''}{f.note}
                            </p>
                          ))}
                          <p>重新生成 Prompt 时会自动带上以上内容。</p>
                        </div>
                      )}
                      <div className="criteria">
                        {i.criteria.length ? i.criteria.map((c, n) => <p key={n}><Check size={13} />{c}</p>)
                          : <p>按需求说明确认结果即可。</p>}
                      </div>
                      {i.status === 'pending_verification' && i.completionNote && i.completionNoteVersion === i.version && <div className="completion-note"><strong>开发完成说明</strong><p>{i.completionNote}</p></div>}
                      {i.aiExecution && <div className="execution-info">
                        <strong>{clientLabels[i.aiExecution.client]} {activeAIExecution(i) ? '正在执行' : i.aiExecution.outcome === 'completed' ? '执行完成' : '任务已释放'}</strong>
                        <span>开始 {new Date(i.aiExecution.startedAt).toLocaleString('zh-CN')}</span>
                        <span>{activeAIExecution(i) ? '已执行 ' + executionDuration(i.aiExecution.startedAt, executionClock) : '用时 ' + executionDuration(i.aiExecution.startedAt, Date.parse(i.aiExecution.endedAt || i.aiExecution.startedAt))}</span>
                      </div>}
                      <div className="next-step">
                        {activeAIExecution(i) ? '任务已被独占领取；AI 完成后会进入待验证。中断后可手动释放任务。' : i.status === 'ready' ? '点击排期转入待开发，或勾选后批量排期。'
                          : i.status === 'in_progress' ? '开发完成后提交验证；需修改时退回需求池重新编辑。'
                          : i.status === 'pending_verification' ? '验证完成后，直接记录通过或未通过。'
                          : '已归档，历史记录仍可查看。'}
                      </div>
                      <div className="card-actions">
                        {!activeAIExecution(i) && <>
                        {i.status === 'in_progress' && <button className="btn" onClick={() => copyPrompt([i])}>复制 Prompt</button>}
                        {i.status === 'ready' && tab === 'generate' && <button className="btn accent" disabled={busy} onClick={async () => { const draft = scheduledBatch(p!, i); if (draft && await act({ op: 'submit', batch: draft.id }, true)) notify('已继续排期，进入待开发'); }}>继续排期</button>}
                        {i.status === 'ready' && tab !== 'generate' && <button className="btn accent" disabled={busy} onClick={() => generate([i.id])}>排期</button>}
                        {i.status === 'ready' && tab !== 'generate' && <button className="btn" disabled={busy} onClick={() => edit(i)}>编辑</button>}
                        {tab === 'feature' && i.status === 'ready' && <button className="btn" disabled={busy} aria-pressed={!!i.deferred} title="延迟需求不会被全选选中，仍可手动勾选或单条排期" onClick={async () => {
                          if (await act({ op: 'deferItem', id: i.id, deferred: !i.deferred }, true)) {
                            if (!i.deferred) setSelected(ids => ids.filter(id => id !== i.id));
                            notify(i.deferred ? '已取消延迟' : '已延迟，全选时将跳过');
                          }
                        }}>{i.deferred ? '取消延迟' : '延迟'}</button>}
                        {i.status === 'ready' && tab !== 'generate' && <button className="btn" disabled={busy} onClick={() => {
                          setEditing(i); setTargetProject(data.projects.find((pr) => pr.id !== p?.id)?.id || ''); setModal('moveItem');
                        }}>迁移到其他项目</button>}
                        {i.status === 'ready' && tab !== 'generate' && <button className="btn" disabled={busy} onClick={() => {
                          setEditing(i); setModal('deleteItem');
                        }}><Trash size={14} />删除</button>}
                        {i.status === 'in_progress' && <button className="btn primary" disabled={busy} onClick={() => submitItem(i)}>提交验证</button>}
                        {i.status === 'in_progress' && <button className="btn" disabled={busy} onClick={() => revertItem(i)}>退回需求池</button>}
                        {i.status === 'pending_verification' && (
                          <>
                            <button className="btn accent" disabled={busy} onClick={() => recordPass(i)}>通过并归档</button>
                            <button className="btn" disabled={busy} onClick={() => { setEditing(i); setNote(''); setFixedIdx([]); setModal('verify'); }}>未通过，退回</button>
                          </>
                        )}
                        {i.status === 'archived' && <button className="btn" disabled={busy} onClick={() => { setEditing(i); setNote(''); setModal('regress'); }}>重新打开</button>}
                        </>}
                        {activeAIExecution(i) && <button className="btn" disabled={busy} onClick={() => setReleaseItem(i)}>释放任务</button>}
                        <button className="btn" onClick={() => { setEditing(i); setModal('detail'); }}>查看详情</button>
                        {/* 实验室开关开启后，在「查看详情」后面显示 Codex 派发按钮 */}
                        {tab === 'generate' && !activeAIExecution(i) && localAgents?.includes('codex') && <button className="btn" disabled={codexBusy || !p?.dir || (i.executor || 'ai') !== 'ai'} title="发送给 Codex" onClick={() => void dispatchCodex(i)}>Codex</button>}
                      </div>
                    </div>
                  </article>
                ))}
                <footer className="list-foot">
                  <span>{tab === 'archived' && !archiveDate && !archiveBatch ? visible.length : shownItems.length} 条需求{tab === 'archived' && !archiveDate && !archiveBatch ? ` · ${archiveTree.years.length} 个年份 · ${archiveDates.length} 个日期文件夹` : ''}</span>
                  <span>{tab === 'archived' ? '归档时间倒序' : '优先级排序'}{tab === 'feature' ? ` · 已选择 ${picked.length} 条` : ''}</span>
                </footer>
              </>
              )}
            </div>
            <div className="workspace-toolbar" aria-label="需求操作与筛选">
              {!viewingHistory && <div className="workspace-filters">
                <div className="segmented" role="group" aria-label="按需求类型筛选">{['all', 'feature', 'improvement', 'bug'].map(type => <button key={type} className={typeFilter === type ? 'on' : ''} aria-pressed={typeFilter === type} onClick={() => { setTypeFilter(type); setArchiveDate(''); }}>{type === 'all' ? '全部' : labels[type]}</button>)}</div>
                <div className="search"><Search size={15} /><input aria-label="搜索需求" value={query} onChange={e => { setQuery(e.target.value); setArchiveDate(''); }} placeholder="搜索需求" /></div>
              </div>}
              <div className="workspace-actions">
                {tab === 'feature' && <><label className="check-label"><input type="checkbox"
                  checked={visible.filter(bulkEligible).length > 0 && visible.filter(bulkEligible).every(i => selected.includes(i.id))}
                  onChange={e => setSelected(e.target.checked ? [...new Set([...selected, ...visible.filter(bulkEligible).map(i => i.id)])] : selected.filter(id => !visible.some(i => i.id === id)))} />全选需求</label>
                  <button className="btn primary" disabled={busy || picked.length === 0} onClick={() => generate()}>排期 · 已选 {picked.length} 条</button></>}
                {tab === 'generate' && <><strong>本轮排期</strong><span className="gen-count">当前 {inProgress.length} / 全部 {allInProgress.length} 条</span>
                  <button className="btn" disabled={inProgress.length === 0} onClick={() => copyPrompt(inProgress)}>复制全部 Prompt</button>
                  <button className="btn primary" disabled={busy || inProgress.length === 0} onClick={completeBatch}><Check size={15} />提交验证 · 当前 {inProgress.length} 条</button></>}
                {tab === 'executing' && <><strong>执行中</strong><span className="gen-count">{visible.length} 条任务正在由 AI 执行</span></>}
                {tab === 'pending_verification' && <><strong>待验证</strong><span className="gen-count">{visible.length} 条需求</span></>}
                {tab === 'archived' && <div className="archive-navigation segmented" role="group" aria-label="归档次级入口">
                  <button className={archiveView === 'items' ? 'on' : ''} aria-pressed={archiveView === 'items'} onClick={() => { setArchiveView('items'); setArchiveBatchId(''); }}>归档需求</button>
                  <button className={archiveView === 'batches' ? 'on' : ''} aria-pressed={archiveView === 'batches'} onClick={() => setArchiveView('batches')}>批次历史 · {p!.batches.length}</button>
                </div>}
              </div>
            </div>
          </section>


        </div>

        </>}
      </main>
      {contextWizard && p && <div className="overlay" role="dialog" aria-modal="true" aria-label="功能转上下文"><form className="dialog" onSubmit={e => {
        e.preventDefault(); setContextWizard(false); edit();
        const feature = contextFeature.trim();
        setForm({ ...defaultRequirementForm(), body: [
          '将现有功能「' + feature + '」整理为一条项目上下文。',
          '只说明这个上下文与该功能的联系，不需要完整架构：简述功能职责、关键入口或文件、与相邻模块的边界与约束，保持精简。不要臆造不存在的实现。',
          '同时把相关代码文件带入上下文管理：阅读该功能的实现，选择相关源代码文件，保留原始文件内容与项目相对路径，不要把代码改写成 Markdown 摘录。',
          '只有功能总结保存为 Markdown。通过 --files 指定项目内的原始代码文件，系统会复制到每个上下文片段的独立目录并用 Git 管理：',
          'ReqFlow.exe --cli context put --project ' + p.id + ' --feature ' + JSON.stringify(feature) + ' --title ' + JSON.stringify(feature + ' · 功能文档') + ' --file "<说明文件绝对路径>" --files "相对路径1,相对路径2"',
          '先运行 context list 检查已有文档；更新时在 context put 中携带 --id，避免重复创建。使用当前 ReqFlow 数据目录。',
          '提交后运行 context list 确认说明、相关代码和项目关联；如返回 warning，解决目录或 Git 同步问题。守则会自动生成并加入后续需求 Prompt。'
        ].join('\n\n') });
      }}><div className="dialog-head"><h3>功能转上下文</h3><button type="button" className="icon-btn" aria-label="关闭" onClick={() => setContextWizard(false)}><X /></button></div><label className="field">指定现有功能<input autoFocus required value={contextFeature} onChange={e => setContextFeature(e.target.value)} placeholder="例如：需求排期、终端" /></label><p className="muted">生成一条需求，由 Agent 阅读代码并通过 CLI 提交该功能与上下文的简短说明及相关代码。</p><div className="settings-actions"><button type="button" className="btn" onClick={() => setContextWizard(false)}>取消</button><button className="btn primary" disabled={!contextFeature.trim()}>生成需求</button></div></form></div>}
      {rulesOpen && p && <div className="overlay" role="dialog" aria-modal="true" aria-label="项目守则" onClick={e => { if (e.target === e.currentTarget) setRulesOpen(false); }}><div className="dialog"><div className="dialog-head"><div><h3>项目守则 · 自动生成</h3><p>{Array.from(p.contextRules || '').length} / {p.contextRulesLimit || DEFAULT_CONTEXT_RULES_LIMIT} 字 · 仅保留上下文与功能的联系</p></div><button className="icon-btn" aria-label="关闭守则" onClick={() => setRulesOpen(false)}><X /></button></div><div className="md-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.contextRules || '') }} /></div></div>}
      {terminalEnabled && !terminalDetached && terminalSession?.terminalRunId && terminalSession.terminalOpen && p && <PublishTerminal key={terminalSession.terminalRunId} runId={terminalSession.terminalRunId} project={p.name} session={terminalSession} onDetach={bridge.openPublishTerminal ? detachTerminal : undefined} onClose={() => setTerminalOpen(p.id, false)} />}
      {terminalEnabled && !terminalDetached && terminalSession?.terminalRunId && !terminalSession.terminalOpen && p && <button className="publish-terminal-reopen" onClick={() => setTerminalOpen(p.id, true)}>打开终端{publishing ? ' · 执行中' : ''}</button>}
      </div>

      {releaseItem && <div className="overlay" role="dialog" aria-modal="true" aria-label="释放 AI 任务" onClick={e => { if (e.target === e.currentTarget && !busy) setReleaseItem(null); }}>
        <div className="dialog"><div className="dialog-head"><h3>释放 AI 任务</h3><button className="icon-btn" disabled={busy} aria-label="关闭释放确认" onClick={() => setReleaseItem(null)}><X /></button></div>
          <p>确认 {releaseItem.number} 的 {releaseItem.aiExecution && clientLabels[releaseItem.aiExecution.client]} 已停止执行后释放。释放后其他 AI 可以领取，原运行记录将不能再提交完成。</p>
          <div className="settings-actions"><button className="btn" disabled={busy} onClick={() => setReleaseItem(null)}>取消</button><button className="btn primary" disabled={busy} onClick={async () => { if (await act({ op: 'executionRelease', id: releaseItem.id, run: releaseItem.aiExecution?.runId, note: '用户手动释放中断任务' })) { setReleaseItem(null); notify('任务已释放，可重新领取'); } }}>确认释放</button></div>
        </div></div>}
      {aiOpen && p && <AIRequirements key={p.id} project={p} onClose={() => setAiOpen(false)} insert={async (items) => { const r = await act({op: 'aiItems', items: items.map((i) => ({...i, criteria: i.criteria.join('\n')}))}); if (r) { setTab('feature'); notify('AI 需求已加入待执行'); } return !!r; }} />}
      {directoryPicker && <div className="overlay" role="dialog" aria-modal="true" aria-label="选择项目目录"><div className="dialog"><h3>选择项目目录</h3><p>绑定本地文件夹，或连接远程服务器选择目录。</p><div className="settings-actions"><button className="btn" onClick={async () => { const r = await bridge.pickDir?.(); if (r?.ok && r.dir && await act({ op: 'projectDir', dir: r.dir }, true)) { setDirectoryPicker(false); setBrowserOpen(true); } }}>本地文件夹</button><button className="btn primary" onClick={() => { setDirectoryPicker(false); setSSHPicker(true); }}>远程服务器</button><button className="btn" onClick={() => setDirectoryPicker(false)}>取消</button></div></div></div>}
      {sshPicker && <SSHDirectory initial={p?.dir} onClose={() => setSSHPicker(false)} onSelect={async dir => { if (await act({ op: 'projectDir', dir }, true)) { setSSHPicker(false); setBrowserOpen(true); } else { throw Error('项目目录未保存，请查看主界面提示'); } }} />}
      {projectManagerOpen && <ProjectManager data={data} busy={busy} act={act} onClose={() => setProjectManagerOpen(false)} />}
      {modsOpen && <ModsOverlay initialTab={modsTab} projectDir={p?.dir} onClose={() => setModsOpen(false)} />}
      {completeConfirm && <div className="overlay" role="dialog" aria-modal="true" aria-label="确认任务已完成" onClick={e => { if (!busy && !completing && e.target === e.currentTarget) setCompleteConfirm(null); }}>
        <div className="dialog"><div className="dialog-head"><div><h3>确认任务已完成</h3><p>确认以下 {completeConfirm.items.length} 条需求已经完成，再提交到待验证。</p></div><button className="icon-btn" disabled={busy || completing} aria-label="关闭确认框" onClick={() => setCompleteConfirm(null)}><X /></button></div>
          <div className="assign-list">
            {completeConfirm.items.map((item) => {
              const fresh = p?.items.find((i) => i.id === item.id);
              const executor = fresh?.executor || 'ai';
              return (
                <div className="assign-row" key={item.id}>
                  <div className="assign-row-info">
                    <code>{item.number}</code>
                    {fresh?.title && <span className="assign-title" title={fresh.title}>{fresh.title}</span>}
                    <span className={'assign-state' + (executor === 'ai' ? '' : ' assigned')}>{executorLabel(executor)}</span>
                  </div>
                  <div className="assign-row-actions">
                    {localAgents?.includes('codex') && <button className="btn sm" disabled={codexBusy || !p?.dir || executor !== 'ai'} title="发送给 Codex" onClick={() => { if (fresh) void dispatchCodex(fresh); }}>Codex</button>}
                    {(localAgents || []).filter(id => id !== 'codex').map((id) => (
                      <button key={id} className="btn sm" disabled={busy || completing || executor === 'agent:' + id}
                        title={executor === 'agent:' + id ? '当前已指派给 ' + agentName(id) : '指派给 ' + agentName(id) + ' 执行'}
                        onClick={() => void assignItems([item.id], 'agent:' + id)}>指派给 {agentName(id)}</button>
                    ))}
                    {executor !== 'ai' && (
                      <button className="btn sm" disabled={busy || completing} title="取消指派，恢复默认 AI 执行"
                        onClick={() => void assignItems([item.id], 'ai')}>取消指派</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {localAgents && localAgents.length === 0 && <p className="settings-hint">还没有已配置的 Agent，可先在插件/MOD/AGENT 面板配置。</p>}
          {!!localAgents?.length && <p className="settings-hint">指派决定需求由哪个 Agent 领取执行；取消指派恢复默认 AI 执行。</p>}
          <div className="settings-actions"><button className="btn" disabled={busy || completing} onClick={() => setCompleteConfirm(null)}>取消</button><button className="btn primary" disabled={busy || completing} onClick={() => void confirmComplete()}>确认已完成，提交验证</button><button className="btn plain" disabled={busy || completing} onClick={() => { setCompleteConfirm(null); setModsTab('agents'); setModsOpen(true); }}>配置 Agent</button></div>
        </div></div>}
      {publishConfirm && pendingVerifyItems.length > 0 && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="还有未验证的功能"
          onClick={(e) => { if (!publishing && e.target === e.currentTarget) setPublishConfirm(false); }}>
          <div className="dialog">
            <div className="dialog-head">
              <div>
                <h3>还有未验证的功能</h3>
                <p>当前项目有 {pendingVerifyItems.length} 条需求处于待验证，发布前建议先完成验证。</p>
              </div>
              <button className="icon-btn" aria-label="关闭确认框" onClick={() => setPublishConfirm(false)}><X size={18} /></button>
            </div>
            <p className="detail-body">{pendingVerifyItems.map((i) => (i.title ? `${i.number} · ${i.title}` : i.number)).join('、')}</p>
            <div className="settings-actions">
              <button className="btn" onClick={() => setPublishConfirm(false)}>取消</button>
              <button className="btn" disabled={publishing} onClick={() => void runPublish()}>仍要发布</button>
              <button className="btn primary" onClick={() => { setPublishConfirm(false); changeTab('pending_verification'); }}>去验证</button>
            </div>
          </div>
        </div>
      )}
      {/* REQ-146：从资源管理器打开项目目录前的确认浮层 */}
      {dirConfirm && !!p?.dir && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="从资源管理器打开项目目录"
          onClick={(e) => { if (e.target === e.currentTarget) setDirConfirm(false); }}>
          <div className="dialog">
            <div className="dialog-head">
              <div>
                <h3>从资源管理器打开</h3>
                <p>将在系统资源管理器中打开项目目录。</p>
              </div>
              <button className="icon-btn" aria-label="关闭确认框" onClick={() => setDirConfirm(false)}><X size={18} /></button>
            </div>
            <p className="detail-body">{p.dir}</p>
            <div className="settings-actions">
              <button className="btn" onClick={() => setDirConfirm(false)}>取消</button>
              <button className="btn primary" onClick={() => void openProjectDir()}>打开目录</button>
            </div>
          </div>
        </div>
      )}
      {publishResult && !(terminalEnabled && terminalSession?.terminalRunId) && (
        <div className="overlay" role="dialog" onClick={(e) => { if (e.target === e.currentTarget) setPublishResult(null); }}>
          <div className="dialog publish-dialog">
            <div className="dialog-head">
              <div>
                <h3>{publishResult.ok ? '发布完成' : '发布失败'}</h3>
                <p>{publishResult.ok ? '发布脚本已执行完毕，产物位置见输出末尾。' : (publishResult.error || '发布脚本执行失败') + '，修正后可重试。'}</p>
              </div>
              <button className="icon-btn" aria-label="关闭" onClick={() => setPublishResult(null)}><X size={18} /></button>
            </div>
            <pre className="publish-output">{publishResult.output || publishResult.error || '（脚本无输出）'}</pre>
          </div>
        </div>
      )}
      {bodyExpanded && modal === 'item' && (
        <div className="overlay body-expand-overlay" role="dialog" aria-label="放大编辑需求说明" onClick={(e) => { if (e.target === e.currentTarget) setBodyExpanded(false); }}>
          <div className="dialog body-expand-dialog">
            <div className="dialog-head">
              <div>
                <h3>需求说明</h3>
                <p>放大编辑需求正文，改动即时同步回表单并自动保存。</p>
              </div>
              <button className="icon-btn" aria-label="收起放大编辑" onClick={() => setBodyExpanded(false)}><X size={18} /></button>
            </div>
            <FileMentionTextarea root={p?.dir || ''} label="需求说明" wrapClassName="body-expand-mention" className="body-expand-input" autoFocus value={form.body} onChange={(body) => change({ ...form, body })}
              placeholder={form.type === 'bug' ? '复现步骤、实际表现与预期行为' : '描述要实现的行为、约束或目标指标'} />
          </div>
        </div>
      )}
      {/* 弹窗上方仅保留透明窗口拖动层。 */}
      {modal === 'item' && bridge.windowControl && (
        <div className="modal-window-bar" aria-hidden="true" />
      )}
      {deleteRulesConfirm && modal === 'guide' && p && <div className="overlay" style={{ zIndex: 70 }}><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-rules-title"><div className="dialog-head"><h3 id="delete-rules-title">删除项目守则？</h3></div><p>删除后，守则将不再加入后续排期 Prompt。关联的上下文文档保留，可在此重新生成守则。</p><div className="dialog-actions"><button className="btn" disabled={busy} onClick={() => setDeleteRulesConfirm(false)}>取消</button><button className="btn danger" disabled={busy} onClick={async () => { if (await act({ op: 'guidance', text: p.guidance, contextRulesDisabled: true }, true)) setDeleteRulesConfirm(false); }}>确认删除</button></div></div></div>}
      {modal && (
        <div className="overlay" role="dialog" onClick={(e) => { if (e.target === e.currentTarget) void closeModal(); }}>
          <div className={'dialog' + (modal === 'item' ? ' requirement-dialog' : modal === 'guide' ? ' settings-dialog project-guide-dialog' : '')}>
            <div className="dialog-head">
              <div>
                <h3>{({ item: editing ? '编辑需求' : '记录新需求', project: '创建项目', guide: '项目与交付设置', detail: editing ? (editing.title ? editing.number + ' · ' + editing.title : editing.number) : '', verify: editing ? '未通过退回 · ' + (editing.title ? editing.number + ' · ' + editing.title : editing.number) : '记录未通过的问题', regress: editing ? '重新打开 · ' + (editing.title ? editing.number + ' · ' + editing.title : editing.number) : '重新打开归档需求', deleteProject: '删除项目', deleteFolder: '删除文件夹', moveItem: '迁移需求', deleteItem: '删除需求' } as any)[modal]}</h3>
                <p>{modal === 'item' ? editing ? '标题与验收条件选填；已有需求编辑后自动保存。' : '关闭窗口会保留当前项目草稿；点击保存需求后加入需求池。'
                  : modal === 'verify' ? '未通过的内容会显示在需求卡片中，并带入下一轮 Prompt。'
                  : modal === 'deleteProject' ? '删除会一并移除该项目全部需求、批次与历史，且不可恢复。'
                  : modal === 'deleteFolder' ? '文件夹会被移除，其中的项目自动迁移到 default，需求不受影响。'
                  : modal === 'moveItem' ? '保留需求内容、设置与历史，在目标项目中分配新编号。'
                  : modal === 'deleteItem' ? '删除后无法恢复该需求；已有批次中的历史快照仍会保留。'
                  : '修改与操作记录会保留在工作区。'}</p>
              </div>
              <button className="icon-btn" disabled={busy} aria-label="关闭" onClick={() => void closeModal()}><X size={18} /></button>
            </div>

            {(modal === 'moveItem' || modal === 'deleteItem') && editing && (
              <form onSubmit={async (e) => {
                e.preventDefault();
                const moving = modal === 'moveItem';
                const r = await act({ op: moving ? 'moveItem' : 'deleteItem', id: editing.id, targetProject }, true);
                if (r) {
                  setSelected((ids) => ids.filter((id) => id !== editing.id));
                  setModal(''); setEditing(null);
                  notify(moving ? '需求已迁移到目标项目' : '需求已删除');
                }
              }}>
                <p>{editing.number}{editing.title ? ' · ' + editing.title : ''}</p>
                {modal === 'moveItem' && (
                  data.projects.length > 1 ? <label className="field">目标项目
                    <select required value={targetProject} onChange={(e) => setTargetProject(e.target.value)}>
                      {data.projects.filter((pr) => pr.id !== p?.id).map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
                    </select>
                  </label> : <p>还没有其他项目，请先在侧边栏新建项目。</p>
                )}
                <div className="card-actions">
                  <button type="button" className="btn" disabled={busy} onClick={() => setModal('')}>取消</button>
                  <button className={'btn ' + (modal === 'deleteItem' ? 'danger' : 'primary')} disabled={busy || (modal === 'moveItem' && !targetProject)}>
                    {modal === 'moveItem' ? '确认迁移' : '确认删除'}
                  </button>
                </div>
              </form>
            )}

            {modal === 'project' && (
              <ProjectCreate disabled={busy} folders={data.folders || [{ id: 'default', name: 'default' }]} submit={async (input) => {
                const r = await act({ op: 'project', ...input });
                if (!r) return false;
                setPid(r.createdProjectId || r.projects[r.projects.length - 1].id); setSelected([]); setBatchId(''); setModal('');
                return true;
              }} />
            )}

            {modal === 'item' && (
              <form onSubmit={async (e) => {
                e.preventDefault();
                clearTimeout(autoRef.current);
                const r = await act({ op: 'item', ...form, id: editing?.id, clearDraft: !editing });
                if (r) {
                  setModal(''); setTab('feature');
                  const pr = r.projects.find((x) => x.id === p?.id)!;
                  const item = editing ? pr.items.find((i) => i.id === editing.id) : pr.items[pr.items.length - 1];
                  if (item) setSelected((ids) => [...new Set([...ids, item.id])]);
                  notify('需求已待执行，可直接排期');
                }
              }}>
                <div className="choice-row">
                  <div className="field inline"><span>类型</span>
                    <div className="segmented" role="group" aria-label="需求类型">
                      {[['feature', '新需求'], ['improvement', '优化'], ['bug', '修复']].map(([v, l]) => (
                        <button type="button" key={v} aria-pressed={form.type === v} className={form.type === v ? 'on' : ''} onClick={() => change({ ...form, type: v })}>{l}</button>
                      ))}
                    </div>
                  </div>
                  <div className="field inline"><span>优先级</span>
                    <div className="segmented" role="group" aria-label="优先级">
                      {[['P0', 'P0 紧急'], ['P1', 'P1 重要'], ['P2', 'P2 常规']].map(([v, l]) => (
                        <button type="button" key={v} aria-pressed={form.priority === v} className={form.priority === v ? 'on' : ''} onClick={() => change({ ...form, priority: v })}>{l}</button>
                      ))}
                    </div>
                  </div>
                  <label className="field requirement-date"><span>日期</span><input type="date" aria-label="需求计划日期" value={form.scheduledDate || ''} onChange={e => change({ ...form, scheduledDate: e.target.value })} /></label>
                </div>
                <div className="field"><span>执行方式</span><div className="segmented" role="group" aria-label="需求执行方式">{[['ai', 'AI 执行'], ['human', '人工执行'], ['other', '其他执行器']].map(([id, label]) => <button type="button" key={id} aria-pressed={id === 'other' ? !['ai', 'human'].includes(form.executor || 'ai') : (form.executor || 'ai') === id} className={(id === 'other' ? !['ai', 'human'].includes(form.executor || 'ai') : (form.executor || 'ai') === id) ? 'on' : ''} onClick={() => change({ ...form, executor: id === 'other' ? 'agent:custom' : id })}>{label}</button>)}</div></div>
                {!['ai', 'human'].includes(form.executor || 'ai') && <label className="field">执行器标识<input value={form.executor} onChange={e => change({ ...form, executor: e.target.value })} placeholder="plugin:名称 或 agent:名称" /></label>}
                <label className="field">需求说明 · Ctrl+V 可粘贴截图
                  <FileMentionTextarea inputRef={bodyInput} root={p?.dir || ''} label="需求说明" rows={4} value={form.body} onChange={(body) => change({ ...form, body })}
                    onPaste={(e) => {
                      const images = Array.from(e.clipboardData.items).filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => !!file);
                      if (!images.length) return;
                      e.preventDefault(); setAdvanced(true); void uploadImages(images);
                    }}
                    placeholder={form.type === 'bug' ? '复现步骤、实际表现与预期行为' : '描述要实现的行为、约束或目标指标'} />
                </label>
                <div className="advanced-row">
                  <button type="button" className="btn secondary advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><ChevronDown size={16} />{advanced ? '收起更多设置' : '展开更多设置 · 图片、标题、验收与交付'}</button>
                  {bodyOverflows && <button type="button" className="btn secondary body-expand-toggle" aria-label="放大编辑需求说明" title="需求说明较长，打开更大的输入框编辑" onClick={() => setBodyExpanded(true)}><Maximize2 size={16} />放大编辑</button>}
                </div>
                {advanced && <div className="requirement-advanced">
                <div className="image-settings"><input className="visually-hidden" ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple disabled={uploading} onChange={(e) => { uploadImages(e.target.files); e.target.value = ''; }} /><button type="button" className="btn sm" disabled={uploading} onClick={() => imageInput.current?.click()}><ImageIcon />{uploading ? '读取中…' : '选择参考图片'}</button>
                <p>最多 12 张，每张 10MB；正文可引用“图片1”等标识。</p>
                <div className="attachment-grid">{(form.attachments || []).map((a: any) => <figure key={a.id}><img src={a.dataUrl} alt={a.label + ' ' + a.name} /><figcaption>{a.label} · {a.name}</figcaption><button type="button" className="btn sm" onClick={() => change({ ...form, attachments: form.attachments.filter((x: any) => x.id !== a.id) })}>移除 {a.label}</button></figure>)}</div>
                </div>
                <label className="field">标题（选填）<input value={form.title} onChange={(e) => change({ ...form, title: e.target.value })} /></label>
                <label className="field">验收条件（选填）· 每行一项
                  <textarea rows={3} value={form.criteria} onChange={(e) => change({ ...form, criteria: e.target.value })} />
                </label>
                <label className="field">交付引导
                  <textarea required rows={2} value={form.deliveryGuidance || ''} onChange={(e) => change({ ...form, deliveryGuidance: e.target.value })}
                    placeholder="填写这条需求完成后希望 AI 交付的内容" />
                </label>
                </div>}
                <div className="editor-footer">
                  <span>{editing ? saved : '关闭时保留草稿'}</span>
                  {!editing && <button type="button" className="btn" disabled={busy || uploading} onClick={() => void clearRequirement()}>清空需求</button>}
                  <button className="btn primary" disabled={busy || uploading}>保存需求</button>
                </div>
              </form>
            )}

            {modal === 'guide' && (
              <>
                {/* REQ-151：内容较多，按功能分 tab；保存按钮固定在底部，一次保存全部标签页的修改 */}
                <div className="settings-tabs" role="tablist" aria-label="项目设置分类">
                  {[['guide', '引导词'], ['template', '基线模板'], ['run', '验证与发布'], ['history', '版本历史']].map(([id, title]) => (
                    <button key={id} role="tab" aria-selected={guideTab === id} disabled={busy} className={guideTab === id ? 'on' : ''} onClick={() => setGuideTab(id)}>{title}</button>
                  ))}
                </div>
                <div className="settings-body">
                  {guideTab === 'guide' && <>
                    <GuidanceField label="项目引导词" value={guide} onChange={setGuide} root={p!.dir || ''} projectId={p!.id} kind="guidance" rows={6} disabled={busy} />
                    <GuidanceField label="默认交付引导" value={delivery} onChange={setDelivery} root={p!.dir || ''} projectId={p!.id} kind="delivery" rows={4} placeholder="填写希望 AI 交付时提供的内容" disabled={busy} />
                    <div className="settings-actions guide-rules-row">
                      <span className="guide-rules-title">项目守则{p!.contextRulesDisabled ? ' · 已删除' : ''}</span>
                      <label className="field inline guide-rules-limit" title="项目守则自动生成时的字数上限">字数上限
                        <input type="number" min={MIN_CONTEXT_RULES_LIMIT} max={MAX_CONTEXT_RULES_LIMIT} step={50} value={rulesLimit} disabled={busy}
                          onChange={e => setRulesLimit(Number(e.target.value))} />
                      </label>
                      {p!.contextRulesDisabled
                        ? <button className="btn" disabled={busy} onClick={() => void act({ op: 'guidance', text: p!.guidance, contextRulesDisabled: false }, true)}>重新生成</button>
                        : <button className="btn" disabled={busy || !p!.contextRules} onClick={() => setDeleteRulesConfirm(true)}><Trash />删除守则</button>}
                    </div>
                    <p className="settings-hint">关联上下文自动生成的项目守则最多保留 {Number.isFinite(rulesLimit) ? rulesLimit : DEFAULT_CONTEXT_RULES_LIMIT} 字，超出部分省略；默认 {DEFAULT_CONTEXT_RULES_LIMIT} 字。守则会加入后续排期 Prompt。</p>
                    <p className="settings-hint">{p!.dir ? '输入 @ 可补全项目内文件或目录（↑↓ 选择、回车确认、Esc 关闭）；「AI 优化」会结合最近提交与变更差异给出对比稿。' : '关联项目目录后，可在引导词中输入 @ 引用项目文件；「AI 优化」会结合最近提交与变更差异给出对比稿。'}</p>
                  </>}
                  {guideTab === 'template' && <>
                    <label className="field">基线需求模板（选填）<textarea rows={8} value={baselineTpl} onChange={(e) => setBaselineTpl(e.target.value)} placeholder={data?.baselineTemplate || DEFAULT_BASELINE_TEMPLATE} /></label>
                    <p className="settings-hint">「记录新需求 → 基线需求」以此模板预填一条需求；留空时优先使用设置里的全局模板，再回退到占位中的默认模板。</p>
                  </>}
                  {guideTab === 'run' && <>
                    <div className="field"><span>验证源</span>
                      <div className="segmented" role="group" aria-label="验证源类型">
                        {[['none', '不使用'], ['exe', '本地程序'], ['url', '网页地址']].map(([v, l]) => (
                          <button type="button" key={v} aria-pressed={verifyKind === v} className={verifyKind === v ? 'on' : ''}
                            onClick={() => { setVerifyKind(v as 'none' | 'exe' | 'url'); if (v === 'none') setVerifyValue(''); }}>{l}</button>
                        ))}
                      </div>
                    </div>
                    {verifyKind !== 'none' && (
                      <label className="field">{verifyKind === 'exe' ? '验证程序路径' : '验证网页地址'}
                        <div className="input-action">
                          <input value={verifyValue} onChange={(e) => setVerifyValue(e.target.value)}
                            placeholder={verifyKind === 'exe' ? '选择或填写可执行程序的绝对路径' : 'https://example.com/preview'} />
                          {verifyKind === 'exe' && (
                            <button type="button" className="icon-btn" aria-label="选择验证程序" title="浏览本地验证程序"
                              disabled={!bridge.pickVerifyProgram}
                              onClick={async () => { const r = await bridge.pickVerifyProgram?.(); if (r?.path) setVerifyValue(r.path); }}>
                              <FolderOpen />
                            </button>
                          )}
                        </div>
                      </label>
                    )}
                    <p className="settings-hint">配置验证源后，顶部「浏览项目」旁会出现绿色「运行」按钮，一键打开验证程序或网页。</p>
                    <div className="field"><span>发布脚本</span><div className="segmented" role="group" aria-label="发布设置">{[['auto', '自动检测'], ['script', '指定脚本'], ['none', '不使用']].map(([id, label]) => <button type="button" key={id} className={publishMode === id ? 'on' : ''} aria-pressed={publishMode === id} onClick={() => setPublishMode(id)}>{label}</button>)}</div></div>
                    {publishMode === 'script' && <label className="field">发布脚本路径<input value={publishPath} onChange={e => setPublishPath(e.target.value)} placeholder="项目内相对路径，如 scripts/deploy.mjs" /></label>}
                    <p className="settings-hint">支持 mjs、js、cjs、bat、cmd、ps1、sh、py。自动检测 publish 脚本；指定脚本后，顶部「发布」按钮执行该脚本。</p>
                  </>}
                  {guideTab === 'history' && <>
                    <p className="settings-hint">项目引导词每次保存都会记录版本；载入历史版本会替换「引导词」标签页中的两个输入框，确认后仍需保存设置。</p>
                    {p!.guideHistory.length === 0 && <p className="settings-hint">还没有历史版本。</p>}
                    {p!.guideHistory.map((g: any) => (
                      <details key={g.version} className="guide-version">
                        <summary>v{g.version} · {new Date(g.time).toLocaleString('zh-CN')}</summary>
                        <pre>{g.text + (g.deliveryGuidance ? '\n\n交付引导：\n' + g.deliveryGuidance : '')}</pre>
                        <button className="btn" onClick={() => {
                          setGuide(g.text);
                          if (g.deliveryGuidance !== undefined) setDelivery(g.deliveryGuidance);
                          setGuideTab('guide');
                        }}>载入此版本</button>
                      </details>
                    ))}
                  </>}
                </div>
                <div className="settings-footer">
                  <span className="guide-footer-note">保存会应用全部标签页的修改</span>
                  <button className="btn primary" disabled={busy || !guide.trim() || !delivery.trim() || !Number.isInteger(rulesLimit) || rulesLimit < MIN_CONTEXT_RULES_LIMIT || rulesLimit > MAX_CONTEXT_RULES_LIMIT || (verifyKind !== 'none' && !verifyValue.trim()) || (publishMode === 'script' && !publishPath.trim())}
                    onClick={async () => {
                      if (!await act({ op: 'publishScript', script: publishMode === 'auto' ? null : publishMode === 'none' ? '' : publishPath }, true)) return;
                      if (!await act({ op: 'verifySource', source: verifyKind === 'none' ? null : { kind: verifyKind, value: verifyValue.trim() } }, true)) return;
                      if (!await act({ op: 'baselineTemplate', text: baselineTpl }, true)) return;
                      const changed = guide.trim() !== p!.guidance || delivery.trim() !== p!.deliveryGuidance;
                      if (!await act({ op: 'guidance', text: guide, deliveryGuidance: delivery, contextRulesLimit: rulesLimit }, true)) return;
                      setModal('');
                      if (changed) { setTab('feature'); setSelected([]); setBatchId(''); setQuery(''); setTypeFilter('all'); notify('引导词已更新，所有排期需求已退回需求池，请重新排期'); }
                      else notify('设置已保存');
                    }}>
                    保存设置
                  </button>
                </div>
              </>
            )}

            {modal === 'detail' && editing && (
              <>
                <p className="detail-body">{editing.body}</p><div className="attachment-grid">{editing.attachments?.map((a) => <figure key={a.id}><img src={a.dataUrl} alt={a.label} /><figcaption>{a.label} · {a.name}</figcaption></figure>)}</div>
                <p className="detail-meta">{labels[editing.type]} · {editing.priority} · 状态：{labels[editing.status]} · 版本 v{editing.version}</p>
                {editing.archived && <p className="detail-meta">归档时间：{archivedDate(editing)}</p>}
                {editing.link && <p className="detail-meta">实现关联：<a href={editing.link} target="_blank" rel="noreferrer">{editing.link}</a></p>}
                <h4 className="modal-section">操作与验证历史</h4>
                <div className="history-list">
                  {editing.history.map((h: any, n: number) => (
                    <div className="history-entry" key={n}>
                      <strong>{h.event}</strong>
                      <small>{new Date(h.time).toLocaleString('zh-CN')}</small>
                      <p>{[h.note, h.link, h.reason].filter(Boolean).join(' · ')}</p>
                      {h.snapshot && (
                        <details><summary>历史内容</summary>
                          <pre>{h.snapshot.title + '\n' + h.snapshot.body + '\n' + (h.snapshot.criteria || []).join('\n')}</pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
                {!editing.archived && editing.status !== 'in_progress' && (
                  <button className="btn secondary" disabled={busy}
                    onClick={async () => { if (await act({ op: 'archive', id: editing.id })) setModal(''); }}>
                    归档需求（保留历史快照）
                  </button>
                )}
              </>
            )}

            {modal === 'verify' && editing && (
              <>
                {unresolvedFailures(editing).length > 0 && (
                  <div className="prior-failures">
                    <div className="prior-failures-head">
                      <strong>之前的未解决问题</strong>
                      <span>请确认修复状态：确认已修复的问题不再带入下一轮 Prompt，仍未修复的会标注「此前问题未修复」</span>
                    </div>
                    {unresolvedFailures(editing).map((f, n) => (
                      <div className="prior-failure" key={n}>
                        <p>{f.note}<small>{new Date(f.time).toLocaleString('zh-CN')}</small></p>
                        <div className="prior-failure-choice">
                          <label><input type="radio" name={'fixed-' + n} checked={!fixedIdx.includes(n)}
                            onChange={() => setFixedIdx(fixedIdx.filter((x) => x !== n))} />仍未修复</label>
                          <label><input type="radio" name={'fixed-' + n} checked={fixedIdx.includes(n)}
                            onChange={() => setFixedIdx([...fixedIdx, n])} />已修复</label>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <label className="field">{unresolvedFailures(editing).length ? '新增问题（选填）' : '未通过的内容（选填）'}
                  <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder={unresolvedFailures(editing).length
                      ? '描述本次新出现的问题；之前的问题用上方选项确认状态'
                      : '描述哪里未通过，会自动带入下一轮 Prompt；也可以留空'} />
                </label>
                <button className="btn primary" disabled={busy}
                  onClick={async () => {
                    // 退回后停留在待验证列表继续处理其余需求；去向用 toast 说明
                    if (await act({ op: 'verify', id: editing.id, pass: false, note, fixed: fixedIdx })) {
                      setModal('');
                      notify('已退回待执行，可稍后编辑重新生成 Prompt');
                    }
                  }}>记录未通过，退回待执行</button>
              </>
            )}

            {modal === 'regress' && (
              <>
                <label className="field">回归问题（选填）<textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></label>
                <button className="btn primary" disabled={busy}
                  onClick={async () => {
                    if (await act({ op: 'regress', id: editing!.id, note })) {
                      setModal(''); setSelected([]);
                      notify('已重新打开，需求回到待执行');
                    }
                  }}>退回待执行</button>
              </>
            )}

            {modal === 'deleteFolder' && deletingFolder && (
              <>
                <p className="detail-body">
                  即将删除文件夹「<strong>{deletingFolder.name}</strong>」，其中 {data.projects.filter((pr) => (pr.folderId || 'default') === deletingFolder.id).length} 个项目将迁移到 default 文件夹。
                </p>
                <p className="detail-body">项目与需求不受影响，可随时拖拽回其他文件夹。</p>
                <div className="editor-footer">
                  <button className="btn" disabled={busy} onClick={() => { setDeletingFolder(null); setModal(''); }}>取消</button>
                  <button className="btn danger" disabled={busy}
                    onClick={async () => {
                      if (await act({ op: 'deleteFolder', folderId: deletingFolder.id })) {
                        setDeletingFolder(null); setModal('');
                        notify('文件夹已删除，项目已迁移到 default');
                      }
                    }}>
                    <Trash size={14} />确认删除
                  </button>
                </div>
              </>
            )}

            {modal === 'deleteProject' && deleting && (
              <>
                <p className="detail-body">
                  即将删除项目「<strong>{deleting.name}</strong>」，包含 {deleting.items.length} 条需求（含已归档与验证历史）
                  和 {deleting.batches.length} 个 Prompt 批次。
                </p>
                <p className="delete-warning">删除后无法恢复。如需保留备份，请先在「设置 → 数据」导出全部数据。</p>
                <p className="muted">这里只删除 ReqFlow 中的项目记录，不会删除项目的源文件或目录。</p>
                <div className="editor-footer">
                  <button className="btn" disabled={busy} onClick={() => { setDeleting(null); setModal(''); }}>取消</button>
                  <button className="btn danger" disabled={busy}
                    onClick={async () => {
                      const r = await act({ op: 'deleteProject', project: deleting.id });
                      if (r) {
                        setDeleting(null); setModal('');
                        // 删除的是当前项目时，切换到剩余的第一个项目
                        if (!r.projects.some((x) => x.id === pid)) switchProject(r.projects[0]?.id || '');
                        notify('项目已删除');
                      }
                    }}>
                    <Trash size={14} />确认删除
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      {browserOpen && p && (
        <ProjectBrowser
          project={p}
          onClose={() => setBrowserOpen(false)}
          onDirChange={async (dir) => { if (!await act({ op: 'projectDir', dir }, true)) throw Error('目录未保存，请检查提示后重试'); }}
          notify={notify}
          onCommitted={load}
          saveRemote={async (remote) => !!await act({ op: 'projectRemote', remote }, true)}
        />
      )}
    </div>
  );
}
