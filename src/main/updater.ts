import { app, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { newerVersion, type UpdateState } from '../core/update';

const repository = 'wangqizhi/ReqFlow';
type Asset = { name: string; browser_download_url: string; size: number; digest?: string };

export function registerUpdater() {
  let state: UpdateState = { phase: 'idle' };
  let asset: Asset | undefined;
  let checksumUrl = '';
  let installer = '';
  let busy = false;
  const fail = (error: unknown) => { state = { ...state, phase: 'error', error: error instanceof Error ? error.message : String(error) }; };
  const request = async (url: string) => {
    const response = await fetch(url, { headers: { 'User-Agent': 'ReqFlow', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!response.ok) throw Error(`GitHub 请求失败（HTTP ${response.status}）`);
    return response;
  };
  const trustedUrl = (url: string) => url.startsWith(`https://github.com/${repository}/releases/download/`);

  ipcMain.handle('update:state', () => state);
  ipcMain.handle('update:check', async () => {
    if (busy || state.phase === 'ready' || state.phase === 'installing') return state;
    busy = true;
    state = { phase: 'checking' };
    asset = undefined;
    try {
      if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('在线安装目前支持 Windows x64');
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
        headers: { 'User-Agent': 'ReqFlow', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw Error(`版本检测失败（HTTP ${response.status}），请稍后重试`);
      const release = await response.json();
      if (typeof release.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name) || release.draft || release.prerelease) throw Error('发布版本信息无效');
      const version = release.tag_name.replace(/^v/, '');
      if (!newerVersion(version, app.getVersion())) { state = { phase: 'latest', version: app.getVersion() }; return state; }
      asset = release.assets?.find((entry: Asset) => entry.name === `ReqFlow-Setup-${version}.exe`);
      const checksum: Asset | undefined = release.assets?.find((entry: Asset) => entry.name === `SHA256SUMS-${version}.txt`);
      if (!asset || !trustedUrl(asset.browser_download_url) || !Number.isSafeInteger(asset.size) || asset.size <= 0) throw Error('新版本缺少有效的 Windows 安装包');
      checksumUrl = checksum && trustedUrl(checksum.browser_download_url) ? checksum.browser_download_url : '';
      if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '') && !checksumUrl) throw Error('新版本缺少 SHA256 校验信息');
      state = { phase: 'available', version };
    } catch (error) { fail(error); }
    finally { busy = false; }
    return state;
  });

  ipcMain.handle('update:download', async () => {
    if (busy || !asset || !['available', 'error'].includes(state.phase)) return state;
    busy = true;
    state = { phase: 'downloading', version: state.version, progress: 0, downloaded: 0, total: asset.size };
    const directory = path.join(app.getPath('userData'), 'updates');
    const target = path.join(directory, asset.name);
    const partial = target + '.part';
    try {
      await fs.mkdir(directory, { recursive: true });
      let expected = asset.digest?.replace(/^sha256:/, '');
      if (!/^[a-f0-9]{64}$/i.test(expected || '')) {
        const manifest = await (await request(checksumUrl)).text();
        expected = manifest.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line)).find(match => match?.[2] === asset!.name)?.[1];
      }
      if (!expected) throw Error('无法获取安装包校验值');
      const response = await request(asset.browser_download_url);
      if (!response.body) throw Error('安装包下载响应为空');
      const handle = await fs.open(partial, 'w');
      const hash = createHash('sha256');
      let received = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          received += chunk.length;
          if (received > asset.size) throw Error('安装包大小与发布信息不一致');
          hash.update(chunk);
          await handle.writeFile(chunk);
          state = { ...state, downloaded: received, progress: Math.min(99, Math.floor(received / asset.size * 100)) };
        }
      } finally { await reader.cancel().catch(() => {}); await handle.close(); }
      if (received !== asset.size || hash.digest('hex').toLowerCase() !== expected.toLowerCase()) throw Error('安装包校验失败，请重新下载');
      const handleMagic = await fs.open(partial, 'r');
      try {
        const magic = Buffer.alloc(2);
        await handleMagic.read(magic, 0, 2, 0);
        if (magic.toString() !== 'MZ') throw Error('下载文件不是 Windows 安装包');
      } finally { await handleMagic.close(); }
      await fs.rename(partial, target);
      installer = target;
      state = { ...state, phase: 'ready', progress: 100 };
    } catch (error) { await fs.rm(partial, { force: true }).catch(() => {}); fail(error); }
    finally { busy = false; }
    return state;
  });

  ipcMain.handle('update:install', async () => {
    if (busy || state.phase !== 'ready' || !installer) return state;
    busy = true;
    state = { ...state, phase: 'installing' };
    try {
      const child = spawn(installer, [], { detached: true, stdio: 'ignore', windowsHide: true });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      setTimeout(() => app.quit(), 300);
    } catch (error) { state = { ...state, phase: 'ready', error: error instanceof Error ? error.message : String(error) }; }
    finally { busy = false; }
    return state;
  });
}
