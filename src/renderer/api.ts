// 渲染端桥接层。
// - Electron 运行时：window.reqflow（preload 注入，走 IPC）
// - 浏览器开发预览（npm run dev:renderer）：内置 mock，localStorage 持久化，
//   领域规则直接复用 src/core/domain.ts，与主进程行为一致。

import { apply, makeProject, normalizeWorkspace, mutationProjectIds, projectConcurrencyToken, type Workspace } from '../core/domain';
import { validateAISettings, type AISettings, type AIRequestLog } from '../core/ai';
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

export type LocalAgent = { id: string; name: string; command: string; package: string; installed: boolean; version?: string; latest?: string; update?: boolean; error?: string; registryError?: string };
export interface ReqFlowBridge {
  getStorageStatus?(): Promise<{ ok: boolean; backend?: string; error?: string }>;
  migrateStorage?(): Promise<{ ok: boolean; backend?: string; error?: string }>;
  getLocalAgents?(): Promise<{ ok: boolean; enabled?: string[]; error?: string }>;
  saveLocalAgents?(enabled: string[]): Promise<{ ok: boolean; error?: string }>;
  detectLocalAgents?(): Promise<{ ok: boolean; agents?: LocalAgent[]; error?: string }>;
  updateState?(): Promise<UpdateState>;
  checkUpdate?(): Promise<UpdateState>;
  downloadUpdate?(): Promise<UpdateState>;
  installUpdate?(): Promise<UpdateState>;
  windowControl?(action: 'minimize' | 'close'): Promise<void>;
  aiRequirements?(project: string, mode: string, instruction: string, discussion: { role: string; content: string }[]): Promise<{ ok: boolean; reply?: string; items?: AIDraft[]; error?: string; contextNote?: string; contextFiles?: string[]; requirementCount?: number }>;
  gitPush?(root: string): Promise<GitOpResult>;
  gitPull?(root: string): Promise<GitOpResult>;
  getBackupSettings?(): Promise<{ ok: boolean; settings: BackupSettings; status: BackupStatus }>;
  saveBackupSettings?(settings: BackupSettings): Promise<{ ok: boolean; error?: string }>;
  syncBackup?(): Promise<{ ok: boolean; error?: string; status: BackupStatus }>;
  testRemote?(settings: RemoteSettings): Promise<{ ok: boolean; error?: string }>;
  applyRemote?(project: string): Promise<{ ok: boolean; error?: string }>;
  pickSSHKey?(): Promise<{ ok: boolean; path?: string }>;
  /** 验证源（REQ-060）：选择本地验证程序；打开配置的 exe / url。仅桌面版提供。 */
  pickVerifyProgram?(): Promise<{ ok: boolean; path?: string; error?: string }>;
  openVerifySource?(source: { kind: 'exe' | 'url'; value: string }): Promise<{ ok: boolean; error?: string }>;
  /** 发布脚本（REQ-070）：检测项目目录内的 publish 脚本（返回相对路径，空串表示没有）；执行发布并返回输出。仅桌面版提供。 */
  detectPublish?(root: string): Promise<{ ok: boolean; script?: string; error?: string }>;
  runPublish?(root: string, rel: string): Promise<{ ok: boolean; output?: string; error?: string }>;
  /** 发布完成系统通知（REQ-110）：整个发布流程结束时上报结果，窗口不在最前端时由主进程弹系统通知。 */
  publishNotice?(notice: { ok: boolean; project: string; detail?: string }): Promise<{ ok: boolean }>;
  /** 数据用量与归档（REQ-112）：目录/数据库大小统计，按日期导出并清理。仅桌面版提供。 */
  getDataUsage?(): Promise<{ ok: boolean; dataDir?: string; backend?: string; dirSize?: number; databasePath?: string; databaseSize?: number; error?: string }>;
  previewDataArchive?(date: string): Promise<{ ok: boolean; items?: number; batches?: number; error?: string }>;
  archiveData?(date: string): Promise<{ ok: boolean; canceled?: boolean; items?: number; batches?: number; file?: string; dataDir?: string; backend?: string; dirSize?: number; databasePath?: string; databaseSize?: number; error?: string }>;
  exportArchivedData?(date: string): Promise<{ ok: boolean; canceled?: boolean; items?: number; batches?: number; file?: string; error?: string }>;
  clearArchivedData?(date: string): Promise<{ ok: boolean; items?: number; batches?: number; error?: string }>;
  getAISettings(): Promise<{ ok: true; settings: AISettings } | { ok: false; error: string }>;
  getAIRequestLogs?(): Promise<{ ok: boolean; entries?: AIRequestLog[]; error?: string }>;
  getPublishRequestLogs?(): Promise<{ ok: boolean; entries?: PublishRequestLog[]; error?: string }>;
  getPublishLogSettings?(): Promise<{ ok: boolean; settings?: PublishLogSettings; error?: string }>;
  savePublishLogSettings?(settings: PublishLogSettings): Promise<{ ok: boolean; error?: string }>;
  saveAISettings(settings: AISettings): Promise<{ ok: boolean; error?: string }>;
  optimizeCommitMessage?(project: string, message: string): Promise<{ ok: boolean; message?: string; error?: string }>;
  getWorkspace(): Promise<WorkspaceResult>;
  apply(action: any): Promise<WorkspaceResult>;
  appInfo(): Promise<{ version: string; dataFile: string; platform: string }>;
  showDataFile?(): Promise<unknown>;
  openConfigDir?(): Promise<{ ok: boolean; error?: string }>;
  // 项目目录（REQ-146）：从资源管理器打开关联的项目目录。仅桌面版提供。
  openProjectDir?(dir: string): Promise<{ ok: boolean; error?: string }>;
  // 文件浏览仅桌面版提供；浏览器 mock 预览下为 undefined，界面做降级提示
  pickDir?(): Promise<{ ok: boolean; dir?: string; error?: string }>;
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
  gitStatus?(root: string): Promise<({ ok: true } & GitStatusInfo) | { ok: false; error: string }>;
  gitInit?(root: string): Promise<GitOpResult>;
  gitStage?(root: string, mode: 'stage' | 'unstage', paths: string[]): Promise<GitOpResult>;
  gitCommit?(root: string, message: string, project?: string, items?: { id: string; version: number }[]): Promise<GitOpResult>;
  gitBranchCreate?(root: string, name: string): Promise<GitOpResult>;
  gitBranchSwitch?(root: string, name: string): Promise<GitOpResult>;
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
