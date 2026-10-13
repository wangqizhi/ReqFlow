// Shared JSON/SQLite workspace facade with optimistic revisions and a commit lock.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { SqliteRequirementRepository, type RequirementRepository } from './requirement-repository';
export type WorkspaceRecord = { id: string; version: number; data: any };
export const LOCAL_USER_ID = 'local_electron';
export class VersionConflictError extends Error {
  code = 'VERSION_CONFLICT';
  constructor() { super('数据已被其他方式修改（可能是另一个窗口或 CLI）。请保留当前输入，刷新数据后重试。'); }
}
export class WorkspaceStore {
  constructor(private file: string, private repositoryFactory: (file: string) => RequirementRepository = file => new SqliteRequirementRepository(file)) {}
  get filePath() { return this.file; }
  get databasePath() { return path.join(path.dirname(this.file), 'requirements.sqlite'); }
  get backend() { return existsSync(this.databasePath) ? 'sqlite' : 'json'; }
  async migrateToSqlite() {
    return this.commit(async () => {
      if (this.backend === 'sqlite') return { backend: 'sqlite', migrated: false };
      const record = await this.read();
      if (!record) throw Error('请先初始化工作区');
      const temp = this.databasePath + '.' + randomUUID() + '.tmp';
      try {
        const repository = new SqliteRequirementRepository(temp);
        try {
          repository.write(record);
          if (JSON.stringify(repository.read()) !== JSON.stringify(record)) {
            // Object property order can differ after reconstructing normalized rows.
            const { isDeepStrictEqual } = await import('node:util');
            if (!isDeepStrictEqual(repository.read(), record)) throw Error('数据库迁移校验失败');
          }
        } finally { repository.close(); }
        await fs.copyFile(this.file, this.file + '.pre-sqlite-' + Date.now() + '.bak');
        await fs.rename(temp, this.databasePath);
        return { backend: 'sqlite', migrated: true };
      } finally { await fs.rm(temp, { force: true }); }
    });
  }
  async ensureDir() { await fs.mkdir(path.dirname(this.file), { recursive: true }); }
  async read(): Promise<WorkspaceRecord | null> {
    if (this.backend === 'sqlite') {
      const repository = this.repositoryFactory(this.databasePath);
      try {
        const record = await repository.read();
        if (!record) throw Error('SQLite 工作区数据缺失');
        return record;
      } finally { await repository.close(); }
    }
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
    if (this.backend === 'sqlite') {
      const repository = this.repositoryFactory(this.databasePath);
      try { await repository.write(record); return record; }
      finally { await repository.close(); }
    }
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
    return this.commit(async () => {
      const current = await this.read();
      if (current) return current;
      return this.createDatabase({ id: LOCAL_USER_ID, version: Date.now(), data });
    });
  }
  private async createDatabase(record: WorkspaceRecord) {
    const temp = this.databasePath + '.' + randomUUID() + '.tmp';
    try {
      const repository = new SqliteRequirementRepository(temp);
      try { repository.write(record); } finally { repository.close(); }
      await fs.rename(temp, this.databasePath);
      return record;
    } finally { await fs.rm(temp, { force: true }); }
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
      const record = { id: LOCAL_USER_ID, version: Math.max(Date.now(), (current?.version || 0) + 1), data: replacement };
      return current ? this.replace(record) : this.createDatabase(record);
    });
  }
}
