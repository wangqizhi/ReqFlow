// Exercise the actual portable binary with a consistent, isolated data copy.
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const portable = path.join(root, 'release/win-unpacked');
const installed = process.argv[2] || 'E:\\Program Files\\reqflow-data\\AppData\\Roaming\\ReqFlow';
const temporary = await mkdtemp(path.join(tmpdir(), 'reqflow-mygo-ui-'));
const data = path.join(temporary, 'data');
let child;
try {
  await mkdir(data);
  for (const name of ['workspace.json', 'ai-settings.json', 'local-agents.json']) {
    await copyFile(path.join(installed, name), path.join(data, name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  const original = new DatabaseSync(path.join(installed, 'requirements.sqlite'), { readOnly: true });
  try { await backup(original, path.join(data, 'requirements.sqlite')); }
  finally { original.close(); }
  const cli = args => {
    const r = spawnSync(path.join(portable, 'ReqFlow.exe'), ['--cli', ...args, '--data-dir', data], { windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
    assert.equal(r.status, 0, r.error?.message || r.stderr || r.stdout.slice(0, 500));
    return JSON.parse(r.stdout);
  };
  const workspace = cli(['workspace', 'get']).state;
  // The isolated copy has no remote credentials; detach its copied associations
  // before fixture mutations so tests never contact or modify a real server.
  for (const project of workspace.projects.filter(p => p.serverAgent)) {
    const detached = spawnSync(path.join(portable, 'ReqFlow.exe'), ['--test-invoke'], {
      windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, REQFLOW_DATA_DIR: data },
      input: JSON.stringify({ channel: 'workspace:apply', args: [{ op: 'projectSync', project: project.id, server: null }] }) + '\n',
    });
    assert.equal(detached.status, 0, detached.error?.message || detached.stderr);
    assert.equal(JSON.parse(detached.stdout).ok, true, detached.stdout);
  }
  // Existing runs belong to the copied data, not to the four execution fixtures below.
  // Release them only in this script's isolated copy so UI checks stay deterministic.
  for (const project of workspace.projects) for (const item of project.items) {
    if (item.aiExecution?.runId && !item.aiExecution.endedAt) cli(['execution', 'release', '--project', project.id, '--id', item.id, '--run', item.aiExecution.runId]);
  }
  const project = workspace.projects[0].id;
  // REQ-280：长正文需求用于验证需求池/排期表卡片的内部滚动（不排期，停留在需求池）
  const longBody = Array.from({ length: 30 }, (_, n) => `第 ${n + 1} 行：长正文滚动检查，超过卡片高度后应出现内部滚动条。`).join('\n');
  cli(['item', 'add', '--project', project, '--title', '长正文滚动UI检查', '--body', longBody]);
  const item = cli(['item', 'add', '--project', project, '--title', '完成说明UI检查', '--body', '仅存在于隔离副本']).item.id;
  cli(['generate', '--project', project, '--items', item]);
  cli(['complete', '--project', project, '--id', item, '--summary', '已补齐完成说明，CLI检查通过']);
  const componentFixture = spawnSync(path.join(portable, 'ReqFlow.exe'), ['--test-invoke'], {
    windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000, env: { ...process.env, REQFLOW_DATA_DIR: data },
    input: JSON.stringify({ channel: 'workspace:apply', args: [{ op: 'verificationVersion', project, id: item, version: 1,
      value: '3.0.0', components: { frontend: '1.2.3', backend: { version: '2.3.4', file: 'backend/package.json' }, invalid: 42 } }] }) + '\n',
  });
  assert.equal(componentFixture.status, 0, componentFixture.error?.message || componentFixture.stderr);
  assert.equal(JSON.parse(componentFixture.stdout).ok, true, componentFixture.stdout);
  const executionItems = ['codex', 'zcode', 'pi', 'claude-code', 'opencode'].map(client => ({ client,
    id: cli(['item', 'add', '--project', project, '--title', '领取状态UI检查 ' + client]).item.id }));
  const executionBatch = cli(['generate', '--project', project, '--items', executionItems.map(i => i.id).join(',')]).batch;
  for (const entry of executionItems) cli(['execution', 'claim', '--project', project, '--run', randomUUID(), '--client', entry.client,
    '--claims', JSON.stringify([{ id: entry.id, version: 1, batchId: executionBatch.id, hash: executionBatch.hash }])]);
  const publishFixture = path.join(temporary, 'publish-fixture');
  await mkdir(publishFixture);
  await writeFile(path.join(publishFixture, 'publish.ps1'), "Write-Output 'stream-first'; Start-Sleep -Milliseconds 4000; [Console]::Error.WriteLine('stream-stderr'); Write-Output 'stream-last'", 'utf8');
  const fixture = spawnSync(path.join(portable, 'ReqFlow.exe'), ['--test-invoke'], {
    windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, REQFLOW_DATA_DIR: data },
    input: JSON.stringify({ channel: 'workspace:apply', args: [{ op: 'project', name: '发布终端UI检查', dir: publishFixture }] }) + '\n',
  });
  assert.equal(fixture.status, 0, fixture.error?.message || fixture.stderr);
  assert.equal(JSON.parse(fixture.stdout).ok, true, fixture.stdout);
  const publishProject = cli(['workspace', 'get']).state.projects.find(p => p.name === '发布终端UI检查');
  const crossItem = cli(['item', 'add', '--project', publishProject.id, '--title', '跨项目执行UI检查']).item.id;
  const crossBatch = cli(['generate', '--project', publishProject.id, '--items', crossItem]).batch;
  cli(['execution', 'claim', '--project', publishProject.id, '--run', randomUUID(), '--client', 'codex', '--claims', JSON.stringify([{ id: crossItem, version: 1, batchId: crossBatch.id, hash: crossBatch.hash }])]);
  const reportPath = path.join(temporary, 'report.json');
  const env = { ...process.env, REQFLOW_DATA_DIR: data, REQFLOW_WEBVIEW_DIR: path.join(temporary, 'webview'), REQFLOW_UI_INTERACTIONS: '1', REQFLOW_UI_NOTIFICATION: process.env.REQFLOW_UI_NOTIFICATION || '1' };
  let stderr = '';
  child = spawn(path.join(portable, 'ReqFlow.exe'), ['--smoke-ui', reportPath], {
    cwd: portable, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', value => { stderr += value; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('MyGO UI check timed out')); }, 180_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`MyGO exited ${code}: ${stderr}`)); });
  });
  child = undefined;
  assert.ok((await stat(path.join(temporary, 'webview', 'ReqFlow', 'WebView2'))).isDirectory(), 'Native WebView2 must use the isolated test profile');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  await mkdir(path.join(root, 'tmp'), { recursive: true });
  await writeFile(path.join(root, 'tmp/mygo-ui-report.json'), JSON.stringify(report, null, 2));
  await copyFile(reportPath + '.png', path.join(root, 'tmp/mygo-ui-check.png'));
  await copyFile(reportPath + '.compact.png', path.join(root, 'tmp/mygo-ui-compact.png'));
  const compact = JSON.parse(await readFile(reportPath + '.compact.json', 'utf8'));
  assert.equal(compact.ok, true, JSON.stringify(compact));
  const schedule = JSON.parse(await readFile(reportPath + '.schedule.json', 'utf8'));
  assert.equal(schedule.ok, true, JSON.stringify(schedule));
  await copyFile(reportPath + '.schedule.png', path.join(root, 'tmp/mygo-schedule-compact.png'));
  for (const height of [900, 720]) for (const surface of ['terminal', 'sidebar', 'stats', 'milestones', 'directory', 'content', 'projects', 'guide', 'ssh', 'project-import', 'settings-api', 'settings-cli', 'settings-data', 'mods-protocol', 'mods-agents', 'mods-lab']) {
    const suffix = `.${surface}-${height}`;
    const layout = JSON.parse(await readFile(reportPath + suffix + '.json', 'utf8'));
    assert.equal(layout.ok, true, JSON.stringify(layout));
    await copyFile(reportPath + suffix + '.png', path.join(root, `tmp/mygo-${surface}-${height}.png`));
  }
  for (const height of [900, 720]) {
    const detached = JSON.parse(await readFile(`${reportPath}.detached-${height}.json`, 'utf8'));
    assert.equal(detached.ok, true, JSON.stringify(detached));
    // Native maximize must keep the terminal veil covered and reveal content only after the final paint.
    assert.equal(detached.maximize?.ok, true, JSON.stringify(detached.maximize));
    await writeFile(path.join(root, `tmp/mygo-terminal-detached-${height}.json`), JSON.stringify(detached, null, 2));
    await copyFile(`${reportPath}.detached-${height}.png`, path.join(root, `tmp/mygo-terminal-detached-${height}.png`));
  }
  if (env.REQFLOW_UI_NOTIFICATION === '1') assert.equal(report.notification?.ok, true, JSON.stringify(report.notification));
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.match(report.title, /ReqFlow/);
  assert.equal(report.checks['app:info'].backend, 'go');
  assert.equal(report.checks['app:info'].version, pkg.version);
  assert.ok(report.checks['workspace:get'].count > 0);
  console.log(JSON.stringify(report));
  console.log('MyGO portable UI passed with an isolated copy of installed data.');
} finally {
  child?.kill();
  // Only remove the verified temporary directory created by this script.
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(temporary));
  if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(temporary).startsWith('reqflow-mygo-ui-')) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}
