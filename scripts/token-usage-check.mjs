import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const temp = await mkdtemp(path.join(os.tmpdir(), 'reqflow-usage-'));
try {
  const outfile = path.join(temp, 'usage.mjs');
  await build({ entryPoints: ['src/renderer/token-usage.tsx'], bundle: true, platform: 'node', format: 'esm', outfile });
  const { taskUsageRows, hasUnreportedAntigravityTask } = await import(pathToFileURL(outfile));
  const now = Date.now();
  const history = (offset, tokens) => ({ event: '实现完成', time: new Date(now + offset).toISOString(), execution: { runId: 'run' }, usage: [{ model: 'model', reasoningEffort: 'high', scope: 'run', sessionId: 'exact-session', inputTokens: tokens, outputTokens: 10 }] });
  const projects = [{ id: 'p', name: 'Project', items: [{ id: 'a', number: 'REQ-A', history: [history(0, 100)] }, { id: 'b', number: 'REQ-B', history: [history(1, 120)] }] }];
  const rows = taskUsageRows(projects, 7);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 120);
  assert.match(rows[0].requirement, /REQ-A/);
  assert.match(rows[0].requirement, /REQ-B/);
  assert.deepEqual(taskUsageRows(projects, 7, 'other'), []);
  projects[0].items.reverse();
  assert.equal(taskUsageRows(projects, 7)[0].input, 120, 'independent of requirement iteration order');
  for (const item of projects[0].items) for (const event of item.history) event.time = '2020-01-01T00:00:00Z';
  assert.deepEqual(taskUsageRows(projects, 7), []);
  assert.equal(taskUsageRows(projects, 0).length, 1);
  const antigravityUsage = { run: [{ model: 'gemini-example', inputTokens: 50, outputTokens: 10, scope: 'run', sessionId: 'agy-session' }] };
  assert.equal(hasUnreportedAntigravityTask(projects), false);
  for (const item of projects[0].items) for (const event of item.history) {
    event.execution.client = 'pi';
    event.note = '[ReqFlow Antigravity run run]\nCompleted';
    delete event.usage;
  }
  assert.equal(hasUnreportedAntigravityTask(projects), true);
  const recovered = taskUsageRows(projects, 0, 'p', antigravityUsage);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].client, 'antigravity');
  assert.equal(recovered[0].model, 'gemini-example');
  assert.equal(recovered[0].input, 50);
  console.log('PASS: shared usage deduplication, project/date filters, and Antigravity history.');
} finally { await rm(temp, { recursive: true, force: true }); }
