// 渲染端桥接层。
// - Electron 运行时：window.reqflow（preload 注入，走 IPC）
// - 浏览器开发预览（npm run dev:renderer）：内置 mock，localStorage 持久化，
//   领域规则直接复用 src/core/domain.ts，与主进程行为一致。

import { apply, makeProject, normalizeWorkspace, mutationProjectIds, projectConcurrencyToken, type Workspace } from '../core/domain';
import { validateAISettings, type AISettings, type AIRequestLog, type AICLIStatus } from '../core/ai';
import pkg from '../../package.json';
import type { AIDraft } from '../core/ai';
import type { BackupSettings, BackupStatus, RemoteSettings } from '../core/remote';
import type { UpdateState } from '../core/update';
import type { PublishLogSettings, PublishRequestLog } from '../core/publish-log';

export type WorkspaceResult =
  | { ok: true; state: Workspace; version: number; warning?: string; summary?: string; createdProjectId?: string }
  | { ok: false; error: string; code?: string };

/** 「浏览项目」的目录条目（rel 为相对关联目录、以 / 分隔的路径）。 */
export type FileEntry = { name: string; rel: string; dir: boolean; size: number };

/** Git 变动条目（porcelain XY：index=暂存区状态，worktree=工作区状态）。 */
export type GitChange = { path: string; index: string; worktree: string };
export type GitStatusInfo = {
  repo: boolean;
  hasRemote?: boolean;
  branch: string;
  ahead: number;
  behind: number;
  /** 当前分支是否已关联上游（origin）；未关联时首次 Push 会用 -u 建立。 */
  upstream: boolean;
  changes: GitChange[];
  branches: string[];
  log?: { hash: string; author: string; date: string; message: string }[];
};
export type GitOpResult = { ok: true; summary?: string; warning?: string } | { ok: false; error: string };

/** Git 提交（里程碑视图）：按提交时间倒序，refs 为 HEAD/标签/远端等装饰。 */
export type GitCommit = { hash: string; short: string; author: string; date: string; refs: string[]; subject: string; body: string };
export type GitMilestoneInfo = { repo: boolean; branch: string; total: number; commits: GitCommit[] };

/** Server Agent 状态：已连接 / 断开 / 证书异常 / 待确认信任（REQ-239）。 */
export type ServerAgentStatus = {
  state?: 'connected' | 'disconnected' | 'need_trust' | 'cert_error';
  error?: string;
  kind?: string;
  code?: string;
  lastConnectedAt?: string;
  lastSyncError?: string;
  fingerprint?: string;
  lastSync?: Record<string, string>;
  version?: string;
  lastUpdatedAt?: string;
};
export type ServerAgentEntry = {
  id: string; name: string; host: string; port: number;
  tlsMode: 'pin' | 'ca'; autoConnect: boolean;
  hasToken: boolean; trusted: boolean; fingerprint?: string;
  status?: ServerAgentStatus;
  ssh?: string;
};
export type ServerAgentDraft = Partial<ServerAgentEntry> & { token?: string };

