// ReqFlow 领域核心 —— 移植自线上源码 lib/domain.ts（提交 3892f74）。
// 纯 TypeScript、无平台依赖，GUI(IPC) 与 CLI 共用同一套规则。

import { validateRemote, type RemoteSettings } from './remote';
import { validateDate } from './dates';
export type Attachment = { id: string; label: string; name: string; dataUrl: string; path?: string };
export type AIExecution = { runId: string; client: 'codex' | 'zcode' | 'pi' | 'claude-code' | 'dsh' | 'opencode'; startedAt: string; version: number; batchId: string; endedAt?: string; outcome?: 'completed' | 'released'; durationMs?: number };
export const activeAIExecution = (i: Item) => i.aiExecution?.runId && !i.aiExecution.endedAt ? i.aiExecution : undefined;
function finishAIExecution(i: Item, now: string, outcome: 'completed' | 'released') {
  const execution = activeAIExecution(i);
  if (!execution) return;
  execution.endedAt = now;
  execution.outcome = outcome;
  execution.durationMs = Math.max(0, Date.parse(now) - Date.parse(execution.startedAt));
}

function completionSummary(a: any): string {
  if (a.summary !== undefined) {
    if (typeof a.summary !== 'string' || !a.summary.trim()) throw Error('完成说明不能为空');
    const text = a.summary.trim();
    if (Array.from(text).length > 50) throw Error('完成说明不能超过50字');
    return text;
  }
  // Existing agents send a full report in --note; keep that in history and show a short excerpt.
  const note = String(a.note || '').replace(/^\[ReqFlow[^\n]*\]\s*\n/, '').trim();
  return Array.from(note).slice(0, 50).join('');
}

export function versionComponents(value: unknown): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const valid = (text: unknown): text is string => typeof text === 'string' && !!text.trim() && [...text.trim()].length <= 100 && !/[\r\n]/.test(text.trim());
  for (const [name, raw] of Object.entries(value)) {
    const version = raw && typeof raw === 'object' ? (raw as { version?: unknown }).version : raw;
    if (valid(name) && valid(version)) result[name] = version.trim();
  }
  return result;
}

export type Item = {
  id: string;
  number: string;
  title: string;
  body: string;
  type: string; // feature | improvement | bug
  priority: string; // P0 | P1 | P2
  status: string; // ready | in_progress | pending_verification | archived
  criteria: string[];
  version: number;
  history: any[];
  // UTC ISO 时间；重复开发、退回、归档均保留独立步骤，供后续统计。
  flowEvents?: { operation: string; stage: string; time: string; version: number; from?: string; source?: 'history' }[];
  aiValidation?: boolean;
  deliveryGuidance?: string;
  link?: string;
  attachments?: Attachment[];
  gitCommittedVersion?: number;
  gitCommitHash?: string;
  executionVersion?: number;
  verificationVersion?: string;
  verificationComponents?: Record<string, string>;
  completionNote?: string;
  completionNoteVersion?: number;
  scheduledDate?: string;
  executor?: string; // ai | human | plugin:<id> | agent:<id>；旧需求默认 ai
  deferred?: boolean; // 需求池延迟标记：批量全选跳过，仍可手动排期
  archived?: boolean;
  aiExecution?: AIExecution;
};

export type Batch = {
  id: string;
  number: number;
  mode: 'develop' | 'verify';
  status: 'draft' | 'submitted' | 'cancelled';
  text: string;
  hash: string;
  guideVersion: number;
  templateVersion: number;
  items: Item[];
  time: string;
  submittedAt?: string;
};

export function scheduledBatch(p: Project, i: Item) {
  const lastSchedule = i.flowEvents?.slice().reverse().find(e => ['generate', 'revert', 'cancel', 'guidance', 'verify', 'regress'].includes(e.operation));
  if (lastSchedule && lastSchedule.operation !== 'generate') return undefined;
  const batch = p.batches.find(b => b.mode === 'develop' && b.status !== 'cancelled' && b.items.some(old => old.id === i.id));
  const old = batch?.items.find(old => old.id === i.id);
  return batch && batch.guideVersion === p.guideVersion && old?.version === i.version && (old.executor || 'ai') === (i.executor || 'ai') ? batch : undefined;
}

/** 待验证「运行」按钮使用的验证源：本地程序（绝对路径）或网页地址。 */
export type VerifySource = { kind: 'exe' | 'url'; value: string };

export type Project = {
  id: string;
  name: string;
  description: string;
  guidance: string;
  guideVersion: number;
  guideHistory: any[];
  deliveryGuidance: string;
  aiValidation: boolean;
  items: Item[];
  batches: Batch[];
  nextNumber: number;
  dir?: string; // 本地路径或 ssh://user@host:port/absolute/path
  remote?: RemoteSettings;
  terminalCli?: string;
  terminalFullAccess?: boolean;
  versionFile?: string;
  verifySource?: VerifySource; // 验证源：待验证需求一键打开的程序或网页
  publishScript?: string; // 项目内发布脚本相对路径；未设置时自动检测，空串禁用
  baselineTemplate?: string; // 基线需求模板（留空使用 DEFAULT_BASELINE_TEMPLATE）
  folderId?: string;
  hidden?: boolean;
  revision?: number;
  contextRules?: string;
  contextRulesDisabled?: boolean;
  contextRulesLimit?: number; // 守则字数上限，默认 500
  requirementDraft?: Record<string, any>;
  serverAgent?: { id: string }; // 关联的同步服务端（REQ-240）：flow 数据自动推送，本地保留一份
};

export type ContextPrompt = { id: string; title: string; body: string; tags: string[]; projectId?: string; feature?: string; code?: string; files?: string[] };
export type Workspace = { projects: Project[]; folders?: { id: string; name: string }[]; baselineTemplate?: string; publishTemplate?: string; corePromptTemplate?: string; contextPrompts?: ContextPrompt[] };

export const DEFAULT_DELIVERY = '说明改动、测试命令和结果、未解决的问题。';
export const DEFAULT_CONTEXT_RULES_LIMIT = 500;
export const MIN_CONTEXT_RULES_LIMIT = 50;
export const MAX_CONTEXT_RULES_LIMIT = 5000;
export const DEFAULT_GUIDANCE =
  '请结合项目背景实现需求，遵循现有技术栈与代码规范。完成后说明改动、运行方式、验证结果与剩余问题。';

/** 「基线需求」默认模板（REQ-064）：检查忽略规则/输出目录，补齐 scripts/ 下的编译与发布脚本。 */
export const DEFAULT_BASELINE_TEMPLATE = [
  '完善项目基线配置：',
  '1. 检查 .gitignore：构建产物、依赖与运行时生成目录（如 node_modules、dist、release、日志等）应已被忽略；',
  '2. 安装包输出：如项目会生成安装包，指定固定的生成目录，并确认该目录的忽略策略正确；',
  '3. 运行包：如项目有可独立运行的运行包/绿色版，指定固定的输出或运行目录；',
  '4. 编译与发布脚本：在固定位置 scripts/ 下提供编译脚本与发布脚本（可直接运行，注明用法与依赖）；',
  '5. 核对以上配置与当前项目结构一致，缺失或失效的项请补齐或修正。',
  '完成后说明改动、脚本用法与未解决的问题。'
].join('\n');

