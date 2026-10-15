import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateReleaseNotes, releaseNotes } from './release-github.mjs';

const valid = '# ReqFlow 2.5.0\n\n## 主要更新\n\n- 支持项目隐藏与恢复，并保存显示状态。\n\n## 安装\nWindows x64';
assert.equal(validateReleaseNotes(valid, '2.5.0'), valid);
for (const body of ['', '# ReqFlow 2.4.1\n## 主要更新\n- 支持项目隐藏与恢复功能。', '# ReqFlow 2.5.0\n\nWindows x64，安装升级版', '# ReqFlow 2.5.0\n## 主要更新\n待补充', '# ReqFlow 2.5.0\n## 安装\n- Windows x64 安装升级版。']) {
  assert.throws(() => validateReleaseNotes(body, '2.5.0'));
}
const directory = await mkdtemp(path.join(os.tmpdir(), 'reqflow-release-notes-'));
try {
  await assert.rejects(releaseNotes('2.5.0', undefined, directory), /缺少发布说明/);
  await mkdir(path.join(directory, 'docs'));
  await writeFile(path.join(directory, 'docs/release-2.5.0.md'), valid);
  assert.equal((await releaseNotes('2.5.0', undefined, directory)).body, valid);
  await writeFile(path.join(directory, 'custom.md'), valid);
  assert.equal((await releaseNotes('2.5.0', 'custom.md', directory)).body, valid);
  await writeFile(path.join(directory, 'custom.md'), '# ReqFlow 2.5.0\n只有安装说明');
  await assert.rejects(releaseNotes('2.5.0', 'custom.md', directory), /主要更新/);
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log('PASS: 发布说明默认路径、自定义路径、版本校验、空白/占位/仅安装说明拦截。');
