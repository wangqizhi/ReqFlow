// Real Electron CLI; isolated temporary workspace, never uses the user's store.
import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readRun, completeRun, callCli, matchProject } from '../plugins/reqflow-agent/scripts/reqflow.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'reqflow-plugin-'));
try {
  const app = path.join(temp, 'app'), data = path.join(temp, 'data');
  const root = path.join(temp, '中文 项目'), child = path.join(root, 'src');
  const sibling = path.join(temp, '中文 项目-other');
  await Promise.all([fs.mkdir(app), fs.mkdir(data), fs.mkdir(child, { recursive: true }), fs.mkdir(sibling)]);
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'reqflow-plugin-test', version: '1.0.0', main: 'main.cjs' }));
  await build({ entryPoints: ['src/main/index.ts'], outfile: path.join(app, 'main.cjs'), bundle: true,
    platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  const domainFile = path.join(temp, 'domain.mjs');
  await build({ entryPoints: ['src/core/domain.ts'], outfile: domainFile, bundle: true,
    platform: 'node', format: 'esm', logLevel: 'silent' });
  const { makeProject, apply } = await import(pathToFileURL(domainFile).href);
  const p = makeProject('同名项目'), other = makeProject('同名项目');
  p.dir = root; other.dir = sibling;
  const state = { projects: [p, other] };
  for (const title of ['需要完成', '保持执行中', '未提交'])
    await apply(state, { op: 'item', project: p.id, title, body: '完整正文超过预览也要可读', criteria: '满足验收' });
  const [first, second, ready] = p.items;
  await apply(state, { op: 'generate', project: p.id, ids: [first.id, second.id] });
  await apply(state, { op: 'submit', project: p.id, batch: p.batches[0].id });
  const config = { executable: path.resolve('node_modules/electron/dist/electron.exe'), args: [app], dataDir: data };
  const store = path.join(data, 'workspace.json');
  let version = 1;
  const save = async () => fs.writeFile(store, JSON.stringify({ id: 'local_electron', version: version++, data: state }));
  await save();
  assert.equal((await matchProject(state.projects, child)).project.id, p.id);
  assert.equal((await matchProject(state.projects, sibling)).project.id, other.id);
  await assert.rejects(matchProject([p, { ...other, dir: root }], root), /多个/);
  await assert.rejects(matchProject([p], sibling), /没有匹配/);
  const nested = { ...other, dir: child };
  assert.equal((await matchProject([p, nested], child)).project.id, nested.id);
  const run = await readRun(config, child, path.join(temp, 'runs'));
  assert.equal(run.requirements.length, 2);
  assert.ok(!run.requirements.some(i => i.id === ready.id));
  assert.equal(run.requirements[0].requirement.body, first.body);
  const report = { items: [{ id: first.id, summary: '已实现', validation: '测试通过' }] };
  await assert.rejects(completeRun(run.runFile, { items: [{ ...report.items[0], id: ready.id }] }, child), /未领取/);
  await assert.rejects(completeRun(run.runFile, report, root), /目录/);
  const result = await completeRun(run.runFile, report, child);
  assert.equal(result.ok, true);
  const after = await callCli(config, ['workspace', 'get']);
  assert.equal(after.state.projects[0].items[0].status, 'pending_verification');
  assert.equal(after.state.projects[0].items[1].status, 'in_progress');
  assert.equal(after.state.projects[0].items[2].status, 'ready');
  assert.equal((await completeRun(run.runFile, report, child)).outcomes[0].status, 'already_completed');

  // Re-submitting the same version changes the selected batch; old run must not complete it.
  await save();
  const oldRun = await readRun(config, root, path.join(temp, 'runs'));
  await apply(state, { op: 'generate', project: p.id, ids: [first.id] });
  await apply(state, { op: 'submit', project: p.id, batch: p.batches[0].id });
  await save();
  assert.equal((await completeRun(oldRun.runFile, report, root)).ok, false);
  await apply(state, { op: 'revert', project: p.id, id: first.id });
  await apply(state, { op: 'item', project: p.id, id: first.id, body: '新版本' });
  await save();
  assert.equal((await completeRun(oldRun.runFile, report, root)).ok, false);
  await apply(state, { op: 'guidance', project: p.id, text: '新引导词' });
  await save();
  const stale = await readRun(config, root, path.join(temp, 'runs'));
  assert.equal(stale.requirements.length, 0);
  assert.equal(stale.runFile, null);
  assert.ok(stale.skipped.some(i => i.id === second.id));
  console.log('PASS: 实际 Electron CLI 领取/部分完成/幂等重试；目录边界、重复绑定、最新批次、版本与引导词冲突。');
} finally {
  // This is an absolute path allocated by mkdtemp under the intended OS temp directory.
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(temp, { recursive: true, force: true });
}
