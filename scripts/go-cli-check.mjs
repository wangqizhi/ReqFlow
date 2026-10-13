import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const executable = path.join(root, 'release/win-unpacked/ReqFlow.exe');
const temp = await mkdtemp(path.join(tmpdir(), 'reqflow-go-cli-'));
const data = path.join(temp, 'data');
function cli(args, ok = true) {
  // Empty PATH proves the shipped CLI does not launch Node, Electron or Go tools.
  const r = spawnSync(executable, ['--cli', ...args, '--data-dir', data], {
    env: { ...process.env, PATH: '', REQFLOW_DATA_DIR: data }, windowsHide: true,
    encoding: 'utf8', timeout: 30000
  });
  if (r.error) throw r.error;
  const value = JSON.parse(r.stdout);
  assert.equal(value.ok, ok, value.error);
  assert.equal(r.status, ok ? 0 : 1);
  return value;
}
try {
  const version = cli(['version']);
  assert.equal(version.version, expectedVersion);
  assert.ok(version.capabilities.includes('scheduled-ai-complete'));
  const initial = cli(['workspace', 'get']);
  const project = initial.state.projects[0].id;
  const add = cli(['item', 'add', '--project', project, '--title', '中文 & 空格', '--body', '保留参数字面值', '--criteria', '第一条;第二条', '--date', '2026-10-13']);
  const item = add.item.id;
  assert.deepEqual(add.item.criteria, ['第一条', '第二条']);
  const generated = cli(['generate', '--project', project, '--items', item]);
  assert.match(generated.prompt, /中文 & 空格/);
  const batch = generated.batch.id;
  cli(['submit', '--project', project, '--batch', batch]);
  const scheduled = cli(['item', 'list', '--project', project, '--status', 'in_progress']);
  assert.equal(scheduled.items[0].id, item);
  const completed = cli(['complete', '--project', project, '--batch', batch, '--id', item, '--item-version', String(scheduled.items[0].version), '--summary', '已实现字段并完成CLI检查']);
  assert.equal(completed.ok, true);
  assert.equal(cli(['item', 'show', '--project', project, '--id', item]).item.completionNote, '已实现字段并完成CLI检查');
  cli(['item', 'completion-note', '--project', project, '--id', item, '--summary', '中'.repeat(51)], false);
  cli(['item', 'completion-note', '--project', project, '--id', item, '--summary', '补充说明', '--item-version', '99'], false);
  cli(['item', 'completion-note', '--project', project, '--id', item, '--summary', '已补写完成说明，CLI检查通过']);
  assert.equal(cli(['item', 'show', '--project', project, '--id', item]).item.completionNote, '已补写完成说明，CLI检查通过');
  cli(['verify', '--project', project, '--id', item, '--pass']);
  cli(['item', 'completion-note', '--project', project, '--id', item, '--summary', '归档后拒绝修改'], false);
  const shown = cli(['item', 'show', '--project', project, '--id', item]);
  assert.equal(shown.item.status, 'archived');
  cli(['regress', '--project', project, '--id', item, '--note', '回归测试问题']);
  assert.equal(cli(['item', 'show', '--project', project, '--id', item]).item.status, 'ready');
  cli(['item', 'add', '--project', project, '--date', '2026-02-30'], false);
  const output = path.join(temp, 'output.json');
  cli(['workspace', 'export', '--out', output]);
  assert.ok(JSON.parse(await readFile(output, 'utf8')).workspace.projects.length);
  assert.ok((await stat(path.join(data, 'requirements.sqlite'))).size > 0);
  console.log('Go CLI passed without PATH: version, plugin capabilities, SQLite, scheduling, completion, verification, regression, validation and export.');
} finally {
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(temp));
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(temp).startsWith('reqflow-go-cli-'));
  await rm(temp, { recursive: true, force: true });
}