/** 「发布功能需求」默认模板（REQ-070）：生成在 scripts/ 下放置 publish 发布脚本的需求；
 *  脚本就位后主界面「浏览项目」旁出现「发布」按钮，点击即可执行。 */
const LEGACY_PUBLISH_TEMPLATE = [
  '配置项目发布与部署脚本：',
  '1. 检查项目现有部署脚本及发布配置，优先复用用户已有的部署流程；',
  '2. 如果没有部署脚本，先与用户确认目标位置、部署方式、运行环境、所需凭据与产物、覆盖及回滚策略，再创建可部署到该目标的脚本，不猜测部署细节；',
  '3. 在 scripts/ 或项目根目录提供 publish 入口（如 publish.mjs、publish.py、publish.bat），点击应用的「发布」按钮时实际调用用户的部署脚本；仅构建或生成安装包不能视为部署完成；',
  '4. 按项目交付引导构建并生成产物，再部署到用户确认的目标位置；脚本失败时返回非零退出码，成功时打印部署目标与结果；',
  '5. 注明脚本运行方式、依赖及配置方法，不将凭据写入代码仓库，并验证发布入口能够触发部署流程。',
  '完成后说明发布入口、实际部署脚本、目标位置、验证结果与未解决的问题。'
].join('\n');

export const DEFAULT_PUBLISH_TEMPLATE = [
  "配置项目发布与部署脚本：",
  "1. 先检查项目类型、现有发布脚本与更新配置，优先复用已跑通的流程。明确使用以下哪种模式；混合项目分别完成两条链路。",
  "2. 客户端模式：按交付引导构建安装包或可运行程序，上传到指定服务器或用户确认的分发平台（如 GitHub Releases），提供可访问的版本化下载地址；部署版本元数据、更新清单及校验值，接入客户端检查更新、下载校验和安装或替换能力，验证旧版本能发现并获取新版本。参考 ReqFlow 的构建打包、Release 分发与自动更新流程。",
  "3. 网页服务模式：构建并上传服务程序、网页资源与运行依赖到指定服务器；先识别目标操作系统及可用守护工具，随产物部署匹配的服务定义、环境配置示例和安装/更新脚本（如 systemd 的 .service 与 systemctl、OpenRC、Supervisor 或 Windows 服务），核对用户、目录、权限、端口、启动命令及开机自启；部署后重载服务配置并重启，验证守护程序已启用、服务运行和 HTTP 健康检查均成功，核对线上版本及静态资源。参考 release-watch 的发布入口、部署脚本、服务定义和远端校验流程。",
  "4. 从已有配置读取目标地址、目录、部署方式及认证；缺少必要信息时再向用户确认，不猜测服务器或凭据。分发平台与服务器均以用户配置为准，禁止把参考项目的主机、账号或路径写成新项目默认值。",
  "5. 在 scripts/ 或项目根目录提供 publish 入口（如 publish.mjs、publish.py、publish.ps1），供应用的「发布」按钮实际调用部署脚本；明确区分仅构建、仅打包与完成部署。支持发布前预检、重复发布保护、失败重试及必要的备份/回滚，保护服务器业务数据与现有配置。",
  "6. 校验上传产物完整性；任一步骤失败返回非零退出码，不打印发布成功，记录具体失败阶段。成功时打印模式、版本、部署目标、下载地址或服务地址及验证结果。凭据仅存环境变量或忽略的本地配置，不写入仓库或日志。",
  "7. 版本定位约定：每次发布在项目根 VERSION 写入单行统一交付版本，并在项目设置「验证与发布」将版本号定位文件设为 VERSION；发布前更新并提交该文件，部署后核对线上版本。前端、后端、CLI 独立版本时在 release-versions.json 保存 version（统一交付版本）和 components（各组件版本及源文件路径）；同步更新组件自身版本文件。默认验证统一交付版本；仅验证某组件时明确指定其版本文件，禁止使用 ReqFlow 或其他项目的版本。",
  "完成后说明发布入口与用法、部署配置、产物及更新或守护脚本、实际部署和验证结果；没有完成远端部署或校验时明确列出未完成项。",
].join('\n');

export function requirementSettings(p: Project, i: Item) {
  const aiValidation = false;
  const delivery = i.deliveryGuidance ?? p.deliveryGuidance;
  return {
    aiValidation,
    deliveryGuidance:
      !aiValidation && delivery === DEFAULT_DELIVERY ? '说明改动、未解决的问题。' : delivery
  };
}

/** 未解决的验证失败/回归记录（history 最新在前，取到最近一次「验证通过」为止）。 */
function failureEntries(i: Item) {
  const entries: any[] = [];
  for (const h of i.history) {
    if (h.event === '验证通过') break;
    if (h.event === '验证失败' || h.event === '回归退回') entries.push(h);
  }
  return entries; // 最新在前
}

/**
 * 带入下一轮 Prompt 的未解决问题（旧→新）。
 * - 后续退回时被用户确认「已修复」（history 条目 resolved）的不再出现；
 * - current 标记是否为本轮验证新记录，用于 Prompt 中区分【此前未修复】与【本轮新问题】。
 */
export function unresolvedFailures(i: Item) {
  const unresolved = failureEntries(i).filter((h) => !h.resolved); // 最新在前
  if (!unresolved.length) return [];
  const oldestFirst = unresolved.slice().reverse();
  // 空备注的轮次不单独占一行；全部为空时保留最新一条的兜底文案
  const noted = oldestFirst.filter((h) => String(h.note || '').trim());
  const use = noted.length ? noted : oldestFirst.slice(-1);
  const newestEntry = unresolved[0];
  return use.map((h) => ({
    time: h.time,
    note: h.note || '验证未通过，请重新检查需求实现。',
    current: noted.length ? h === newestEntry : true
  }));
}

