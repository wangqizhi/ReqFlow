// Validate the actual shipped Go PE and portable PE in isolated data folders.
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { verifyReleaseVersion } from './release-version.mjs';

const root = path.resolve(process.cwd());
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
await verifyReleaseVersion(root, version);
const temp = await mkdtemp(path.join(os.tmpdir(), 'reqflow-go-package-cli-'));
try {
  const executables = [path.join(root, 'release/win-unpacked/ReqFlow.exe'), path.join(root, 'release', `ReqFlow-Portable-${version}.exe`)];
  for (const [index, executable] of executables.entries()) {
    const data = path.join(temp, `data-${index}`);
    const invoke = async args => {
      const out = path.join(temp, `result-${index}.json`);
      const result = spawnSync(executable, ['--cli', ...args, '--data-dir', data, '--out', out], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(await readFile(out, 'utf8'));
    };
    const result = await invoke(['version']);
    assert.equal(result.ok, true);
    assert.equal(result.version, version);
    const workspace = await invoke(['workspace', 'get']);
    assert.equal(workspace.ok, true);
    assert.equal(workspace.state.projects.length, 1);
    assert.ok((await stat(path.join(data, 'requirements.sqlite'))).size > 0, 'Go SQLite operates in the packaged app');
    console.log(`PASS: shipped ${path.basename(executable)} Go CLI version ${version}, workspace and SQLite`);
  }
  const preview = spawnSync(process.execPath, [path.join(root, 'scripts/release-github.mjs'), '--dry-run'], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  assert.match(preview.stdout, /Go 构建\/打包清单 SHA256 已核验/);
  assert.match(preview.stdout, /预览完成；未上传/);
  console.log('PASS: release dry-run verifies only Go Setup/Portable/hash assets, without uploads or Git writes');
} finally {
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive: true, force: true });
}
