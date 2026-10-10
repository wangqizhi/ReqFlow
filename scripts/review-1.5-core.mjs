import { build } from 'esbuild';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
const dir = await mkdtemp(path.join(os.tmpdir(), 'reqflow-1.5-core-'));
try {
  const entry = path.join(dir, 'entry.ts'), bundle = path.join(dir, 'bundle.mjs');
  await writeFile(entry, `export * from ${JSON.stringify(path.resolve('src/core/service.ts'))}; export * from ${JSON.stringify(path.resolve('src/core/storage.ts'))}; export * from ${JSON.stringify(path.resolve('src/core/dates.ts'))}; export {projectConcurrencyToken} from ${JSON.stringify(path.resolve('src/core/domain.ts'))};`);
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { WorkspaceService, WorkspaceStore, projectConcurrencyToken, localDate, validateDate, matchesSchedule } = await import(pathToFileURL(bundle));
  const file = path.join(dir, 'workspace.json');
  const service = new WorkspaceService(new WorkspaceStore(file));
  const initial = await Promise.all(Array.from({ length: 6 }, () => new WorkspaceService(new WorkspaceStore(file)).get()));
  assert.equal(new Set(initial.map(r => r.state.projects[0].id)).size, 1, 'concurrent initialization preserves one default project');
  let r = await service.get(); const A = r.state.projects[0].id;
  r = await service.mutate({ op: 'project', name: 'B' }, null); const B = r.state.projects.at(-1).id;
  const original = r;
  await service.mutate({ op: 'item', project: A, body: 'agent A' }, null);
  r = await service.mutate({ op: 'item', project: B, body: 'stale global / unchanged B', expectedProjectVersions: { [B]: original.state.projects.find(p => p.id === B).revision } }, original.version);
  assert.equal(r.state.projects.find(p => p.id === A).items.length, 1);
  assert.equal(r.state.projects.find(p => p.id === B).items.length, 1);
  await assert.rejects(service.mutate({ op: 'item', project: A, body: 'stale A', expectedProjectVersions: { [A]: original.state.projects.find(p => p.id === A).revision } }, original.version), { code: 'VERSION_CONFLICT' });
  await assert.rejects(service.mutate({ op: 'folder', name: 'global stale' }, original.version), { code: 'VERSION_CONFLICT' });
  const beforeMove = r;
  await service.mutate({ op: 'projectDescription', project: B, description: 'changed destination' }, null);
  await assert.rejects(service.mutate({ op: 'moveItem', project: A, targetProject: B, id: beforeMove.state.projects.find(p => p.id === A).items[0].id, expectedProjectVersions: Object.fromEntries(beforeMove.state.projects.map(p => [p.id, p.revision])) }, beforeMove.version), { code: 'VERSION_CONFLICT' });
  // Every imported project gets a fresh token, even if its imported revision was old.
  const stale = await service.get(), staleB = stale.state.projects.find(p => p.id === B);
  const token = await projectConcurrencyToken(staleB);
  const legacyStore = new WorkspaceStore(file), legacy = await legacyStore.read();
  legacy.data.projects.find(p => p.id === B).description = 'simulated older writer without revision increment';
  await legacyStore.write(legacy, legacy.version);
  await assert.rejects(service.mutate({ op: 'projectDescription', project: B, description: 'stale overwrite', expectedProjectVersions: { [B]: staleB.revision }, expectedProjectSignatures: { [B]: token } }, stale.version), { code: 'VERSION_CONFLICT' });
  const old = await service.get();
  await service.importWorkspace(old.state, true);
  await assert.rejects(service.mutate({ op: 'item', project: B, body: 'old import token', expectedProjectVersions: { [B]: old.state.projects.find(p => p.id === B).revision } }, old.version), { code: 'VERSION_CONFLICT' });
  const workerIds = [];
  for (let n = 0; n < 6; n++) { r = await service.mutate({ op: 'project', name: 'worker ' + n }, null); workerIds.push(r.state.projects.at(-1).id); }
  const worker = path.join(dir, 'worker.mjs');
  await writeFile(worker, `import {WorkspaceService,WorkspaceStore} from ${JSON.stringify(pathToFileURL(bundle).href)}; const s=new WorkspaceService(new WorkspaceStore(process.argv[2])); for(let n=0;n<8;n++){const r=await s.get();const p=r.state.projects.find(p=>p.id===process.argv[3]);await s.mutate({op:'item',project:p.id,body:'parallel '+n,expectedProjectVersions:{[p.id]:p.revision}},r.version);} `);
  const workers = await Promise.allSettled(workerIds.map(id => new Promise((resolve, reject) => execFile(process.execPath, [worker, file, id], { timeout: 60000 }, (e, out, err) => e ? reject(Error(err || e.message)) : resolve(out)))));
  for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;
  r = await service.get();
  for (const id of workerIds) {
    const p = r.state.projects.find(p => p.id === id);
    assert.equal(p.items.length, 8); assert.equal(p.nextNumber, 9); assert.equal(new Set(p.items.map(i => i.number)).size, 8);
  }
  assert.equal(r.state.projects.find(p => p.id === A).items.length, 1, 'parallel writes retain unrelated data');
  assert.equal((await readdir(dir)).filter(n => n.endsWith('.tmp') || n.endsWith('.lock')).length, 0);
  assert.equal(validateDate('2028-02-29'), '2028-02-29');
  for (const date of ['2027-02-29', '2026-13-01', '0000-01-01', '26-01-01']) assert.throws(() => validateDate(date));
  assert(matchesSchedule(undefined, 'through', '2026-10-10'));
  assert(matchesSchedule('2026-10-09', 'through', '2026-10-10'));
  assert(!matchesSchedule('2026-10-11', 'through', '2026-10-10'));
  assert(!matchesSchedule(undefined, 'exact', '2026-10-10'));
  assert(matchesSchedule('2026-10-10', 'exact', '2026-10-10'));
  const count = r.state.projects.find(p => p.id === B).items.length;
  await assert.rejects(service.mutate({ op: 'item', project: B, scheduledDate: '2026-02-30' }, null), /日期/);
  assert.equal((await service.get()).state.projects.find(p => p.id === B).items.length, count);
  r = await service.mutate({ op: 'item', project: B, body: 'dated', scheduledDate: '2027-01-02' }, null);
  const item = r.state.projects.find(p => p.id === B).items.at(-1);
  r = await service.mutate({ op: 'item', project: B, id: item.id, body: 'preserve date' }, null);
  assert.equal(r.state.projects.find(p => p.id === B).items.at(-1).scheduledDate, '2027-01-02');
  console.log('PASS 1.5 core: stale unrelated project edit succeeds; same-project/migration/import/global conflicts protected; 6-process/48-write retention and concurrent initialization; content tokens catch legacy writes; dates validated/preserved and no-date compatibility');
} finally { await rm(dir, { recursive: true, force: true }); }
