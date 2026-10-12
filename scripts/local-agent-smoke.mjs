import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const dir = await mkdtemp(path.join(tmpdir(), 'reqflow-agents-'));
const originalFetch = globalThis.fetch;
try {
  globalThis.agentHandlers = new Map();
  globalThis.agentVersionCalls = [];
  globalThis.agentVersions = { opencode: '1.2.3', pi: '2.0.0' };
  globalThis.fetch = async url => ({ ok: true, json: async () => ({ version: String(url).includes('opencode') ? '1.3.0' : '1.9.0' }) });
  const out = path.join(dir, 'agents.mjs');
  await build({ entryPoints: ['src/main/local-agents.ts'], outfile: out, bundle: true, format: 'esm', platform: 'node', plugins: [{ name: 'test-ipc', setup(b) {
    b.onResolve({ filter: /^(electron|node:child_process)$/ }, args => ({ path: args.path, namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: args.path === 'electron' ? 'export const ipcMain = { handle: (id, fn) => globalThis.agentHandlers.set(id, fn) };' : `export const execFile = (cmd, args, opts, callback) => { globalThis.agentVersionCalls.push({cmd,args,opts}); const name = cmd === 'cmd.exe' ? args.at(-1).split(' ')[0] : cmd; const v = globalThis.agentVersions[name]; callback(v ? null : Error('not installed'), v || ''); };` }));
  } }] });
  const { registerLocalAgents } = await import('file://' + out.replaceAll('\\', '/'));
  registerLocalAgents(dir);
  const invoke = (id, value) => globalThis.agentHandlers.get(id)(null, value);
  assert.deepEqual((await invoke('agents:get')).enabled, []);
  assert.equal((await invoke('agents:save', ['opencode'])).ok, true);
  assert.deepEqual((await invoke('agents:get')).enabled, ['opencode']);
  assert.equal((await invoke('agents:save', ['unknown'])).ok, false);
  assert.deepEqual((await invoke('agents:get')).enabled, ['opencode']);
  let result = await invoke('agents:detect');
  assert.equal(result.agents[0].installed, true);
  assert.equal(result.agents[0].update, true);
  assert.equal(result.agents[1].update, false, '本机版本高于 registry 时不提示更新');
  assert.ok(globalThis.agentVersionCalls.every(call => call.opts.windowsHide && call.opts.timeout === 8000));
  globalThis.agentVersions.pi = undefined;
  globalThis.fetch = async () => { throw Error('offline'); };
  result = await invoke('agents:detect');
  assert.equal(result.agents[1].installed, false);
  assert.equal(result.agents[0].update, undefined, '离线时不能误报无需更新');
  assert.ok(result.agents[0].registryError);
  console.log('Local Agent 检测、版本比较、配置持久化与失败降级检查通过');
} finally {
  globalThis.fetch = originalFetch;
  await rm(dir, { recursive: true, force: true });
}