export function buildPrompt(p: Project, items: Item[]) {
  const settings = items.map((i) => requirementSettings(p, i));
  const anyValidation = settings.some((s) => s.aiValidation);
  const guidance =
    !anyValidation && p.guidance === DEFAULT_GUIDANCE
      ? p.guidance.replace('、验证结果', '')
      : p.guidance;
  const sections = items
    .map((i, n) => {
      const failures = unresolvedFailures(i);
      // 多条未解决问题时标注来源：旧问题未修复 vs 本轮新问题，便于 AI 区分处理
      const failureLines = failures
        .map((f, j) => {
          const mark = f.current
            ? (failures.length > 1 ? '【本轮新问题】' : '')
            : '【此前问题未修复】';
          return '- ' + (j + 1) + '. ' + mark + f.note;
        })
        .join('\n');
      return (
        '### ' +
        (n + 1) +
        '. ' +
        i.number +
        (i.title ? ' · ' + i.title : '') +
        ' [' +
        i.type +
        ' / ' +
        i.priority +
        ']\n' +
        i.body +
        (i.attachments?.length ? '\n\n参考图片（在正文中使用图片标识指定）：\n' + i.attachments.map((a) => '- ' + a.label + ' · ' + a.name + ': ' + (a.path || a.dataUrl)).join('\n') : '') +
        (failures.length
          ? '\n\n未通过的问题（本轮需修复）：\n' + failureLines
          : '') +
        (i.criteria.length
          ? '\n\n验收条件：\n' + i.criteria.map((c) => '- [ ] ' + c).join('\n')
          : '')
      );
    })
    .join('\n\n');
  // 交付引导 / AI 测试验证在多条需求间常会重复：按内容去重合并到末尾，相同内容只出现一次
  const tail: string[] = [];
  const deliveryGroups: { text: string; nums: string[] }[] = [];
  items.forEach((i, n) => {
    const text = settings[n].deliveryGuidance;
    const g = deliveryGroups.find((g) => g.text === text);
    if (g) g.nums.push(i.number);
    else deliveryGroups.push({ text, nums: [i.number] });
  });
  for (const g of deliveryGroups)
    tail.push('交付引导（' + (deliveryGroups.length === 1 ? '本轮全部需求' : g.nums.join('、')) + '）：\n' + g.text);
  const releaseContext = [guidance, ...items.flatMap((i, n) => [i.title, i.body, ...i.criteria, settings[n].deliveryGuidance])].join('\n');
  if (/发布|安装包|打包|升版|版本(?:说明|更新|交付)|\b(?:release|changelog)\b/i.test(releaseContext)) {
    tail.push(RELEASE_NOTES_GUIDANCE);
  }
  return (
    '# 项目：' +
    p.name +
    '\n\n## 项目上下文\n' +
    p.description +
    '\n\n## 引导词 · v' +
    p.guideVersion +
    ' - 请开发过程中严格执行引导词中的要求。\n' +
    guidance +
    (p.contextRules ? "\n\n## 项目守则（自动生成）\n" + p.contextRules : "") +
    '\n\n## 本轮目标\n实现以下需求，按列出的顺序执行。\n\n' +
    sections +
    (tail.length ? '\n\n' + tail.join('\n\n') : '')
  );
}

export const RELEASE_NOTES_GUIDANCE = [
  '## 版本交付与发布说明',
  '本轮涉及版本交付或编写发布说明时，必须遵守以下要求：',
  '- 使用本轮确定的交付版本；发布重试沿用该版本，不因重试再次升版。按仓库约定编写发布说明；无约定时使用 docs/release-<版本>.md。',
  '- 发布说明必须包含一级标题「# 项目名 <版本>」，以及独立的二级标题「## 主要更新」；在该章节下用「- 」列表列出本版本实际完成的功能、改进或修复，不能把更新列表直接放在一级标题下。',
  '- 「## 主要更新」只写实际产品变化，不写交付引导、开发指令、测试命令或安装步骤；不得只有安装说明，不得将未完成事项写成已完成，不得保留待填写占位内容。',
  '- 交付前核对发布说明中的版本与交付版本一致，并运行仓库已有的发布说明校验或发布预检；ReqFlow 仓库运行 node scripts/release-notes-check.mjs，并调用 releaseNotes 校验当前版本文件。校验失败先修正，再报告结果。'
].join('\n');

export function normalizeWorkspace(s: Workspace) {
  refreshContextRules(s);
  if (!Array.isArray(s.folders)) s.folders = [];
  if (!s.folders.some((f) => f.id === 'default')) s.folders.unshift({ id: 'default', name: 'default' });
  // 全局基准模板（REQ-071）：留空视为未设置，项目回退到默认模板
  if (typeof s.baselineTemplate === 'string' && s.baselineTemplate.trim()) s.baselineTemplate = s.baselineTemplate.trim();
  else s.baselineTemplate = undefined;
  s.corePromptTemplate = typeof s.corePromptTemplate === 'string' && s.corePromptTemplate.trim() ? s.corePromptTemplate.trim() : undefined;
  s.publishTemplate = typeof s.publishTemplate === 'string' && s.publishTemplate.trim() ? s.publishTemplate.trim() : undefined;
  if (s.publishTemplate === LEGACY_PUBLISH_TEMPLATE) s.publishTemplate = DEFAULT_PUBLISH_TEMPLATE;
  for (const p of s.projects) {
    if (!Number.isSafeInteger(p.revision) || p.revision! < 0) p.revision = 0;
    if (!s.folders.some((f) => f.id === p.folderId)) p.folderId = 'default';
    if (typeof p.deliveryGuidance !== 'string') p.deliveryGuidance = DEFAULT_DELIVERY;
    if (typeof p.aiValidation !== 'boolean') p.aiValidation = false;
    if (!(Number.isSafeInteger(p.contextRulesLimit) && p.contextRulesLimit! >= MIN_CONTEXT_RULES_LIMIT && p.contextRulesLimit! <= MAX_CONTEXT_RULES_LIMIT)) delete p.contextRulesLimit;
    if (typeof p.dir !== 'string' || !p.dir.trim()) p.dir = undefined;
    if (typeof p.baselineTemplate === 'string' && p.baselineTemplate.trim()) p.baselineTemplate = p.baselineTemplate.trim();
    else p.baselineTemplate = undefined;
    if (p.verifySource && ((p.verifySource.kind !== 'exe' && p.verifySource.kind !== 'url')
      || typeof p.verifySource.value !== 'string' || !p.verifySource.value.trim())) p.verifySource = undefined;
    else if (p.verifySource) p.verifySource = { kind: p.verifySource.kind, value: p.verifySource.value.trim() };
    for (const i of p.items) {
      if (i.executor === undefined) i.executor = 'ai';
      if (!i.flowEvents) {
        const stages: Record<string, string> = { '创建': 'ready', '标记待提交': 'ready', '取消执行': 'ready', '退回待执行': 'ready', '验证失败': 'ready', '回归退回': 'ready', '实现完成': 'pending_verification', '归档': 'archived', '验证通过': 'archived' };
        i.flowEvents = i.history.slice().reverse().flatMap(h => {
          const stage = String(h.event).startsWith('确认提交') ? 'in_progress' : stages[h.event];
          return stage && Number.isFinite(Date.parse(h.time)) ? [{ operation: h.event, stage, time: h.time, version: h.version ?? h.snapshot?.version ?? 0, source: 'history' as const }] : [];
        });
      }
      if (i.archived || i.status === 'verified') {
        i.status = 'archived';
        i.archived = true;
      } else if (i.status === 'draft') {
        i.status = 'ready';
        i.version++;
      }
    }
  }
  return s;
}

export const makeProject = (name: string, description = ''): Project => ({
  id: crypto.randomUUID(),
  name,
  description,
  guidance: DEFAULT_GUIDANCE,
  guideVersion: 1,
  guideHistory: [],
  deliveryGuidance: DEFAULT_DELIVERY,
  aiValidation: false,
  items: [],
  batches: [],
  nextNumber: 1
});

const needed = (v: any, label: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error('请填写' + label);
  return v.trim();
};

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 对工作区应用一次操作。op 取值：
 * project / deleteProject / projectDir / guidance / verifySource / baselineTemplate / item / moveItem / deleteItem / generate / submit / cancel / complete / revert / verify / regress / archive
 *（ready 为历史接口，保留兼容。）
 */
