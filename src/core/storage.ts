// One compatible workspace.json; optimistic revisions plus a short cross-process commit lock.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export type WorkspaceRecord = { id: string; version: number; data: any };
export const LOCAL_USER_ID = 'local_electron';
export class VersionConflictError extends Error {
  code = 'VERSION_CONFLICT';
  constructor() { super('数据已被其他方式修改（可能是另一个窗口或 CLI）。请保留当前输入，刷新数据后重试。'); }
}
export class WorkspaceStore {
  constructor(private file: string) {}
  get filePath() { return this.file; }
  async ensureDir() { await fs.mkdir(path.dirname(this.file), { recursive: true }); }
  async read(): Promise<WorkspaceRecord | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Number.isSafeInteger(parsed?.version) || !Array.isArray(parsed?.data?.projects)) throw Error('invalid workspace');
      return parsed;
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw Error('工作区数据文件损坏：' + this.file);
    }
  }
  private async commit<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDir();
    const lock = this.file + '.lock', started = Date.now();
    while (true) {
      try {
        await fs.mkdir(lock);
        try { await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid })); }
        catch (e) { await fs.rm(lock, { recursive: true, force: true }); throw e; }
        break;
      } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        // Do not steal a lock: a paused/slow process may still be committing.
        if (Date.now() - started > 15000) throw Error('工作区写入锁等待超时，请稍后重试；若进程异常退出，请确认所有 ReqFlow/CLI 已停止后检查 workspace.json.lock。未覆盖当前输入');
        await new Promise(resolve => setTimeout(resolve, 15 + Math.random() * 20));
      }
    }
    try { return await operation(); }
    finally { await fs.rm(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); }
  }
  private async replace(record: WorkspaceRecord) {
    const tmp = this.file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(tmp, JSON.stringify(record), 'utf8');
      // Windows scanners/readers can briefly deny replacement. Never delete the original.
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(tmp, this.file); break; }
        catch (e: any) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 49) throw e;
          await new Promise(resolve => setTimeout(resolve, 20 + Math.random() * 20));
        }
      }
    }
    finally { await fs.rm(tmp, { force: true }); }
    return record;
  }
  async write(record: WorkspaceRecord, expectVersion: number | null): Promise<WorkspaceRecord> {
    return this.commit(async () => {
      const current = await this.read();
      if (expectVersion !== null && (!current || current.version !== expectVersion)) throw new VersionConflictError();
      return this.replace({ ...record, version: (current?.version ?? -1) + 1 });
    });
  }
  async initialize(data: any): Promise<WorkspaceRecord> {
    return this.commit(async () => (await this.read()) || this.replace({ id: LOCAL_USER_ID, version: Date.now(), data }));
  }
  async overwrite(data: any): Promise<WorkspaceRecord> {
    return this.commit(async () => {
      const current = await this.read();
      // Replacing a workspace invalidates every imported project's prior optimistic token.
      const replacement = structuredClone(data);
      for (const project of replacement.projects) {
        const prior = current?.data.projects.find((p: any) => p.id === project.id)?.revision || 0;
        project.revision = Math.max(Date.now(), current?.version || 0, prior, Number.isSafeInteger(project.revision) ? project.revision : 0) + 1;
      }
      return this.replace({ id: LOCAL_USER_ID, version: Math.max(Date.now(), (current?.version || 0) + 1), data: replacement });
    });
  }
}
