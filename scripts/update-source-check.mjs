import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';

const bundled = await build({ entryPoints: ['src/main/updater.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false });
const require = createRequire(import.meta.url);
for (const current of ['99.0.0', '1.0.0']) {
  const handlers = new Map(), requests = [];
  const electron = {
    app: { getPath: () => path.join(os.tmpdir(), 'reqflow-update-source-' + process.pid), getVersion: () => current },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, shell: {},
    net: { fetch: async raw => {
      const url = String(raw);
      requests.push(url);
      assert.ok(!url.includes('api.github.com') && !url.includes('update.json'));
      if (url.endsWith('/releases/latest')) {
        const response = new Response('');
        Object.defineProperty(response, 'url', { value: 'https://github.com/wangqizhi/ReqFlow/releases/tag/v99.0.0' });
        return response;
      }
      if (url.endsWith('.txt')) return new Response('a'.repeat(64) + '  ReqFlow-Setup-99.0.0.exe');
      if (url.endsWith('.exe')) return new Response('MZ', { headers: { 'content-length': '2' } });
      throw Error('Unexpected URL: ' + url);
    } }
  };
  const context = { module: { exports: {} }, require: id => id === 'electron' ? electron : require(id),
    process: { platform: 'win32', arch: 'x64' }, Response, AbortSignal, Buffer, setTimeout };
  vm.runInNewContext(bundled.outputFiles[0].text, context);
  context.module.exports.registerUpdater();
  const state = await handlers.get('update:check')();
  assert.equal(state.phase, current === '99.0.0' ? 'latest' : 'available', state.error);
  assert.equal(requests.length, current === '99.0.0' ? 1 : 3);
}
console.log('PASS: public release redirect checks current/new versions without API or update.json; checksum and installer metadata verified.');
