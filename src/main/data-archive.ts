// 数据用量统计与数据归档（REQ-112）：设置里展示数据目录与 SQLite/工作区文件大小；
// 归档 = 把归档时间早于所选日期的已归档需求（含历史）与已无在途引用的批次
// 导出到 JSON 文件，再从工作区清理，界面实时刷新大小以展示清理效果。
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeWorkspace, type Item, type Workspace } from '../core/domain';
import { LOCAL_USER_ID, type WorkspaceRecord, type WorkspaceStore } from '../core/storage';

const ARCHIVE_FORMAT = 'reqflow-archive-v1';

type Usage = { dataDir: string; backend: string; dirSize: number; databasePath: string; databaseSize: number };
type ArchiveProject = { id: string; name: string; items: Item[] };
type ArchiveBatch = { projectId: string; projectName: string; batch: any };

export function registerDataArchive(store: WorkspaceStore, dataDir: string) {
  async function directorySize(root: string): Promise<number> {
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(root, { withFileTypes: true }); }
    catch { return 0; }
    let total = 0;
    for (const entry of entries) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) total += await directorySize(file);
      else { try { total += (await fs.stat(file)).size; } catch { /* 并发变动时忽略 */ } }
    }
    return total;
  }

  async function usage(): Promise<Usage> {
    const backend = store.backend;
    const databasePath = backend === 'sqlite' ? store.databasePath : store.filePath;
    const [dirSize, databaseSize] = await Promise.all([
      directorySize(dataDir),
      fs.stat(databasePath).then((s) => s.size).catch(() => 0)
    ]);
    return { dataDir, backend, dirSize, databasePath, databaseSize };
  }

  ipcMain.handle('data:usage', async () => {
    try { return { ok: true, ...(await usage()) }; }
    catch (e: any) { return { ok: false, error: e?.message || '统计数据大小失败' }; }
  });

  /** 日期输入（YYYY-MM-DD，本地时区）→ 该日 0 点的时间戳，严格早于该时间点的数据才归档。 */
  function parseCutoff(date: unknown): number {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00')))
      throw Error('请选择有效的归档日期');
    return new Date(date + 'T00:00:00').getTime();
  }

  const archiveTime = (item: Item): number => {
    const time = item.history.find((h) => h.event === '归档')?.time;
    const parsed = Date.parse(time || '');
    return Number.isFinite(parsed) ? parsed : 0;
  };

  /** 收集指定时间点以前的归档数据：已归档需求 + 时间点以前且所有条目均已归档/不在工作区的批次（不再被排期与回写引用）。 */
  async function collect(cutoffMs: number): Promise<{ record: WorkspaceRecord; state: Workspace; projects: ArchiveProject[]; batches: ArchiveBatch[] }> {
    const record = await store.read();
    if (!record) throw Error('请先初始化工作区');
    const state = normalizeWorkspace(record.data);
    const projects: ArchiveProject[] = [];
    for (const project of state.projects) {
      const items = project.items.filter((i) => i.status === 'archived' && archiveTime(i) < cutoffMs);
      if (items.length) projects.push({ id: project.id, name: project.name, items });
    }
    const batches: ArchiveBatch[] = [];
    for (const project of state.projects) {
      for (const batch of project.batches) {
        if (Number.isFinite(Date.parse(batch.time)) && Date.parse(batch.time) >= cutoffMs) continue;
        const inFlight = batch.items.some((s: any) => {
          const live = project.items.find((i) => i.id === s.id);
          // 在途引用：需求仍存在且未归档（排期、继续排期、完成回写都要用批次快照）
          return !!live && live.status !== 'archived';
        });
        if (!inFlight) batches.push({ projectId: project.id, projectName: project.name, batch });
      }
    }
    return { record, state, projects, batches };
  }

  ipcMain.handle('data:archivePreview', async (_e, date: unknown) => {
    try {
      const cutoffMs = parseCutoff(date);
      const { projects, batches } = await collect(cutoffMs);
      return { ok: true, items: projects.reduce((n, p) => n + p.items.length, 0), batches: batches.length };
    } catch (e: any) { return { ok: false, error: e?.message || '统计归档数据失败' }; }
  });

  for (const channel of ['data:archive', 'data:archiveExport', 'data:archiveClear']) ipcMain.handle(channel, async (_e, date: unknown) => {
    try {
      const cutoffMs = parseCutoff(date);
      const { record, state, projects, batches } = await collect(cutoffMs);
      const items = projects.reduce((n, p) => n + p.items.length, 0);
      if (!items && !batches.length) return { ok: true, items: 0, batches: 0, file: '', ...(await usage()) };
      let file = '';
      if (channel !== 'data:archiveClear') {
      const win = BrowserWindow.getAllWindows()[0];
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const options: Electron.SaveDialogOptions = {
        title: '保存数据归档',
        defaultPath: path.join(dataDir, `reqflow-archive-${stamp}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      };
      const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true, items, batches };
      file = picked.filePath;
      const payload = {
        format: ARCHIVE_FORMAT,
        createdAt: new Date().toISOString(),
        before: new Date(cutoffMs).toISOString(),
        projects,
        batches
      };
      await fs.mkdir(path.dirname(file), { recursive: true });
      // 与工作区存储一致：临时文件 + rename 原子替换
      const temporary = file + '.reqflow-tmp';
      await fs.writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8');
      await fs.rename(temporary, file);
      }
      if (channel === 'data:archiveExport') return { ok: true, items, batches, file, ...(await usage()) };
      // 从工作区移除已导出的需求与批次；经 store 写入通道拿写锁并校验版本，
      // 与 GUI/CLI 并发写入冲突时整体失败，不产生半清理状态
      const removedBatches = new Set(batches.map((b) => b.batch.id));
      for (const project of state.projects) {
        const before = JSON.stringify(project);
        project.items = project.items.filter((i) => i.status !== 'archived' || archiveTime(i) >= cutoffMs);
        project.batches = project.batches.filter((b) => !removedBatches.has(b.id));
        if (JSON.stringify(project) !== before) project.revision = (project.revision || 0) + 1;
      }
      await store.write({ id: LOCAL_USER_ID, data: state, version: record.version }, record.version);
      return { ok: true, items, batches, file, ...(await usage()) };
    } catch (e: any) { return { ok: false, error: e?.message || '数据归档失败' }; }
  });
}
