// ReqFlow 领域核心 —— 移植自线上源码 lib/domain.ts（提交 3892f74）。
// 纯 TypeScript、无平台依赖，GUI(IPC) 与 CLI 共用同一套规则。

import { validateRemote, type RemoteSettings } from './remote';
import { localDate, validateDate } from './dates';
export type Attachment = { id: string; label: string; name: string; dataUrl: string; path?: string };

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
  aiValidation?: boolean;
  deliveryGuidance?: string;
  link?: string;
  attachments?: Attachment[];
  gitCommittedVersion?: number;
  gitCommitHash?: string;
  executionVersion?: number;
  scheduledDate?: string;
  archived?: boolean;
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
  dir?: string; // 关联的本地项目目录（「浏览项目」查看/编辑项目文件用）
  remote?: RemoteSettings;
  folderId?: string;
  revision?: number;
};

export type Workspace = { projects: Project[]; folders?: { id: string; name: string }[] };

export const DEFAULT_DELIVERY = '说明改动、测试命令和结果、未解决的问题。';
export const DEFAULT_GUIDANCE =
  '请结合项目背景实现需求，遵循现有技术栈与代码规范。完成后说明改动、运行方式、验证结果与剩余问题。';

export function requirementSettings(p: Project, i: Item) {
  const aiValidation = i.aiValidation ?? p.aiValidation;
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
  const validationNums = items.filter((_, n) => settings[n].aiValidation).map((i) => i.number);
  if (validationNums.length)
    tail.push(
      'AI 测试验证（仅适用于 ' +
        validationNums.join('、') +
        '）：\n完成对应需求后执行适合本次改动的检查或测试，并如实说明结果；无法执行时说明原因。'
    );
  const deliveryGroups: { text: string; nums: string[] }[] = [];
  items.forEach((i, n) => {
    const text = settings[n].deliveryGuidance;
    const g = deliveryGroups.find((g) => g.text === text);
    if (g) g.nums.push(i.number);
    else deliveryGroups.push({ text, nums: [i.number] });
  });
  for (const g of deliveryGroups)
    tail.push('交付引导（' + (deliveryGroups.length === 1 ? '本轮全部需求' : g.nums.join('、')) + '）：\n' + g.text);
  return (
    '# 项目：' +
    p.name +
    '\n\n## 项目上下文\n' +
    p.description +
    '\n\n## 引导词 · v' +
    p.guideVersion +
    '\n' +
    guidance +
    '\n\n## 本轮目标\n实现以下需求，按列出的顺序执行。\n\n' +
    sections +
    (tail.length ? '\n\n' + tail.join('\n\n') : '')
  );
}