export async function projectConcurrencyToken(p: Project): Promise<string> {
  // Materialized attachment paths are derived, not user edits. Content tokens also
  // detect older writers which preserve (but do not increment) project.revision.
  return sha256Hex(JSON.stringify({ ...p, revision: undefined }, (key, value) => {
    if (key === 'path') return undefined;
    // Database reconstruction can reorder object fields without changing content.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]]));
    }
    return value;
  }));
}
export function mutationProjectIds(a: any): string[] | null {
  const localOps = ['deleteProject', 'projectFolder', 'projectDescription', 'projectRemote', 'projectDir', 'projectSync', 'guidance', 'projectRuntime', 'verifySource', 'publishScript', 'baselineTemplate', 'assign', 'deferItem', 'item', 'aiItems', 'deleteItem', 'moveItem', 'generate', 'submit', 'cancel', 'complete', 'completionNote', 'verificationVersion', 'revert', 'verify', 'regress', 'archive', 'gitCommitted'];
  if (!(localOps.includes(a?.op) || ['requirementDraft', 'executionClaim', 'executionRelease'].includes(a?.op)) || typeof a.project !== 'string') return null;
  return [...new Set(a.op === 'moveItem' ? [a.project, a.targetProject] : [a.project])];
}
export async function apply(s: Workspace, a: any) {
  normalizeWorkspace(s);
  const before = new Map(s.projects.map(p => [p.id, { json: JSON.stringify(p), revision: p.revision || 0 }]));
  const previousItems = new Map(s.projects.flatMap(p => p.items.map(i => [i.id, { status: i.status, historyTime: i.history[0]?.time, historyEvent: i.history[0]?.event, events: i.flowEvents?.length || 0 }] as const)));
  await applyOperation(s, a);
  for (const p of s.projects) for (const i of p.items) {
    const old = previousItems.get(i.id);
    const h = i.history[0];
    // aiItems 的内部 apply 已记录步骤，外层不重复记账。
    if ((i.flowEvents?.length || 0) > (old?.events || 0)) continue;
    if (!old || old.status !== i.status || old.historyTime !== h?.time || old.historyEvent !== h?.event) {
      (i.flowEvents ||= []).push({ operation: a.op, stage: i.status, from: old?.status, time: h?.time || new Date().toISOString(), version: i.version });
    }
  }
  for (const p of s.projects) {
    const old = before.get(p.id);
    if (!old || JSON.stringify(p) !== old.json) p.revision = (old?.revision || 0) + 1;
  }
}
async function applyOperation(s: Workspace, a: any) {
  normalizeWorkspace(s);

  if (a.op === 'contextPrompt' || a.op === 'deleteContextPrompt') {
    const prompts = s.contextPrompts ||= [];
    const index = prompts.findIndex(prompt => prompt.id === a.id);
    if (a.id && index < 0) throw Error('提示词不存在，请刷新后重试');
    if (a.op === 'deleteContextPrompt') {
      if (index < 0) throw Error('提示词不存在');
      prompts.splice(index, 1);
    } else {
      if (!Array.isArray(a.tags) || a.tags.some((tag: unknown) => typeof tag !== 'string')) throw Error('标签格式无效');
      if (a.projectId && (!s.projects.some(p => p.id === a.projectId) || !String(a.feature || '').trim())) throw Error('关联项目不存在或功能名称为空');
      const prompt = { projectId: a.projectId ?? prompts[index]?.projectId, feature: a.feature ?? prompts[index]?.feature, id: a.id || crypto.randomUUID(), title: needed(a.title, '提示词标题'), body: needed(a.body, '提示词内容'), tags: [...new Set<string>(a.tags.map((tag: string) => tag.trim()).filter(Boolean))], code: String(a.code ?? prompts[index]?.code ?? '').trim(), files: a.files === undefined ? prompts[index]?.files || [] : [...new Set<string>((Array.isArray(a.files) ? a.files : []).map((file: string) => String(file).trim().replaceAll('\\', '/')).filter(Boolean))] };
      if (index < 0) prompts.push(prompt); else prompts[index] = prompt;
    }
    refreshContextRules(s);
    return;
  }

  if (a.op === 'folder') {
    const name = needed(a.name, '文件夹名称');
    if (s.folders!.some((f) => f.name === name)) throw Error('文件夹名称已存在');
    s.folders!.push({ id: crypto.randomUUID(), name });
    return;
  }

  // 删除文件夹（REQ-111）：default 固定保留；删除后其中的项目自动迁移到 default，
  // 项目与需求本身不受影响（normalizeWorkspace 也会把未知 folderId 归位到 default）。
  if (a.op === 'deleteFolder') {
    if (a.folderId === 'default') throw Error('default 文件夹不可删除');
    const folder = s.folders!.find((f) => f.id === a.folderId);
    if (!folder) throw Error('文件夹不存在');
    s.folders!.splice(s.folders!.indexOf(folder), 1);
    for (const p of s.projects) if (p.folderId === folder.id) p.folderId = 'default';
    return;
  }

  if (a.op === 'project') {
    const project = makeProject(needed(a.name, '项目名称'), String(a.description || ''));
    if (a.dir !== undefined) {
      if (typeof a.dir !== 'string') throw Error('项目目录格式无效');
      project.dir = a.dir.trim() || undefined;
    }
    if (a.remote !== undefined) project.remote = validateRemote(a.remote);
    if (a.newFolderName !== undefined) {
      const name = needed(a.newFolderName, '文件夹名称');
      if (s.folders!.some((f) => f.name === name)) throw Error('文件夹名称已存在');
      const folder = { id: crypto.randomUUID(), name };
      project.folderId = folder.id;
      s.folders!.push(folder);
    } else if (a.folderId !== undefined) {
      if (!s.folders!.some((f) => f.id === a.folderId)) throw Error('文件夹不存在');
      project.folderId = a.folderId;
    }
    s.projects.push(project);
    return;
  }

  // 全局基准需求模板（REQ-071）：工作区级设置，所有未设置独立模板的项目共用；留空恢复默认模板
  if (a.op === 'globalBaselineTemplate') {
    const text = String(a.text || '').trim();
    s.baselineTemplate = text || undefined;
    return;
  }

  if (a.op === 'globalCorePromptTemplate') {
    s.corePromptTemplate = String(a.text || '').trim() || undefined;
    return;
  }

  if (a.op === 'globalPublishTemplate') {
    s.publishTemplate = String(a.text || '').trim() || undefined;
    return;
  }

  const p = s.projects.find((p) => p.id === a.project);
  if (!p) throw new Error('项目不存在');
  if (!['executionClaim', 'executionRelease', 'gitCommitted', 'requirementDraft', 'completionNote', 'verificationVersion'].includes(a.op)) {
    const ids = [...(a.ids || []), ...(a.id ? [a.id] : [])];
    if (['cancel', 'submit'].includes(a.op)) ids.push(...(p.batches.find(b => b.id === a.batch)?.items.map(i => i.id) || []));
    if (['deleteProject', 'projectDir', 'projectDescription'].includes(a.op)) ids.push(...p.items.map(i => i.id));
    for (const id of ids) {
      const item = p.items.find(i => i.id === id);
      const execution = item && activeAIExecution(item);
      if (execution && !(a.op === 'complete' && execution.runId === a.run)) throw Error('需求正在由 ' + execution.client + ' 执行，请先释放任务');
    }
  }

  if (a.op === 'requirementDraft') {
    if (!a.draft || typeof a.draft !== 'object' || Array.isArray(a.draft)) throw Error('草稿格式无效');
    p.requirementDraft = structuredClone(a.draft);
    return;
  }

  if (a.op === 'projectFolder') {
    if (!s.folders!.some((f) => f.id === a.folderId)) throw Error('文件夹不存在');
    p.folderId = a.folderId;
    return;
  }
  if (a.op === 'projectVisibility') {
    if (typeof a.hidden !== 'boolean') throw Error('项目隐藏状态无效');
    p.hidden = a.hidden;
    return;
  }
  if (a.op === 'projectMove') {
    if (!['up', 'down'].includes(a.direction)) throw Error('排序方向无效');
    const peers = s.projects.filter(pr => pr.folderId === p.folderId);
    const neighbor = peers[peers.indexOf(p) + (a.direction === 'up' ? -1 : 1)];
    if (neighbor) {
      const from = s.projects.indexOf(p), to = s.projects.indexOf(neighbor);
      [s.projects[from], s.projects[to]] = [s.projects[to], s.projects[from]];
    }
    return;
  }
  if (a.op === 'projectReorder') {
    // REQ-167：远程项目并入各文件夹后，排序分组只看文件夹，不再按本地/远程拆分
    if (!['top', 'before', 'after'].includes(a.position)) throw Error('排序目标无效');
    let target: Project | undefined;
    if (a.position === 'top') {
      target = s.projects.find(pr => pr.folderId === p.folderId && pr !== p);
      if (!target) return; // 已在当前文件夹顶部
    } else {
      // REQ-281：拖到其他文件夹的项目上时，先迁移分组再按目标位置排序
      target = s.projects.find(pr => pr.id === a.target);
      if (!target) throw Error('排序目标无效');
      if (target === p) return;
      p.folderId = target.folderId;
    }
    const peers = s.projects.filter(pr => pr.folderId === p.folderId);
    const ordered = peers.filter(pr => pr !== p);
    ordered.splice(a.position === 'top' ? 0 : ordered.indexOf(target) + (a.position === 'after' ? 1 : 0), 0, p);
    let index = 0;
    s.projects = s.projects.map(pr => peers.includes(pr) ? ordered[index++] : pr);
    return;
  }
  if (a.op === 'aiItems') {
    if (!Array.isArray(a.items) || !a.items.length || a.items.length > 20) throw Error('需求列表无效');
    // 同一次工作区事务保存整组需求，失败时不会留下部分条目。
    for (const item of a.items) await apply(s, { ...item, id: undefined, attachments: [], op: 'item', project: p.id });
    return;
  }

  if (a.op === 'deleteProject') {
    if (s.projects.length <= 1) throw new Error('至少保留一个项目，最后一个项目不可删除');
    s.projects.splice(s.projects.indexOf(p), 1);
    return;
  }
  const now = new Date().toISOString();
  if (a.op === 'executionClaim') {
    if (!['codex', 'zcode', 'pi', 'claude-code', 'dsh', 'opencode'].includes(a.client) || !/^[a-f0-9-]{36}$/.test(a.run || '')) throw Error('AI 领取客户端或运行 ID 无效');
    if (!Array.isArray(a.claims) || !a.claims.length) throw Error('AI 领取请求不能为空');
    const seen = new Set();
    for (const r of a.claims) {
      if (!r?.id || seen.has(r.id) || !Number.isSafeInteger(r.version) || !r.batchId || !r.hash) throw Error('AI 领取请求格式无效');
      seen.add(r.id);
    }
    for (const r of a.claims) {
      const i = p.items.find(i => i.id === r.id);
      if (!i || i.archived || (i.executor || 'ai') !== 'ai' || !['ready', 'in_progress'].includes(i.status) || activeAIExecution(i)) continue;
      const b = scheduledBatch(p, i);
      if (!b || b.id !== r.batchId || b.hash !== r.hash || i.version !== r.version) continue;
      i.aiExecution = { runId: a.run, client: a.client, startedAt: now, version: i.version, batchId: b.id };
      i.history.unshift({ event: 'AI 领取任务', time: now, client: a.client, runId: a.run });
    }
    return;
  }
  if (a.op === 'executionRelease') {
    const i = p.items.find(i => i.id === a.id);
    if (!i || !activeAIExecution(i)) throw Error('需求没有正在执行的 AI 任务');
    if (a.run && i.aiExecution!.runId !== a.run) throw Error('AI 任务属于另一运行记录');
    finishAIExecution(i, now, 'released');
    i.history.unshift({ event: '释放 AI 任务', time: now, note: String(a.note || ''), execution: structuredClone(i.aiExecution) });
    return;
  }

  if (a.op === 'projectDescription') {
    p.description = String(a.description || '');
    p.guideVersion++;
    return;
  }
  if (a.op === 'projectRemote') {
    p.remote = validateRemote(a.remote);
    return;
  }

  if (a.op === 'projectSync') {
    // REQ-240：项目关联 / 解除关联 Server Agent；解除后继续使用本地数据
    const id = typeof a.server === 'string' ? a.server.trim() : String(a.server?.id || '').trim();
    if (!a.server) { delete p.serverAgent; return; }
    if (!id) throw Error('请选择要关联的 Server Agent');
    p.serverAgent = { id };
    return;
  }

  if (a.op === 'projectDir') {
    // 关联/更换/取消关联本地项目目录：仅保存路径设置，不产生需求历史
    const dir = a.dir === undefined ? p.dir : String(a.dir).trim();
    p.dir = dir || undefined;
    return;
  }

  if (a.op === 'guidance') {
    const text = needed(a.text, '项目引导词');
    const delivery =
      a.deliveryGuidance === undefined ? p.deliveryGuidance : needed(a.deliveryGuidance, '交付引导');
    let limit = contextRulesLimit(p);
    if (a.contextRulesLimit !== undefined) {
      if (!Number.isSafeInteger(a.contextRulesLimit) || a.contextRulesLimit < MIN_CONTEXT_RULES_LIMIT || a.contextRulesLimit > MAX_CONTEXT_RULES_LIMIT)
        throw new Error('守则字数上限需在 50 到 5000 字之间');
      limit = a.contextRulesLimit;
    }
    if (typeof a.contextRulesDisabled === 'boolean') {
      p.contextRulesDisabled = a.contextRulesDisabled;
      refreshContextRules(s);
    }
    const guideChanged = text !== p.guidance || delivery !== p.deliveryGuidance;
    const limitChanged = limit !== contextRulesLimit(p);
    if (!guideChanged && !limitChanged) return;
    if (limitChanged) {
      p.contextRulesLimit = limit;
      refreshContextRules(s);
    }
    if (!guideChanged) return;
    p.guideHistory.unshift({
      version: p.guideVersion,
      text: p.guidance,
      deliveryGuidance: p.deliveryGuidance,
      aiValidation: p.aiValidation,
      time: now
    });
    p.guidance = text;
    p.deliveryGuidance = delivery;
    p.guideVersion++;
    return;
  }

  if (a.op === 'publishScript') {
    if (a.script === null || a.script === undefined) p.publishScript = undefined;
    else {
      const script = String(a.script).trim().replace(/\\/g, '/');
      if (script && (script.startsWith('/') || /^[a-z]:/i.test(script) || script.split('/').includes('..') || !/\.(mjs|js|cjs|bat|cmd|ps1|sh|py)$/i.test(script))) throw Error('发布脚本须为项目内的相对路径及支持的脚本类型');
      p.publishScript = script;
    }
    return;
  }

  if (a.op === 'projectRuntime') {
    if (!['codex', 'claude-code', 'pi'].includes(a.cli)) throw Error('CLI 无效');
    p.terminalCli = a.cli; p.terminalFullAccess = a.fullAccess !== false; p.versionFile = String(a.versionFile || '').trim();
    return;
  }
  if (a.op === 'verifySource') {
    // 验证源独立于引导词保存：不递增 guideVersion、不影响进行中的批次
    if (a.source === null || a.source === undefined || a.source === '') {
      p.verifySource = undefined;
      return;
    }
    const kind = (a.source as any).kind, value = String((a.source as any).value || '').trim();
    if ((kind !== 'exe' && kind !== 'url') || !value) throw new Error('验证源配置无效：请选择类型并填写程序路径或网页地址');
    p.verifySource = { kind, value };
    return;
  }

  if (a.op === 'baselineTemplate') {
    // 基线需求模板独立保存：不影响引导词版本与进行中的批次
    const text = String(a.text || '').trim();
    p.baselineTemplate = text || undefined;
    return;
  }

  if (a.op === 'gitCommitted') {
    for (const snapshot of a.items || []) {
      const item = p.items.find((i) => i.id === snapshot.id);
      if (item && Number.isInteger(snapshot.version) && snapshot.version > 0 && snapshot.version <= item.version) {
        item.gitCommittedVersion = Math.max(item.gitCommittedVersion || 0, snapshot.version);
        item.gitCommitHash = String(a.hash || '');
      }
    }
    return;
  }

  if (a.op === 'assign') {
    if (typeof a.executor !== 'string' || !/^(ai|human|(?:plugin|agent):[a-zA-Z0-9_.-]+)$/.test(a.executor)) throw Error('执行方式无效');
    if (!Array.isArray(a.ids) || a.ids.some((id: unknown) => typeof id !== 'string')) throw Error('可指派需求已变化');
    const items = p.items.filter(i => a.ids.includes(i.id));
    if (!items.length || items.length !== new Set(a.ids).size || items.some(i => !['ready', 'in_progress', 'pending_verification'].includes(i.status) || i.archived)) throw Error('可指派需求已变化');
    for (const i of items) {
      if ((i.executor || 'ai') === a.executor) continue;
      i.executor = a.executor;
      for (const b of p.batches) if (b.mode === 'develop' && b.status !== 'cancelled') {
        const snapshot = b.items.find(x => x.id === i.id && x.version === i.version);
        if (snapshot) { snapshot.executor = a.executor; b.hash = await sha256Hex(JSON.stringify(b.items) + b.text); }
      }
    }
    return;
  }
  if (a.op === 'deferItem') {
    const i = p.items.find(i => i.id === a.id);
    if (!i || i.archived || i.status !== 'ready' || activeAIExecution(i) || scheduledBatch(p, i)) throw Error('只能标记需求池中的需求');
    if (typeof a.deferred !== 'boolean') throw Error('延迟标记无效');
    if (!!i.deferred !== a.deferred) {
      i.deferred = a.deferred;
      i.history.unshift({ event: a.deferred ? '延迟需求' : '取消延迟', time: now });
    }
    return;
  }
  if (a.op === 'item') {
    const existing = p.items.find((i) => i.id === a.id);
    // 部分编辑：未传的字段回退到已有值（新增时回退到默认值），标题选填，留空时 Prompt 中仅显示需求编号
    const criteria =
      a.criteria === undefined
        ? (existing?.criteria ?? [])
        : String(a.criteria)
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean);
    const attachments: Attachment[] = a.attachments === undefined ? (existing?.attachments || []) : a.attachments;
    if (!Array.isArray(attachments) || attachments.length > 12 || attachments.some((x) =>
      !x || !/^[a-zA-Z0-9-]+$/.test(x.id) || !/^图片[1-9]\d*$/.test(x.label) || typeof x.name !== 'string' ||
      typeof x.dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(x.dataUrl) || x.dataUrl.length > 14 * 1024 * 1024
    ) || new Set(attachments.map((x) => x.label)).size !== attachments.length || new Set(attachments.map((x) => x.id)).size !== attachments.length)
      throw new Error('图片附件无效（最多 12 张，每张最多 10MB，支持 PNG/JPG/WebP/GIF）');
    // 默认不带计划日期；只有调用方显式传入日期（如用户在日期控件点选）才记录
    const scheduledDate = a.scheduledDate === undefined ? existing?.scheduledDate : validateDate(a.scheduledDate);
    const title = a.title === undefined ? (existing?.title ?? '') : String(a.title).trim();
    const body = a.body === undefined ? (existing?.body ?? '') : String(a.body);
    const type = a.type ?? existing?.type ?? 'feature';
    const priority = a.priority ?? existing?.priority ?? 'P1';
    const executor = a.executor ?? existing?.executor ?? 'ai';
    if (typeof executor !== 'string' || !/^(ai|human|(?:plugin|agent):[a-zA-Z0-9_.-]+)$/.test(executor)) throw Error('执行方式无效');
    const aiValidation = false;
    if (typeof aiValidation !== 'boolean') throw new Error('AI 测试验证设置无效');
    const deliveryGuidance =
      a.deliveryGuidance === undefined
        ? (existing?.deliveryGuidance ?? p.deliveryGuidance)
        : needed(a.deliveryGuidance, '交付引导');
    if (!['feature', 'improvement', 'bug'].includes(type) || !['P0', 'P1', 'P2'].includes(priority))
      throw new Error('类型或优先级无效');
    const i = existing;
    if (i) {
      if (!['draft', 'ready'].includes(i.status)) throw new Error('请先取消执行或退回，再编辑需求');
      i.history.unshift({ event: '编辑', time: now, snapshot: { ...i, history: undefined } });
      Object.assign(i, {
        title,
        body,
        attachments,
        criteria,
        aiValidation,
        deliveryGuidance,
        type,
        priority,
        executor,
        status: 'ready',
        scheduledDate,
        version: i.version + 1
      });
    } else {
      if (a.clearDraft) delete p.requirementDraft;
      p.items.push({
        id: crypto.randomUUID(),
        number: 'REQ-' + String(p.nextNumber++).padStart(3, '0'),
        title,
        body,
        attachments,
        criteria,
        aiValidation,
        deliveryGuidance,
        type,
        priority,
        executor,
        status: 'ready',
        scheduledDate,
        version: 1,
        history: [{ event: '创建', time: now }]
      });
    }
    return;
  }

  if (a.op === 'generate') {
    if (a.mode && a.mode !== 'develop')
      throw new Error('已取消协助验证模式，请从待执行需求生成 Prompt');
    const items = (a.ids || []).map((id: string) => p.items.find((i) => i.id === id));
    // 执行中的需求允许累积进新一轮 Prompt（前一轮未完成时可与新增需求一起或单独生成）
    if (
      !items.length ||
      items.some((i: Item) => !i || i.archived || (i.status !== 'ready' && i.status !== 'in_progress'))
    )
      throw new Error('请选择待执行或执行中的需求');
    for (const i of items as Item[]) (i.flowEvents ||= []).push({ operation: 'generate', stage: i.status, time: now, version: i.version });
    const snapshots = items.map((i: Item) => ({
      ...structuredClone(i),
      ...requirementSettings(p, i)
    }));
    const text = buildPrompt(p, snapshots);
    const hash = await sha256Hex(text);
    p.batches.unshift({
      id: crypto.randomUUID(),
      number: p.batches.length + 1,
      mode: 'develop',
      status: 'draft',
      text,
      hash,
      guideVersion: p.guideVersion,
      templateVersion: 5,
      items: snapshots,
      time: now
    });
    return;
  }

  if (a.op === 'submit' || a.op === 'cancel') {
    const b = p.batches.find((b) => b.id === a.batch);
    if (!b) throw new Error('批次不存在');
    if (a.op === 'submit') {
      if (b.status !== 'draft' || b.mode !== 'develop') throw new Error('该批次不能提交');
      if (
        b.guideVersion !== p.guideVersion ||
        b.items.some((old: Item) => {
          const i = p.items.find((i) => i.id === old.id);
          return (
            !i || i.version !== old.version || (i.status !== 'ready' && i.status !== 'in_progress') || i.archived
          );
        })
      )
        throw new Error('源内容或状态已变化，请重新生成批次');
      b.status = 'submitted';
      b.submittedAt = now;
      b.items.forEach((old: Item) => {
        const i = p.items.find((i) => i.id === old.id)!;
        i.status = 'in_progress';
        i.executionVersion = old.version;
        i.history.unshift({ event: '确认提交 · 批次 ' + b.number, time: now });
      });
    } else {
      if (b.status !== 'submitted') throw new Error('只能取消已提交批次');
      b.status = 'cancelled';
      b.items.forEach((old: Item) => {
        const i = p.items.find((i) => i.id === old.id);
        // 需求可能被累积进多个已提交批次：仍被其他批次执行着时保持执行中
        const stillRunning = p.batches.some(
          (o) => o !== b && o.status === 'submitted' && o.items.some((x) => x.id === old.id)
        );
        if (i?.status === 'in_progress' && !stillRunning) {
          i.status = 'ready';
          i.history.unshift({ event: '取消执行', time: now });
        }
      });
    }
    return;
  }

  const i = p.items.find((i) => i.id === a.id);
  if (!i) throw new Error('需求不存在');

  if (a.op === 'moveItem' || a.op === 'deleteItem') {
    if (i.status !== 'ready' || i.archived) throw new Error('只有待执行需求可迁移或删除');
    if (a.op === 'deleteItem') {
      p.items.splice(p.items.indexOf(i), 1);
      return;
    }
    const target = s.projects.find((project) => project.id === a.targetProject);
    if (!target) throw new Error('目标项目不存在');
    if (target.id === p.id) throw new Error('请选择其他项目');
    if (target.items.some((item) => item.id === i.id)) throw new Error('目标项目已有相同需求');
    // 固定原项目的有效设置，迁移后不因目标项目默认值不同而改变。
    const settings = requirementSettings(p, i);
    const oldNumber = i.number;
    Object.assign(i, settings, {
      number: 'REQ-' + String(target.nextNumber++).padStart(3, '0'),
      version: i.version + 1
    });
    delete i.executionVersion;
    i.history.unshift({
      event: '迁移项目', time: now,
      note: `${p.name} · ${oldNumber} → ${target.name} · ${i.number}`,
      sourceProject: p.id, targetProject: target.id
    });
    p.items.splice(p.items.indexOf(i), 1);
    target.items.push(i);
    return;
  }

  if (a.op === 'ready') {
    if (i.status !== 'draft') throw new Error('只有草稿可标记待提交');
    i.status = 'ready';
    i.version++;
    i.history.unshift({ event: '标记待提交', time: now });
    return;
  }
  if (a.op === 'complete') {
    const completionNote = completionSummary(a);
    if (a.batch) {
      const batch = scheduledBatch(p, i);
      if (!batch || batch.id !== a.batch || (i.executor || 'ai') !== 'ai' || !['ready', 'in_progress'].includes(i.status) || i.archived || a.version !== i.version) throw Error('AI 排期任务或版本已变化');
      i.executionVersion = i.version;
    } else if (i.status !== 'in_progress') {
      if (i.status !== 'ready' || i.archived || !scheduledBatch(p, i)) throw new Error('需求不在执行中或有效排期中');
      i.executionVersion = i.version;
    }
    let usage: any[] | undefined;
    if (a.usage !== undefined) {
      if (!Array.isArray(a.usage) || a.usage.length > 100) throw Error('usage 须为最多100条记录的数组');
      usage = a.usage.map((u: any) => {
        if (!u || typeof u.model !== 'string' || !u.model.trim() || u.model.length > 200) throw Error('usage model 无效');
        if (u.inputTokens === undefined || u.outputTokens === undefined) throw Error('usage 必须提供实际输入与输出 Token');
        const clean: any = { model: u.model.trim(), scope: u.scope === 'run' ? 'run' : 'requirement' };
        for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens']) { const n = u[key] ?? 0; if (!Number.isSafeInteger(n) || n < 0) throw Error('usage Token 无效'); clean[key] = n; }
        if (clean.cachedInputTokens > clean.inputTokens || clean.reasoningOutputTokens > clean.outputTokens) throw Error('usage 子集 Token 超过总量');
        clean.totalTokens = clean.inputTokens + clean.outputTokens;
        if (!Number.isSafeInteger(clean.totalTokens)) throw Error('usage Token 超出范围');
        for (const key of ['source', 'sessionId', 'reasoningEffort']) { if (u[key] !== undefined && (typeof u[key] !== 'string' || u[key].length > 300)) throw Error('usage 元数据无效'); clean[key] = u[key] || ''; }
        if (clean.scope === 'run' && !clean.sessionId) throw Error('共享 usage 缺少 sessionId');
        return clean;
      });
    }
    finishAIExecution(i, now, 'completed');
    i.status = 'pending_verification';
    delete i.verificationVersion;
    delete i.verificationComponents;
    const verificationVersion = String(a.verificationVersion || '').trim();
    if (verificationVersion && [...verificationVersion].length <= 100 && !/[\r\n]/.test(verificationVersion)) i.verificationVersion = verificationVersion;
    const components = versionComponents(a.verificationComponents);
    if (Object.keys(components).length) i.verificationComponents = components;
    i.link = String(a.link || '');
    if (completionNote) {
      i.completionNote = completionNote;
      i.completionNoteVersion = i.version;
    } else {
      delete i.completionNote;
      delete i.completionNoteVersion;
    }
    i.history.unshift({ ...(usage ? { usage } : {}), event: '实现完成', time: now, link: i.link, note: String(a.note || ''), ...(completionNote ? { summary: completionNote } : {}), ...(i.aiExecution ? { execution: structuredClone(i.aiExecution) } : {}) });
    return;
  }
  if (a.op === 'verificationVersion') {
    if (i.status !== 'pending_verification' || i.executionVersion !== i.version || a.version !== i.version) throw Error('只能为当前待验证需求设置验证版本');
    const value = String(a.value || '').trim();
    if ([...value].length > 100 || /[\r\n]/.test(value)) throw Error('验证版本须为 100 字以内的单行文字');
    if (value) i.verificationVersion = value; else delete i.verificationVersion;
    if (a.components !== undefined) {
      const components = versionComponents(a.components);
      if (Object.keys(components).length) i.verificationComponents = components; else delete i.verificationComponents;
    }
    return;
  }
  if (a.op === 'completionNote') {
    if (i.status !== 'pending_verification' || i.executionVersion !== i.version) throw Error('只能为当前版本的待验证需求写入完成说明');
    if (a.version !== undefined && a.version !== i.version) throw Error('需求版本已变化');
    i.completionNote = completionSummary({ summary: a.summary });
    i.completionNoteVersion = i.version;
    i.history.unshift({ event: '更新完成说明', time: now, summary: i.completionNote, version: i.version });
    return;
  }
  if (a.op === 'revert') {
    // 单条退回待执行：不必取消整个批次，退回后即可编辑；同批次其他需求不受影响
    if (i.status !== 'in_progress' && !(i.status === 'ready' && scheduledBatch(p, i))) throw new Error('需求不在执行中');
    i.status = 'ready';
    i.history.unshift({ event: '退回待执行', time: now, note: String(a.note || '') });
    return;
  }
  if (a.op === 'verify') {
    if (i.status !== 'pending_verification') throw new Error('需求不在待验证');
    if (typeof a.pass !== 'boolean') throw new Error('请确认验证结果');
    if (a.pass && i.executionVersion !== i.version)
      throw new Error('需求版本已变化，请重新实现后验证');
    // 二次及以后退回：a.fixed 为弹窗中用户确认「已修复」的旧问题下标（unresolvedFailures 顺序）
    if (!a.pass && a.fixed !== undefined) {
      if (!Array.isArray(a.fixed)) throw new Error('已修复标记无效');
      const prior = failureEntries(i).filter((h) => !h.resolved).reverse(); // 旧→新，与弹窗展示一致
      for (const v of a.fixed) {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n >= prior.length) throw new Error('已修复标记无效');
        prior[n].resolved = true;
      }
    }
    i.history.unshift({
      event: a.pass ? '验证通过' : '验证失败',
      time: now,
      note: String(a.note || ''),
      confirmation: '用户手动确认',
      version: i.version
    });
    if (a.pass) {
      i.status = 'archived';
      i.archived = true;
      i.history.unshift({ event: '归档', time: now, reason: '验证通过后自动归档' });
    } else {
      i.status = 'ready';
      i.archived = false;
      i.version++;
    }
    return;
  }
  if (a.op === 'regress') {
    if (!i.archived && i.status !== 'archived') throw new Error('需求尚未归档');
    i.history.unshift({ event: '回归退回', time: now, note: String(a.note || '') });
    i.status = 'ready';
    i.archived = false;
    i.version++;
    return;
  }
  if (a.op === 'archive') {
    if (i.status === 'in_progress') throw new Error('请先取消执行');
    i.archived = true;
    i.status = 'archived';
    i.history.unshift({ event: '归档', time: now });
    return;
  }
  throw new Error('未知操作');
}

