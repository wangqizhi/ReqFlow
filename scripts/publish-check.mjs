import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const temp = await mkdtemp(path.join(os.tmpdir(), 'reqflow-publish-test-'));
try {
  const file = path.join(temp, 'publish.mjs');
  await build({ entryPoints: ['src/renderer/publish.ts'], outfile: file, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
  const { publishProject } = await import(pathToFileURL(file).href);
  const project = { id: 'test', name: '测试项目', dir: 'project', remote: { url: 'local-test' }, items: [] };
  const methods = ['gitStatus', 'gitStage', 'optimizeCommitMessage', 'gitCommit', 'gitPush', 'runPublish'];
  function mock(failure, clean = false) {
    const calls = [];
    const api = Object.fromEntries(methods.map(name => [name, async (...args) => {
      calls.push(name);
      if (name === failure) return { ok: false, error: name + ' failed' };
      if (name === 'gitStatus') return { ok: true, repo: true, changes: clean ? [] : [{ path: 'app.ts' }] };
      if (name === 'gitStage') assert.deepEqual(args.slice(1), ['stage', []]);
      if (name === 'optimizeCommitMessage') return { ok: true, message: 'AI 优化后的提交文案' };
      if (name === 'gitCommit') assert.equal(args[1], 'AI 优化后的提交文案');
      return { ok: true, output: 'deployed' };
    }]));
    return { calls, api };
  }
  let test = mock();
  assert.equal((await publishProject(project, 'scripts/deploy.mjs', test.api, () => {})).ok, true);
  assert.deepEqual(test.calls, methods);
  for (const failure of methods.slice(0, -1)) {
    test = mock(failure);
    await assert.rejects(publishProject(project, 'scripts/deploy.mjs', test.api, () => {}), /failed/);
    assert.deepEqual(test.calls, methods.slice(0, methods.indexOf(failure) + 1));
  }
  test = mock(undefined, true);
  await publishProject(project, 'scripts/deploy.mjs', test.api, () => {});
  assert.deepEqual(test.calls, ['gitStatus', 'gitPush', 'runPublish']);
  test = mock();
  await publishProject({ ...project, remote: undefined }, 'scripts/deploy.mjs', test.api, () => {});
  assert.deepEqual(test.calls, ['runPublish']);
  console.log('PASS: 发布顺序、AI提交文案、逐步失败中止、干净仓库推送及无远程仓库直接发布。');
} finally {
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive: true, force: true });
}
