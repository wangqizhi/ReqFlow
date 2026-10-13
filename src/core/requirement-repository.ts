import { DatabaseSync } from 'node:sqlite';
import type { WorkspaceRecord } from './storage';

// Future server databases implement this boundary without changing GUI/CLI services.
export interface RequirementRepository {
  read(): WorkspaceRecord | null | Promise<WorkspaceRecord | null>;
  write(record: WorkspaceRecord): void | Promise<void>;
  close(): void | Promise<void>;
}

export class SqliteRequirementRepository implements RequirementRepository {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=15000;
      CREATE TABLE IF NOT EXISTS workspace (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requirements (project_id TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project_id, scope, id));
      CREATE INDEX IF NOT EXISTS requirements_project ON requirements(project_id, scope, position);`);
  }
  read(): WorkspaceRecord | null {
    this.db.exec('BEGIN');
    try { return this.readSnapshot(); }
    finally { this.db.exec('COMMIT'); }
  }
  private readSnapshot(): WorkspaceRecord | null {
    const row = this.db.prepare('SELECT value FROM workspace WHERE key=?').get('record') as { value: string } | undefined;
    if (!row) return null;
    const record = JSON.parse(row.value);
    record.data.projects = this.db.prepare('SELECT id, data FROM projects ORDER BY position').all().map(row => {
      const project = JSON.parse(String(row.data));
      const items = this.db.prepare('SELECT scope, data FROM requirements WHERE project_id=? ORDER BY position').all(String(row.id));
      project.items = items.filter(i => i.scope === '').map(i => JSON.parse(String(i.data)));
      for (const batch of project.batches) batch.items = items.filter(i => i.scope === batch.id).map(i => JSON.parse(String(i.data)));
      return project;
    });
    return record;
  }
  write(record: WorkspaceRecord) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const projectWrite = this.db.prepare('INSERT INTO projects VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET position=excluded.position, data=excluded.data WHERE position<>excluded.position OR data<>excluded.data');
      const itemWrite = this.db.prepare('INSERT INTO requirements VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, scope, id) DO UPDATE SET position=excluded.position, data=excluded.data WHERE position<>excluded.position OR data<>excluded.data');
      const retained = new Set<string>();
      record.data.projects.forEach((project: any, position: number) => {
        const { items, batches, ...config } = project;
        projectWrite.run(project.id, position, JSON.stringify({ ...config, batches: batches.map(({ items: _items, ...batch }: any) => batch) }));
        for (const [scope, values] of [['', items], ...batches.map((b: any) => [b.id, b.items])]) {
          values.forEach((item: any, index: number) => {
            retained.add(JSON.stringify([project.id, scope, item.id]));
            itemWrite.run(project.id, scope, item.id, index, JSON.stringify(item));
          });
        }
      });
      for (const row of this.db.prepare('SELECT project_id, scope, id FROM requirements').all()) {
        if (!retained.has(JSON.stringify([row.project_id, row.scope, row.id]))) this.db.prepare('DELETE FROM requirements WHERE project_id=? AND scope=? AND id=?').run(row.project_id, row.scope, row.id);
      }
      for (const row of this.db.prepare('SELECT id FROM projects').all()) {
        if (!record.data.projects.some((p: any) => p.id === row.id)) this.db.prepare('DELETE FROM projects WHERE id=?').run(row.id);
      }
      const { projects: _projects, ...data } = record.data;
      this.db.prepare('INSERT INTO workspace VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('record', JSON.stringify({ ...record, data }));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