export type LocalAgent = { id: string; name: string; command: string; package: string; installed: boolean; version?: string; latest?: string; update?: boolean; error?: string; registryError?: string };
export type PublishSession = { running: boolean; step: string; startedAt: number; endedAt?: number; revision: number; result: { ok: boolean; output: string; error?: string } | null };
export type TerminalSession = Omit<PublishSession, 'result'> & { project: string; projectId?: string; idle?: boolean; result: { ok: boolean; error?: string } | null };
export type TerminalPeer = { runId: string; agent?: string };
export interface ReqFlowBridge {
  startShell?(project: string): Promise<{ ok: boolean; runId?: string; error?: string }>;
  startAgent?(project: string, agent: string, ids: string[]): Promise<{ ok: boolean; runId?: string; agent?: string; items?: string[]; error?: string }>;
  readAgent?(runId: string, offset: number): Promise<{ ok: boolean; data?: string; offset?: number; done?: boolean; idleMs?: number; error?: string }>;
  /** 终端收起后轮询会话状态（是否仍在运行、距上次输出的毫秒数），不需要传输终端内容。 */
  agentStatus?(runId: string): Promise<{ ok: boolean; done?: boolean; idleMs?: number; error?: string }>;
  writeAgent?(runId: string, input: string): Promise<{ ok: boolean; error?: string }>;
  resizeAgent?(runId: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }>;
  stopAgent?(runId: string): Promise<{ ok: boolean; error?: string }>;
  /** 指派终端最大化：在独立窗口打开同一个交互会话，与发布终端一致。 */
  openAgentTerminal?(runId: string): Promise<{ ok: boolean; error?: string }>;
  closeAgentTerminal?(runId: string): Promise<{ ok: boolean; error?: string }>;
  agentTerminalStatus?(runId: string): Promise<{ ok: boolean; detached?: boolean; peers?: TerminalPeer[]; error?: string }>;
  getTerminalSetting?(): Promise<{ ok: boolean; settings: { enabled: boolean } | null }>;
  saveTerminalSetting?(enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  /** 实验室「指派」开关（REQ-207）：开启后「提交验证」弹窗才会显示指派浮层。 */
  getAssignSetting?(): Promise<{ ok: boolean; settings: { enabled: boolean } | null }>;
  saveAssignSetting?(enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  getContextSettings?(): Promise<{ ok: boolean; dir?: string; git?: boolean; error?: string }>;
  saveContextSettings?(dir: string): Promise<{ ok: boolean; dir?: string; error?: string }>;
  listSSH?(root: string): Promise<{ ok: boolean; error?: string; dir?: string; path?: string; entries?: { name: string; path: string }[] }>;
  sshStatus?(root: string): Promise<{ ok: boolean; error?: string }>;
  getStorageStatus?(): Promise<{ ok: boolean; backend?: string; error?: string }>;
  migrateStorage?(): Promise<{ ok: boolean; backend?: string; error?: string }>;
  getLocalAgents?(): Promise<{ ok: boolean; enabled?: string[]; error?: string }>;
  saveLocalAgents?(enabled: string[]): Promise<{ ok: boolean; error?: string }>;
  installLocalAgent?(id: string): Promise<{ ok: boolean; error?: string }>;
  detectLocalAgents?(): Promise<{ ok: boolean; agents?: LocalAgent[]; error?: string }>;
  updateState?(): Promise<UpdateState>;
  checkUpdate?(): Promise<UpdateState>;
  /** 安装界面强制重新检测最新版本（REQ-257）：已下载的安装包不短路，可直接发现更新的版本。 */
  recheckUpdate?(): Promise<UpdateState>;
  downloadUpdate?(): Promise<UpdateState>;
  installUpdate?(): Promise<UpdateState>;
  openProjectBrowser?(id: string): Promise<{ ok: boolean; error?: string }>;
  closeProjectBrowser?(id: string): Promise<{ ok: boolean; error?: string }>;
  maximizeProjectBrowser?(id: string): Promise<{ ok: boolean; error?: string }>;
  windowControl?(action: 'minimize' | 'close'): Promise<void>;
  aiRequirements?(project: string, mode: string, instruction: string, discussion: { role: string; content: string }[]): Promise<{ ok: boolean; reply?: string; items?: AIDraft[]; error?: string; contextNote?: string; contextFiles?: string[]; requirementCount?: number }>;
  gitPush?(root: string): Promise<GitOpResult>;
  gitPull?(root: string): Promise<GitOpResult>;
  getBackupSettings?(): Promise<{ ok: boolean; settings: BackupSettings; status: BackupStatus }>;
  saveBackupSettings?(settings: BackupSettings): Promise<{ ok: boolean; error?: string }>;
  syncBackup?(): Promise<{ ok: boolean; error?: string; status: BackupStatus }>;
  importBackup?(settings: BackupSettings): Promise<{ ok: boolean; error?: string; settings?: BackupSettings; status?: BackupStatus; projects?: number; items?: number }>;
  testRemote?(settings: RemoteSettings): Promise<{ ok: boolean; error?: string }>;
  applyRemote?(project: string): Promise<{ ok: boolean; error?: string }>;
  pickSSHKey?(): Promise<{ ok: boolean; path?: string }>;
  /** 验证源（REQ-060）：选择本地验证程序；打开配置的 exe / url。仅桌面版提供。 */
  pickVerifyProgram?(): Promise<{ ok: boolean; path?: string; error?: string }>;
  openVerifySource?(source: { kind: 'exe' | 'url'; value: string }): Promise<{ ok: boolean; error?: string }>;
  /** 发布脚本（REQ-070）：检测项目目录内的 publish 脚本（返回相对路径，空串表示没有）；执行发布并返回输出。仅桌面版提供。 */
  detectPublish?(root: string): Promise<{ ok: boolean; script?: string; error?: string }>;
  runPublish?(root: string, rel: string, terminalRunId?: string): Promise<{ ok: boolean; output?: string; error?: string }>;
  getPublishOutput?(runId: string, offset: number): Promise<{ ok: boolean; data: string; offset: number; done: boolean; started: boolean; truncated?: boolean; error?: string }>;
  syncPublishTerminal?(runId: string, session: TerminalSession): Promise<{ ok: boolean; error?: string }>;
  getPublishTerminal?(runId: string): Promise<{ ok: boolean; session: TerminalSession | null; detached: boolean; peers?: TerminalPeer[]; error?: string }>;
  openPublishTerminal?(runId: string): Promise<{ ok: boolean; error?: string }>;
  closePublishTerminal?(runId: string): Promise<{ ok: boolean; error?: string }>;
  /** 发布完成系统通知（REQ-110）：整个发布流程结束时上报结果，窗口不在最前端时由主进程弹系统通知。 */
  publishNotice?(notice: { ok: boolean; project: string; detail?: string }): Promise<{ ok: boolean }>;
  /** 数据用量与归档（REQ-112）：目录/数据库大小统计，按日期导出并清理。仅桌面版提供。 */
  getDataUsage?(): Promise<{ ok: boolean; dataDir?: string; backend?: string; dirSize?: number; databasePath?: string; databaseSize?: number; error?: string }>;
  previewDataArchive?(date: string): Promise<{ ok: boolean; items?: number; batches?: number; error?: string }>;
  archiveData?(date: string): Promise<{ ok: boolean; canceled?: boolean; items?: number; batches?: number; file?: string; dataDir?: string; backend?: string; dirSize?: number; databasePath?: string; databaseSize?: number; error?: string }>;
  exportArchivedData?(date: string): Promise<{ ok: boolean; canceled?: boolean; items?: number; batches?: number; file?: string; error?: string }>;
  clearArchivedData?(date: string): Promise<{ ok: boolean; items?: number; batches?: number; error?: string }>;
  getAISettings(): Promise<{ ok: true; settings: AISettings } | { ok: false; error: string }>;
  detectAIProviderCLIs?(): Promise<{ ok: boolean; agents?: AICLIStatus[]; error?: string }>;
  getAIRequestLogs?(): Promise<{ ok: boolean; entries?: AIRequestLog[]; error?: string }>;
  getPublishRequestLogs?(): Promise<{ ok: boolean; entries?: PublishRequestLog[]; error?: string }>;
  getPublishLogSettings?(): Promise<{ ok: boolean; settings?: PublishLogSettings; error?: string }>;
  savePublishLogSettings?(settings: PublishLogSettings): Promise<{ ok: boolean; error?: string }>;
  saveAISettings(settings: AISettings): Promise<{ ok: boolean; error?: string }>;
  testAISettings?(settings: AISettings): Promise<{ ok: boolean; error?: string }>;
  optimizeCommitMessage?(project: string, message: string): Promise<{ ok: boolean; message?: string; error?: string }>;
  // REQ-151：AI 优化项目引导词 / 交付引导词，携带最近提交与差异统计上下文；返回优化后文本供对比编辑
  optimizeGuidance?(project: string, kind: 'guidance' | 'delivery', text: string): Promise<{ ok: boolean; text?: string; contextNote?: string; error?: string }>;
  getWorkspace(): Promise<WorkspaceResult>;
  /** 只读本地备份，不触发远程刷新；用于独立窗口快速首屏。 */
  getLocalWorkspace?(): Promise<WorkspaceResult>;
  apply(action: any): Promise<WorkspaceResult>;
  appInfo(): Promise<{ version: string; dataFile: string; platform: string }>;
  showDataFile?(): Promise<unknown>;
  openConfigDir?(): Promise<{ ok: boolean; error?: string }>;
  // 项目目录（REQ-146）：从资源管理器打开关联的项目目录。仅桌面版提供。
  openProjectDir?(dir: string): Promise<{ ok: boolean; error?: string }>;
  // 文件浏览仅桌面版提供；浏览器 mock 预览下为 undefined，界面做降级提示
  pickDir?(): Promise<{ ok: boolean; dir?: string; error?: string }>;
  importProject?(dir: string, remote?: RemoteSettings, overwrite?: boolean): Promise<{ ok: boolean; needsConfirmation?: boolean; dir?: string; name?: string; remote?: RemoteSettings; error?: string }>;
  prepareDir?(dir: string, remote?: RemoteSettings): Promise<{ ok: boolean; dir?: string; error?: string; warning?: string; summary?: string }>;
  listDir?(root: string, rel: string): Promise<{ ok: true; entries: FileEntry[] } | { ok: false; error: string }>;
  readFile?(root: string, rel: string): Promise<{ ok: true; content: string; size: number } | { ok: false; error: string }>;
  readImage?(root: string, rel: string): Promise<{ ok: true; mime: string; dataUrl: string; size: number } | { ok: false; error: string }>;
  writeFile?(root: string, rel: string, content: string): Promise<{ ok: true } | { ok: false; error: string }>;
  revealFile?(root: string, rel: string): Promise<{ ok: boolean; error?: string }>;
  openExternal?(url: string): Promise<{ ok: boolean; error?: string }>;
  // 实验室：仅放行 codex://threads 深链，用于调起 Codex 桌面窗口
  openCodexDeepLink?(url: string): Promise<{ ok: boolean; error?: string }>;
  // Git 支持：仅当主进程检测到本机 git 时可用（gitAvailable 返回 available=false 时界面不显示 Git 入口）
  gitAvailable?(): Promise<{ ok: boolean; available: boolean }>;
  gitDiff?(root: string): Promise<{ ok: boolean; error?: string; files?: { path: string; before: string; after: string }[] }>;
  gitStatus?(root: string): Promise<({ ok: true } & GitStatusInfo) | { ok: false; error: string }>;
  /** 里程碑视图：读取项目目录最近的 Git 提交历史（只读）。仅桌面版提供。 */
  gitMilestones?(root: string, limit?: number): Promise<({ ok: true } & GitMilestoneInfo) | { ok: false; error: string }>;
  gitInit?(root: string): Promise<GitOpResult>;
  gitStage?(root: string, mode: 'stage' | 'unstage', paths: string[]): Promise<GitOpResult>;
  gitCommit?(root: string, message: string, project?: string, items?: { id: string; version: number }[]): Promise<GitOpResult>;
  gitBranchCreate?(root: string, name: string): Promise<GitOpResult>;
  gitBranchSwitch?(root: string, name: string): Promise<GitOpResult>;
  // Server Agent（REQ-237/238/239/240）：远程同步服务端的配置、信任与项目同步
  getServerAgents?(): Promise<{ ok: boolean; servers?: ServerAgentEntry[]; error?: string }>;
  saveServerAgent?(config: ServerAgentDraft): Promise<{ ok: boolean; id?: string; trusted?: boolean; hasToken?: boolean; error?: string }>;
  deleteServerAgent?(id: string): Promise<{ ok: boolean; error?: string }>;
  testServerAgent?(config: ServerAgentDraft): Promise<{ ok: boolean; kind?: 'network' | 'cert' | 'auth'; code?: string; error?: string; fingerprint?: string }>;
  trustServerAgent?(id: string, fingerprint?: string): Promise<{ ok: boolean; fingerprint?: string; error?: string }>;
  resetServerAgentTrust?(id: string): Promise<{ ok: boolean; error?: string }>;
  connectServerAgent?(id: string): Promise<{ ok: boolean; kind?: string; code?: string; error?: string; fingerprint?: string }>;
  disconnectServerAgent?(id: string): Promise<{ ok: boolean; error?: string }>;
  requestServerToken?(ssh: string): Promise<{ ok: boolean; token?: string; error?: string }>;
  installServerAgent?(info: { ssh: string; port: number; name?: string; dataDir?: string }): Promise<{ ok: boolean; name?: string; host?: string; port?: number; token?: string; dataDir?: string; ssh?: string; summary?: string; error?: string }>;
  updateServerAgent?(info: { id: string; ssh?: string }): Promise<{ ok: boolean; version?: string; dataDir?: string; warning?: string; error?: string }>;
  uninstallServerAgent?(info: { ssh: string; serverId?: string; cleanData: boolean; preview?: boolean; confirmedDataDir?: string }): Promise<{ ok: boolean; dataDir?: string; dataRemoved?: boolean; error?: string }>;
}

declare global {
  interface Window {
    reqflow?: ReqFlowBridge;
  }
}

export const bridge: ReqFlowBridge = window.reqflow ?? createMockBridge();

const MOCK_KEY = 'reqflow-mock-workspace';

function createMockBridge(): ReqFlowBridge {
  let version = 1;
  const load = (): { state: Workspace; version: number } => {
    try {
      const raw = localStorage.getItem(MOCK_KEY);
      if (raw) return { state: normalizeWorkspace(JSON.parse(raw).state), version: JSON.parse(raw).version };
    } catch { /* 重置 */ }
    const fresh = { state: { projects: [makeProject('我的第一个项目')] }, version: 1 };
    persist(fresh.state, fresh.version);
    return fresh;
  };
  const persist = (state: Workspace, v: number) => {
    version = v;
    localStorage.setItem(MOCK_KEY, JSON.stringify({ state, version: v }));
  };
  return {
    async getAISettings() {
      try { return { ok: true, settings: validateAISettings(JSON.parse(localStorage.getItem('reqflow-ai-settings') || '{"provider":"","url":"","apiKey":""}')) }; }
      catch { return { ok: false, error: '读取 AI 设置失败' }; }
    },
    async saveAISettings(settings) {
      try { localStorage.setItem('reqflow-ai-settings', JSON.stringify(validateAISettings(settings))); return { ok: true }; }
      catch (e: any) { return { ok: false, error: e.message }; }
    },
    async getWorkspace() {
      const r = load();
      return { ok: true, state: r.state, version: r.version };
    },
    async apply(action: any) {
      const r = load();
      const scopes = mutationProjectIds(action);
      const projectVersions = action.expectedProjectVersions;
      const conflict = projectVersions !== undefined ? (!scopes || scopes.some(id => r.state.projects.find(p => p.id === id)?.revision !== projectVersions[id])) : action.expectedVersion !== undefined && action.expectedVersion !== r.version;
      const contentConflict = scopes && action.expectedProjectSignatures !== undefined && (await Promise.all(scopes.map(async id => {
        const project = r.state.projects.find(p => p.id === id);
        return !project || action.expectedProjectSignatures[id] !== await projectConcurrencyToken(project);
      }))).some(Boolean);
      if (conflict || contentConflict) return { ok: false, error: '数据已被其他方式修改，请刷新后重试。', code: 'VERSION_CONFLICT' };
      try {
        await apply(r.state, action);
        persist(r.state, r.version + 1);
        return { ok: true, state: normalizeWorkspace(r.state), version: version };
      } catch (e: any) {
        return { ok: false, error: e?.message || '保存失败' };
      }
    },
    async appInfo() {
      // 与 Electron 端 app.getVersion() 同源，浏览器预览也能看到真实版本号
      return { version: pkg.version, dataFile: '(浏览器预览 · localStorage)', platform: 'browser' };
    }
  };
}
