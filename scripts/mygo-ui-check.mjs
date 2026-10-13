// Exercise the actual portable binary with a consistent, isolated data copy.
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
  const reportPath = path.join(temporary, 'report.json');
  const env = { ...process.env, REQFLOW_DATA_DIR: data, REQFLOW_WEBVIEW_DIR: path.join(temporary, 'webview'), REQFLOW_UI_INTERACTIONS: '1' };
  let stderr = '';
  child = spawn(path.join(portable, 'ReqFlow.exe'), ['--smoke-ui', reportPath], {
    cwd: portable, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', value => { stderr += value; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('MyGO UI check timed out')); }, 60_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`MyGO exited ${code}: ${stderr}`)); });
  });
  child = undefined;
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  await mkdir(path.join(root, 'tmp'), { recursive: true });
  await writeFile(path.join(root, 'tmp/mygo-ui-report.json'), JSON.stringify(report, null, 2));
  await copyFile(reportPath + '.png', path.join(root, 'tmp/mygo-ui-check.png'));
  await copyFile(reportPath + '.compact.png', path.join(root, 'tmp/mygo-ui-compact.png'));
  const compact = JSON.parse(await readFile(reportPath + '.compact.json', 'utf8'));
  assert.equal(compact.ok, true, JSON.stringify(compact));
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