export function normalizeWorkspace(s: Workspace) {
  if (!Array.isArray(s.folders)) s.folders = [];
  if (!s.folders.some((f) => f.id === 'default')) s.folders.unshift({ id: 'default', name: 'default' });
  for (const p of s.projects) {
    if (!Number.isSafeInteger(p.revision) || p.revision! < 0) p.revision = 0;
    if (!s.folders.some((f) => f.id === p.folderId)) p.folderId = 'default';
    if (typeof p.deliveryGuidance !== 'string') p.deliveryGuidance = DEFAULT_DELIVERY;
    if (typeof p.aiValidation !== 'boolean') p.aiValidation = false;
    if (typeof p.dir !== 'string' || !p.dir.trim()) p.dir = undefined;
    for (const i of p.items) {
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
 * project / deleteProject / projectDir / guidance / item / moveItem / deleteItem / generate / submit / cancel / complete / revert / verify / regress / archive
 *（ready 为历史接口，保留兼容。）
 */
export async function projectConcurrencyToken(p: Project): Promise<string> {
  // Materialized attachment paths are derived, not user edits. Content tokens also
  // detect older writers which preserve (but do not increment) project.revision.
  return sha256Hex(JSON.stringify({ ...p, revision: undefined }, (key, value) => key === 'path' ? undefined : value));
}
export function mutationProjectIds(a: any): string[] | null {
  const localOps = ['deleteProject', 'projectFolder', 'projectDescription', 'projectRemote', 'projectDir', 'guidance', 'item', 'aiItems', 'deleteItem', 'moveItem', 'generate', 'submit', 'cancel', 'complete', 'revert', 'verify', 'regress', 'archive', 'gitCommitted'];
  if (!localOps.includes(a?.op) || typeof a.project !== 'string') return null;
  return [...new Set(a.op === 'moveItem' ? [a.project, a.targetProject] : [a.project])];
}
export async function apply(s: Workspace, a: any) {
  normalizeWorkspace(s);
  const before = new Map(s.projects.map(p => [p.id, { json: JSON.stringify(p), revision: p.revision || 0 }]));
  await applyOperation(s, a);
  for (const p of s.projects) {
    const old = before.get(p.id);
    if (!old || JSON.stringify(p) !== old.json) p.revision = (old?.revision || 0) + 1;
  }
}
async function applyOperation(s: Workspace, a: any) {
  normalizeWorkspace(s);

  if (a.op === 'folder') {
    const name = needed(a.name, '文件夹名称');
    if (s.folders!.some((f) => f.name === name)) throw Error('文件夹名称已存在');
    s.folders!.push({ id: crypto.randomUUID(), name });
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

  const p = s.projects.find((p) => p.id === a.project);
  if (!p) throw new Error('项目不存在');

  if (a.op === 'projectFolder') {
    if (!s.folders!.some((f) => f.id === a.folderId)) throw Error('文件夹不存在');
    p.folderId = a.folderId;
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

  if (a.op === 'projectDescription') {
    p.description = String(a.description || '');
    p.guideVersion++;
    return;
  }
  if (a.op === 'projectRemote') {
    p.remote = validateRemote(a.remote);
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
    if (a.aiValidation !== undefined && typeof a.aiValidation !== 'boolean')
      throw new Error('AI 验证设置无效');
    p.guideHistory.unshift({
      version: p.guideVersion,
      text: p.guidance,
      deliveryGuidance: p.deliveryGuidance,
      aiValidation: p.aiValidation,
      time: now
    });
    p.guidance = text;
    // 继续使用原默认交付引导的未完成需求随项目设置更新；独立定制的文案保留。
    for (const item of p.items) {
      if (['ready', 'in_progress'].includes(item.status) &&
          (item.deliveryGuidance === undefined || item.deliveryGuidance === p.deliveryGuidance ||
            (!p.aiValidation && p.deliveryGuidance === DEFAULT_DELIVERY && item.deliveryGuidance === '说明改动、未解决的问题。'))) {
        if (delivery !== p.deliveryGuidance) {
          item.deliveryGuidance = delivery;
          item.version++;
        }
      }
    }
    p.deliveryGuidance = delivery;
    p.aiValidation = a.aiValidation === undefined ? p.aiValidation : a.aiValidation;
    p.guideVersion++;
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
    const scheduledDate = a.scheduledDate === undefined ? (existing?.scheduledDate ?? (existing ? undefined : localDate())) : validateDate(a.scheduledDate);
    const title = a.title === undefined ? (existing?.title ?? '') : String(a.title).trim();
    const body = a.body === undefined ? (existing?.body ?? '') : String(a.body);
    const type = a.type ?? existing?.type ?? 'feature';
    const priority = a.priority ?? existing?.priority ?? 'P1';
    const aiValidation = a.aiValidation ?? existing?.aiValidation ?? p.aiValidation;
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
        status: 'ready',
        scheduledDate,
        version: i.version + 1
      });
    } else {
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
    if (i.status !== 'in_progress') throw new Error('需求不在执行中');
    i.status = 'pending_verification';
    i.link = String(a.link || '');
    i.history.unshift({ event: '实现完成', time: now, link: i.link, note: String(a.note || '') });
    return;
  }
  if (a.op === 'revert') {
    // 单条退回待执行：不必取消整个批次，退回后即可编辑；同批次其他需求不受影响
    if (i.status !== 'in_progress') throw new Error('需求不在执行中');
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
