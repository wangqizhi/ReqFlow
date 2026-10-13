import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensurePlugin } from '../plugins/reqflow-agent/scripts/update.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'reqflow-plugin-update-check-'));
const info = { capabilities: ['plugin-release-v1'] };
const digest = files => createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))).digest('hex');
try {
  for (const [host, name, manifest] of [['codex', 'reqflow-agent', 'plugin.json'], ['pi', 'reqflow-agent-pi', 'package.json'], ['zcode', 'reqflow-agent-zcode', '.zcode-plugin/plugin.json']]) {
    const root = path.join(temporary, host);
    await mkdir(path.dirname(path.join(root, manifest)), { recursive: true });
    await writeFile(path.join(root, manifest), JSON.stringify({ name, version: '0.1.0' }));
    const files = { [manifest]: JSON.stringify({ name, version: '0.2.0' }), 'scripts/reqflow.mjs': '// latest' };
    const bundle = { name, host, version: '0.2.0', files, sha256: digest(files) };
    const calls = [];
    const runHost = async (exe, args) => {
      calls.push([exe, args]);
      if (args.includes('list')) return JSON.stringify({ marketplaces: [] });
      if (exe === 'codex' && args[1] === 'add') return JSON.stringify({ version: '0.2.0' });
      return '{}';
    };
    const options = { root, updateDir: path.join(temporary, host + '-updates'), runHost,
      piExtensionDir: path.join(temporary, 'pi-direct'), piSourceDir: path.join(temporary, 'pi-managed') };
    const cli = async (_config, args) => args[1] === 'version' ? { ...bundle, files: undefined, updateAvailable: true } : bundle;
    const updated = await ensurePlugin(host === 'zcode' ? { pluginUpdater: { executable: 'supported-adapter.exe', args: ['install', '{pluginDir}'] } } : {}, info, host, cli, options);
    assert.equal(await readFile(path.join(updated.pluginDir, 'scripts/reqflow.mjs'), 'utf8'), '// latest');
    if (host === 'zcode') {
      assert.equal(updated.updated, true);
      assert.equal(calls[0][0], 'supported-adapter.exe');
    } else {
      assert.equal(updated.updated, true);
      assert.ok(calls.some(([exe, args]) => exe === host && args.includes(host === 'pi' ? 'install' : `${name}@reqflow-local`)));
    }
    calls.length = 0;
    const same = await ensurePlugin({}, info, host, async () => ({ updateAvailable: false, version: '0.1.0' }), options);
    assert.equal(same.updated, false);
    assert.equal(calls.length, 0);
    await assert.rejects(ensurePlugin({}, {}, host, cli, options), /先安装 ReqFlow/);
    await assert.rejects(ensurePlugin({}, info, host, async (_config, args) => args[1] === 'version' ? { ...bundle, updateAvailable: true } : { ...bundle, sha256: 'tampered' }, options), /校验失败/);
    const malicious = { ...files, '../escape': 'bad' };
    const badBundle = { ...bundle, files: malicious, sha256: digest(malicious) };
    await assert.rejects(ensurePlugin({}, info, host, async (_config, args) => args[1] === 'version' ? { ...badBundle, updateAvailable: true } : badBundle, options), /非法路径/);
    const config = host === 'zcode' ? { pluginUpdater: { executable: 'supported-adapter.exe', args: ['{pluginDir}'] } } : {};
    await assert.rejects(ensurePlugin(config, info, host, cli, { ...options, runHost: async () => { throw Error('host failed'); } }), /host failed/);
  }
  console.log('PASS: plugin version negotiation, SHA256, safe paths, host installation and update blockers.');
} finally {
  const relative = path.relative(os.tmpdir(), temporary);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await rm(temporary, { recursive: true, force: true });
}
