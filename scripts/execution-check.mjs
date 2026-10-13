// Race three real client bridges against the packaged SQLite CLI.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { callCli } from '../plugins/reqflow-agent/scripts/reqflow.mjs';
import { createHash, randomUUID } from 'node:crypto';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'reqflow-execution-check-'));
try {
  const projectDir = path.join(temporary, 'project');
  await fs.mkdir(projectDir);
  const domain = path.join(temporary, 'domain.mjs');
  await build({ entryPoints: ['src/core/domain.ts'], outfile: domain, platform: 'node', format: 'esm', bundle: true, logLevel: 'silent' });
  const { makeProject, apply } = await import(pathToFileURL(domain).href);
  const project = makeProject('并发领取'); project.dir = projectDir;
  const state = { projects: [project] };
  await apply(state, { op: 'item', project: project.id, body: '只能被一个客户端领取' });
  const item = project.items[0];
  await apply(state, { op: 'generate', project: project.id, ids: [item.id] });
  const fixture = path.join(temporary, 'fixture.json');
  await fs.writeFile(fixture, JSON.stringify(state));
  const config = { executable: path.resolve('release/win-unpacked/ReqFlow.exe'), dataDir: path.join(temporary, 'data') };
  await callCli(config, ['workspace', 'import', '--file', fixture]);
  const clients = await Promise.all(['reqflow-agent', 'reqflow-agent-zcode', 'reqflow-agent-pi'].map(name => import(pathToFileURL(path.resolve('plugins', name, 'scripts/reqflow.mjs')).href)));
  const preview = await clients[0].readRun(config, projectDir, path.join(temporary, 'preview'), { claim: false });
  assert.equal(preview.runFile, null);
  assert.equal((await callCli(config, ['item', 'show', '--project', project.id, '--id', item.id])).item.aiExecution, undefined);
  const runs = await Promise.all(clients.map((client, index) => client.readRun(config, projectDir, path.join(temporary, 'client-' + index))));
  assert.equal(runs.reduce((count, run) => count + run.requirements.length, 0), 1, 'exactly one client can acquire this item');
  const winner = runs.findIndex(run => run.requirements.length === 1);
  const owner = JSON.parse(await fs.readFile(runs[winner].runFile, 'utf8'));
  const report = { items: [{ id: item.id, summary: '已完成并发验证', validation: 'SQLite 与三个真实客户端桥接竞争检查通过' }] };
  await assert.rejects(callCli(config, ['complete', '--project', project.id, '--id', item.id, '--run', randomUUID()]), /执行/);
  const completed = await clients[winner].completeRun(runs[winner].runFile, report, projectDir);
  assert.equal(completed.ok, true, JSON.stringify(completed));
  const finished = (await callCli(config, ['item', 'show', '--project', project.id, '--id', item.id])).item;
  assert.equal(finished.aiExecution.runId, owner.id);
  assert.ok(finished.aiExecution.endedAt);
  assert.ok(finished.aiExecution.durationMs >= 0);
  assert.equal(finished.status, 'pending_verification');
  assert.equal((await clients[winner].completeRun(runs[winner].runFile, report, projectDir)).outcomes[0].status, 'already_completed');
  // A claimed task can be released explicitly; its original receipt cannot complete it.
  await callCli(config, ['verify', '--project', project.id, '--id', item.id, '--pass', 'false', '--note', '隔离测试重新排期']);
  await callCli(config, ['generate', '--project', project.id, '--items', item.id]);
  const interrupted = await clients[0].readRun(config, projectDir, path.join(temporary, 'interrupted'));
  const receipt = JSON.parse(await fs.readFile(interrupted.runFile, 'utf8'));
  await callCli(config, ['execution', 'release', '--project', project.id, '--id', item.id, '--run', receipt.id]);
  assert.equal((await clients[0].completeRun(interrupted.runFile, report, projectDir)).ok, false);
  const reclaimed = await clients[2].readRun(config, projectDir, path.join(temporary, 'reclaimed'));
  assert.equal(reclaimed.requirements.length, 1, JSON.stringify({reclaimed, item: (await callCli(config, ['item','show','--project', project.id,'--id',item.id])).item}));
  // Snapshots from the previous release must migrate without claiming unrelated
  // tasks, and separate partial reports must remain usable in the same run.
  const legacyItems = [];
  for (const title of ['旧快照任务一', '旧快照任务二']) legacyItems.push((await callCli(config, ['item', 'add', '--project', project.id, '--title', title])).item.id);
  await callCli(config, ['generate', '--project', project.id, '--items', legacyItems.join(',')]);
  const oldWorkspace = await callCli(config, ['workspace', 'get']);
  const oldProject = oldWorkspace.state.projects.find(p => p.id === project.id);
  const oldBatch = oldProject.batches[0];
  const versionInfo = await callCli(config, ['version']);
  const receiptPath = path.join(temporary, 'legacy-run.json');
  const legacyRun = { schema: 1, id: randomUUID(), config, cwd: (await fs.realpath(projectDir)).toLowerCase(), root: (await fs.realpath(projectDir)).toLowerCase(), dataFile: await fs.realpath(versionInfo.dataFile), projectId: project.id, completed: [],
    items: legacyItems.map(id => {
      const i = oldProject.items.find(i => i.id === id);
      const payload = { dir: oldProject.dir, description: oldProject.description, guidance: oldProject.guidance, guideVersion: oldProject.guideVersion, deliveryGuidance: oldProject.deliveryGuidance, aiValidation: oldProject.aiValidation, item: i, batch: oldBatch };
      return { id, batchId: oldBatch.id, hash: oldBatch.hash, requirement: i, signature: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
    }) };
  await fs.writeFile(receiptPath, JSON.stringify(legacyRun));
  for (const id of legacyItems) assert.equal((await clients[0].completeRun(receiptPath, { items: [{ id, summary: '兼容旧版本领取记录', validation: '分次完成迁移测试通过' }] }, projectDir)).ok, true);
  console.log('PASS: read-only inspection, SQLite cross-process exclusive claims, owner completion, time records, release and re-claim.');
} finally {
  const relative = path.relative(os.tmpdir(), temporary);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await fs.rm(temporary, { recursive: true, force: true });
}
