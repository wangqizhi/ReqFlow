import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { backupPreviousReleases } from './release-backup.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'reqflow-release-backup-'));
try {
  const release = path.join(root, 'release');
  mkdirSync(path.join(release, 'win-unpacked'), { recursive: true });
  mkdirSync(path.join(release, 'data'));
  const put = (name, body = name) => writeFileSync(path.join(release, name), body);
  for (const version of ['2.9.9', '2.10.0', '2.11.0', '2.12.0', '2.13.0']) {
    for (const name of [`ReqFlow-Setup-${version}.exe`, `ReqFlow-Portable-${version}.exe`, `SHA256SUMS-${version}.txt`, `packaging-manifest-${version}.json`, `README-Portable-${version}.txt`]) put(name);
  }
  put('update.json'); put('latest.yml'); put('notes-2.11.0.txt');
  const result = backupPreviousReleases(root, '2.12.0');
  assert.deepEqual(result.versions, ['2.11.0', '2.10.0']);
  assert.equal(result.files.length, 10);
  for (const file of result.files) assert.equal(readFileSync(file, 'utf8'), path.basename(file));
  assert.ok(!existsSync(path.join(release, 'ReqFlow-Setup-2.11.0.exe')));
  for (const name of ['ReqFlow-Setup-2.9.9.exe', 'ReqFlow-Setup-2.12.0.exe', 'ReqFlow-Setup-2.13.0.exe', 'update.json', 'latest.yml', 'notes-2.11.0.txt', 'win-unpacked', 'data']) {
    assert.ok(existsSync(path.join(release, name)), name);
  }
  assert.equal(backupPreviousReleases(root, '2.12.0').files.length, 0, 'retry must not archive more versions');
  put('ReqFlow-Setup-2.11.0.exe', 'rebuilt artifact');
  assert.throws(() => backupPreviousReleases(root, '2.12.0'), /备份文件已存在/);
  assert.equal(readFileSync(path.join(release, 'ReqFlow-Setup-2.11.0.exe'), 'utf8'), 'rebuilt artifact');
  assert.equal(readFileSync(path.join(release, 'backup/2.11.0/ReqFlow-Setup-2.11.0.exe'), 'utf8'), 'ReqFlow-Setup-2.11.0.exe');
  assert.throws(() => backupPreviousReleases(root, '../bad'), /格式无效/);
  console.log('PASS: 前两版本按版本号归档、完整文件保留、重试幂等、重名不覆盖、当前/未来/更旧版本与公共文件不移动。');
} finally {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  rmSync(root, { recursive: true, force: true });
}
