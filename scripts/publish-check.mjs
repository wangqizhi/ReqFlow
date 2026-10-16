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
  function mock(failure, clean = false, repo = true) {
    const calls = [];
    const argumentsByMethod = {};
    const api = Object.fromEntries(methods.map(name => [name, async (...args) => {
      calls.push(name);
      argumentsByMethod[name] = args;
      if (name === failure) return { ok: false, error: name + ' failed' };
      if (name === 'gitStatus') return { ok: true, repo, changes: clean ? [] : [{ path: 'app.ts' }] };
      if (name === 'gitStage') assert.deepEqual(args.slice(1), ['stage', []]);
      if (name === 'optimizeCommitMessage') return { ok: true, message: 'AI 优化后的提交文案' };
      if (name === 'gitCommit') assert.equal(args[1], 'AI 优化后的提交文案');
      return { ok: true, output: 'deployed' };
    }]));
    return { calls, api, argumentsByMethod };
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
  const local = { ...project, remote: undefined };
  const localMethods = methods.filter(name => name !== 'gitPush');
  test = mock();
  const steps = [];
  await publishProject(local, 'scripts/deploy.mjs', test.api, step => steps.push(step), 'terminal-local');
  assert.deepEqual(test.calls, localMethods);
  assert.deepEqual(test.argumentsByMethod.runPublish, ['project', 'scripts/deploy.mjs', 'terminal-local']);
  assert.deepEqual(test.argumentsByMethod.gitCommit, ['project', 'AI 优化后的提交文案', 'test', []]);
  assert.deepEqual(steps, ['检查 Git 状态', 'Add 暂存变动', 'AI 优化提交文案', 'Commit 提交变动', '运行部署发布脚本']);
  for (const failure of localMethods.slice(0, -1)) {
    test = mock(failure);
    await assert.rejects(publishProject(local, 'scripts/deploy.mjs', test.api, () => {}), /failed/);
    assert.deepEqual(test.calls, localMethods.slice(0, localMethods.indexOf(failure) + 1));
  }
  test = mock(undefined, true);
  await publishProject(local, 'scripts/deploy.mjs', test.api, () => {});
  assert.deepEqual(test.calls, ['gitStatus', 'runPublish']);
  test = mock(undefined, true, false);
  await publishProject(local, 'scripts/deploy.mjs', test.api, () => {});
  assert.deepEqual(test.calls, ['gitStatus', 'runPublish']);
  test = mock(undefined, true, false);
  await assert.rejects(publishProject(project, 'scripts/deploy.mjs', test.api, () => {}), /不是 Git 仓库/);
  assert.deepEqual(test.calls, ['gitStatus']);
  test = mock();
  test.api.optimizeCommitMessage = async () => ({ ok: true, message: '  ' });
  await assert.rejects(publishProject(local, 'scripts/deploy.mjs', test.api, () => {}), /AI 提交文案生成失败/);
  assert.deepEqual(test.calls, ['gitStatus', 'gitStage']);
  test = mock();
  test.api.gitCommit = async () => ({ ok: true, warning: '需求标识保存失败' });
  await assert.rejects(publishProject(local, 'scripts/deploy.mjs', test.api, () => {}), /需求标识保存失败/);
  assert.deepEqual(test.calls, ['gitStatus', 'gitStage', 'optimizeCommitMessage']);
  console.log('PASS: 远程/本地仓库发布顺序、AI提交文案、逐步失败中止、空文案和提交警告中止、干净仓库/非Git目录直接发布及终端会话透传。');
} finally {
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive: true, force: true });
}