/** 仅将已开发的需求累积进提交；待执行的计划不代表代码改动。 */
export const pendingCommitItems = (p: Project) => p.items.filter((i) =>
  ['pending_verification', 'archived'].includes(i.status) && (i.gitCommittedVersion || 0) < i.version);
export const buildCommitMessage = (items: Item[]) => items.length
  ? items.map((i) => (i.type === 'bug' ? 'bugfix' : i.type === 'improvement' ? 'update' : 'feat') + ': ' + i.number + ' ' + (i.title || i.body.replace(/\s+/g, ' ').slice(0, 60))).join('\n')
  : '';

export function compareArchivedItems(a: Item, b: Item) {
  const time = (i: Item) => {
    const h = i.history.find((h) => h.event === '归档') || i.history[0];
    return Date.parse(h?.time || '') || 0;
  };
  return time(b) - time(a) || b.number.localeCompare(a.number, undefined, { numeric: true });
}

// 守则是关联上下文的投影，不能由用户直接编辑。
// 只保留上下文与功能的简短联系，并按项目设置的字数上限截断，避免把完整架构带进排期 Prompt。
export const contextRulesLimit = (p: Project) =>
  Number.isSafeInteger(p.contextRulesLimit) && p.contextRulesLimit! >= MIN_CONTEXT_RULES_LIMIT && p.contextRulesLimit! <= MAX_CONTEXT_RULES_LIMIT
    ? p.contextRulesLimit!
    : DEFAULT_CONTEXT_RULES_LIMIT;

