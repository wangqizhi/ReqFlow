import { build } from 'esbuild';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const temp = await mkdtemp(path.join(tmpdir(), 'reqflow-sqlite-'));
try {
  const entry = path.join(temp, 'entry.ts');
  await writeFile(entry, `export { WorkspaceStore } from ${JSON.stringify(path.resolve('src/core/storage.ts'))}; export { WorkspaceService } from ${JSON.stringify(path.resolve('src/core/service.ts'))}; export { projectConcurrencyToken } from ${JSON.stringify(path.resolve('src/core/domain.ts'))};`);
  const bundle = path.join(temp, 'bundle.mjs');
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { WorkspaceStore, WorkspaceService, projectConcurrencyToken } = await import(pathToFileURL(bundle).href);
  const file = path.join(temp, 'workspace.json');
  const store = new WorkspaceStore(file), service = new WorkspaceService(store);
  let result = await service.get();
  assert.equal(store.backend, 'sqlite', 'new workspaces default to SQLite');
  const first = result.state.projects[0].id;
  result = await service.mutate({ op: 'item', project: first, body: 'migration requirement' }, null);
  const item = result.state.projects[0].items[0];
  result = await service.mutate({ op: 'generate', project: first, ids: [item.id] }, null);
  const signature = await projectConcurrencyToken(result.state.projects[0]);
  const reordered = Object.fromEntries(Object.entries(result.state.projects[0]).reverse());
  assert.equal(await projectConcurrencyToken(reordered), signature, 'object field order is not a user edit');
  const edited = structuredClone(result.state.projects[0]);
  edited.items[0].body += ' actual edit';
  assert.notEqual(await projectConcurrencyToken(edited), signature, 'real content edits still change the concurrency signature');
  assert.equal(await projectConcurrencyToken((await service.get()).state.projects[0]), signature, 'SQLite round trip preserves concurrency signature after generating a batch');
  result = await service.mutate({ op: 'submit', project: first, batch: result.state.projects[0].batches[0].id, expectedProjectVersions: { [first]: result.state.projects[0].revision }, expectedProjectSignatures: { [first]: signature } }, result.version);
  assert.equal(result.state.projects[0].items[0].status, 'in_progress');
  result = await service.mutate({ op: 'project', name: 'second project' }, null);
  const second = result.state.projects[1].id;
  const original = await store.read();
  await writeFile(file, JSON.stringify(original));
  await rm(store.databasePath);
  assert.equal(store.backend, 'json');
  assert.equal((await store.migrateToSqlite()).migrated, true);
  assert.deepEqual(await store.read(), original, 'migration preserves requirements and batch snapshots');
  assert.equal((await store.migrateToSqlite()).migrated, false, 'migration is idempotent');
  const backup = (await readdir(temp)).find(f => f.includes('.pre-sqlite-'));
  assert.deepEqual(JSON.parse(await readFile(path.join(temp, backup), 'utf8')), original);
  const database = new DatabaseSync(store.databasePath);
  assert.equal(database.prepare('SELECT count(*) AS count FROM requirements').get().count, 2);
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  database.close();
  const other = new WorkspaceService(new WorkspaceStore(file));
  await Promise.all([
    service.mutate({ op: 'item', project: first, body: 'concurrent first', expectedProjectVersions: { [first]: result.state.projects[0].revision } }, result.version),
    other.mutate({ op: 'item', project: second, body: 'concurrent second', expectedProjectVersions: { [second]: result.state.projects[1].revision } }, result.version)
  ]);
  const latest = await other.get();
  assert.equal(latest.state.projects[0].items.length, 2);
  assert.equal(latest.state.projects[1].items.length, 1);
  await assert.rejects(service.mutate({ op: 'item', project: first, body: 'stale', expectedProjectVersions: { [first]: result.state.projects[0].revision } }, result.version), /数据已被/);
  await service.importWorkspace(original.data, true);
  assert.equal((await other.get()).state.projects[0].items.length, 1);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original, 'legacy source is preserved');
  await mkdir(path.join(temp, 'broken'));
  const broken = new WorkspaceStore(path.join(temp, 'broken', 'workspace.json'));
  await writeFile(broken.filePath, '{broken');
  await assert.rejects(broken.migrateToSqlite(), /损坏/);
  assert.equal(broken.backend, 'json', 'failed migration does not activate a database');
  console.log('PASS: SQLite defaults, lossless migration, backup, row storage, integrity, concurrent projects, stale conflicts, import and failed migration.');
} finally {
  assert.ok(path.resolve(temp).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(temp, { recursive: true, force: true });
}
