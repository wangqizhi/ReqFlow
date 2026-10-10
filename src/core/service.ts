import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
// 工作区服务 —— GUI(IPC) 与 CLI 共用的业务入口。
// 对应线上 app/api/workspace/route.ts 的 GET / POST 语义。

import { apply, makeProject, normalizeWorkspace, mutationProjectIds, projectConcurrencyToken, type Workspace } from './domain';
import { LOCAL_USER_ID, VersionConflictError, WorkspaceStore } from './storage';

export class WorkspaceService {
  constructor(private store: WorkspaceStore) {}

  private async materializeImages(state: Workspace) {
    const dir = path.join(path.dirname(this.store.filePath), 'images');
    for (const p of state.projects) for (const i of [...p.items, ...p.batches.flatMap((b) => b.items)]) for (const a of i.attachments || []) {
      const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+=*)$/.exec(a.dataUrl);
      if (!match || !/^[a-zA-Z0-9-]+$/.test(a.id)) throw new Error('图片附件数据无效');
      await fs.mkdir(dir, { recursive: true });
      const bytes = Buffer.from(match[2], 'base64');
      a.path = path.join(dir, a.id + '-' + createHash('sha256').update(bytes).digest('hex').slice(0, 16) + '.' + match[1]);
      try { await fs.access(a.path); } catch { await fs.writeFile(a.path, bytes); }
    }
  }

  /** 读取（必要时初始化默认项目）。对应线上 GET /api/workspace。 */
  async get(): Promise<{ state: Workspace; version: number }> {
    let record = await this.store.read();
    if (!record) {
      record = await this.store.initialize({ projects: [makeProject('我的第一个项目')] });
    }
    await this.materializeImages(record.data);
    return { state: normalizeWorkspace(record.data), version: record.version };
  }

  /**
   * 应用一次操作。expectedVersion 为调用方已见版本（GUI 传入）；
   * CLI 场景传 null 表示「以当前版本为准」，并在冲突时自动重试。
   */
  async mutate(action: any, expectedVersion: number | null): Promise<{ state: Workspace; version: number }> {
    const scopes = mutationProjectIds(action);
    const revisions = action.expectedProjectVersions;
    if (revisions !== undefined && (!scopes || !revisions || typeof revisions !== 'object' || Array.isArray(revisions)
      || scopes.some(id => !Number.isSafeInteger(revisions[id]) || revisions[id] < 0)
      || Object.keys(revisions).some(id => !scopes.includes(id)))) throw Error('项目并发版本参数无效');
    const signatures = action.expectedProjectSignatures;
    if (signatures !== undefined && (revisions === undefined || !signatures || typeof signatures !== 'object' || Array.isArray(signatures)
      || scopes!.some(id => typeof signatures[id] !== 'string' || !/^[a-f0-9]{64}$/.test(signatures[id]))
      || Object.keys(signatures).some(id => !scopes!.includes(id)))) throw Error('项目内容校验参数无效');
    const attempts = expectedVersion === null || revisions !== undefined ? 12 : 1;
    let lastError: unknown;
    for (let n = 0; n < attempts; n++) {
      const record = await this.store.read();
      if (!record) {
        await this.get(); // 初始化后重读
        continue;
      }
      const state = normalizeWorkspace(record.data);
      if (revisions !== undefined) {
        if (scopes!.some(id => state.projects.find(p => p.id === id)?.revision !== revisions[id])) throw new VersionConflictError();
        if (signatures !== undefined) {
          const tokens = await Promise.all(scopes!.map(id => projectConcurrencyToken(state.projects.find(p => p.id === id)!)));
          if (scopes!.some((id, index) => signatures[id] !== tokens[index])) throw new VersionConflictError();
        }
      } else if (expectedVersion !== null && expectedVersion !== record.version) throw new VersionConflictError();
      try {
        await this.materializeImages(state);
        await apply(state, action);
        await this.materializeImages(state);
      } catch (e) {
        throw e; // 业务校验错误直接抛出（对应线上 400）
      }
      try {
        const expect = record.version;
        const next = await this.store.write({ id: LOCAL_USER_ID, data: state, version: record.version }, expect);
        return { state: normalizeWorkspace(next.data), version: next.version };
      } catch (e) {
        if (e instanceof VersionConflictError) {
          lastError = e;
          await new Promise(resolve => setTimeout(resolve, 5 + Math.random() * 15));
          continue; // Project-scoped callers can rebase only if all touched revisions still match.
        }
        throw e;
      }
    }
    throw lastError instanceof Error ? lastError : new VersionConflictError();
  }

  /** 导入完整工作区 JSON（来自页面「导出全部数据」或 workspace export）。 */
  async importWorkspace(data: any, replace: boolean): Promise<{ projects: number; replaced: boolean }> {
    if (data?.format === 'reqflow-backup-v1') data = data.workspace;
    if (!Array.isArray(data?.projects) || data.projects.some((p: any) =>
      typeof p?.id !== 'string' || typeof p?.name !== 'string' || !Array.isArray(p?.items) || !Array.isArray(p?.batches)
    )) {
      throw new Error('请使用 ReqFlow 导出的完整工作区 JSON。');
    }
    const current = await this.store.read();
    if (current && !replace) {
      const state = normalizeWorkspace(current.data);
      if (state.projects.length > 0) throw new Error('当前已有工作区数据；如需覆盖请使用 --replace。');
    }
    await this.materializeImages(data);
    await this.store.overwrite(data);
    return { projects: data.projects.length, replaced: !!current };
  }
}