function truncateContextText(text: string, limit: number): string {
  if (limit <= 0) return '';
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit - 1).join('') + '…';
}

export function refreshContextRules(s: Workspace) {
  for (const project of s.projects || []) {
    const linked = (s.contextPrompts || []).filter(c => c.projectId === project.id && c.feature);
    if (project.contextRulesDisabled || !linked.length) { delete project.contextRules; continue; }
    const limit = contextRulesLimit(project);
    const header = '# ' + project.name + ' · 项目守则';
    const sections = ['ReqFlow.exe --cli context list', header];
    for (const c of linked) {
      const line = '- ' + c.feature + ' → ' + c.title + '（' + c.id + '）';
      if (Array.from(sections.join('\n') + '\n' + line).length <= limit) sections.push(line);
    }
    const lookup = '按需用 context show --id <ID> 获取 summary.md 与 files/。';
    if (Array.from(sections.join('\n') + '\n' + lookup).length <= limit) sections.push(lookup);
    project.contextRules = truncateContextText(sections.join('\n'), limit);
  }
}

export const DEFAULT_CORE_PROMPT_TEMPLATE = '使用 ReqFlow Agent 执行当前项目需求。仅领取并执行以下 {{requirement_count}} 条需求：{{requirement_ids}}，其他需求不属于本轮。完成后通过 ReqFlow Agent 回写待验证，保留人工验收。\n\n# 项目：{{project_name}}\n\n## 项目上下文\n{{project_description}}\n\n## 引导词 · v{{guidance_version}} - 请开发过程中严格执行引导词中的要求。\n{{guidance}}{{context_rules}}\n\n## 本轮目标\n实现以下需求，按列出的顺序执行。\n\n{{requirements}}{{delivery_guidance}}';
