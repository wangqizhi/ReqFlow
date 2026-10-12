import { app, ipcMain, net, shell } from 'electron';
import { createReadStream } from 'node:fs';
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
  let expectedHash = '';
  const directory = path.join(app.getPath('userData'), 'updates');
  const metadataFile = path.join(directory, 'downloaded.json');
  const errorText = (error: any) => {
    const details = [error?.message, error?.cause?.code, error?.cause?.message].filter(Boolean).join('；') || String(error);
    return /fetch failed|ERR_|timeout|aborted/i.test(details) ? `连接 GitHub 失败，请检查网络或系统代理后重试（${details}）` : details;
  };
  const fail = (error: unknown, retry: 'check' | 'download') => { state = { ...state, phase: 'error', error: errorText(error), retry }; };
  const request = async (url: string, timeout = 10 * 60 * 1000) => {
    // Chromium 的网络栈遵循 Windows 系统代理；Node fetch 不使用该配置。
    const response = await net.fetch(url, { headers: { 'User-Agent': 'ReqFlow', Accept: url.includes('api.github.com') ? 'application/vnd.github+json' : '*/*' }, cache: 'no-store', signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw Error(`GitHub 请求失败（HTTP ${response.status}），请稍后重试`);
    return response;
  };
  const trustedUrl = (url: string) => url.startsWith(`https://github.com/${repository}/releases/download/`);
  const validAsset = (value: Asset | undefined, version: string) => value && value.name === `ReqFlow-Setup-${version}.exe` && typeof value.browser_download_url === 'string' && trustedUrl(value.browser_download_url) && Number.isSafeInteger(value.size) && value.size > 0;
  const validInstaller = async (file: string, info: Asset, hash: string) => {
    if (!/^[a-f0-9]{64}$/i.test(hash)) return false;
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size !== info.size) return false;
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    return digest.digest('hex').toLowerCase() === hash.toLowerCase();
  };
  const restoreDownload = async () => {
    try {
      const saved = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
      if (typeof saved.version !== 'string' || !newerVersion(saved.version, app.getVersion()) || !validAsset(saved.asset, saved.version) || typeof saved.hash !== 'string') return false;
      const target = path.join(directory, saved.asset.name);
      if (!await validInstaller(target, saved.asset, saved.hash)) return false;
      asset = saved.asset;
      expectedHash = saved.hash;
      installer = target;
      state = { phase: 'ready', version: saved.version, progress: 100 };
      return true;
    } catch { return false; }
  };

  ipcMain.handle('update:state', () => state);
  ipcMain.handle('update:check', async () => {
    if (busy || state.phase === 'ready' || state.phase === 'installing') return state;
    busy = true;
    state = { phase: 'checking' };
    asset = undefined;
    try {
      if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('在线安装目前支持 Windows x64');
      // 优先恢复已校验的本地安装包，网络中断也可继续安装。
      if (await restoreDownload()) return state;
      const response = await request(`https://api.github.com/repos/${repository}/releases/latest`, 30000);
      const release = await response.json();
      if (typeof release.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name) || release.draft || release.prerelease) throw Error('发布版本信息无效');
      const version = release.tag_name.replace(/^v/, '');
      if (!newerVersion(version, app.getVersion())) { state = { phase: 'latest', version: app.getVersion() }; return state; }
      asset = release.assets?.find((entry: Asset) => entry.name === `ReqFlow-Setup-${version}.exe`);
      const checksum: Asset | undefined = release.assets?.find((entry: Asset) => entry.name === `SHA256SUMS-${version}.txt`);
      if (!validAsset(asset, version)) throw Error('新版本缺少有效的 Windows 安装包');
      checksumUrl = checksum && trustedUrl(checksum.browser_download_url) ? checksum.browser_download_url : '';
      if (!/^sha256:[a-f0-9]{64}$/i.test(asset!.digest || '') && !checksumUrl) throw Error('新版本缺少 SHA256 校验信息');
      state = { phase: 'available', version };
      expectedHash = asset!.digest?.replace(/^sha256:/i, '') || '';
      const target = path.join(directory, asset!.name);
      // 兼容旧版本已经下载完、但尚未保存元数据的安装包。
      if (await validInstaller(target, asset!, expectedHash)) {
        installer = target;
        await fs.writeFile(metadataFile, JSON.stringify({ version, asset, hash: expectedHash }), 'utf8');
        state = { phase: 'ready', version, progress: 100 };
      }
    } catch (error) { fail(error, 'check'); }
    finally { busy = false; }
    return state;
  });

  ipcMain.handle('update:download', async () => {
    if (busy || !asset || !['available', 'error'].includes(state.phase)) return state;
    busy = true;
    state = { phase: 'downloading', version: state.version, progress: 0, downloaded: 0, total: asset.size };
    const target = path.join(directory, asset.name);
    const partial = target + '.part';
    try {
      await fs.mkdir(directory, { recursive: true });
      let expected = asset.digest?.replace(/^sha256:/i, '');
      if (!/^[a-f0-9]{64}$/i.test(expected || '')) {
        const manifest = await (await request(checksumUrl)).text();
        expected = manifest.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line)).find(match => match?.[2] === asset!.name)?.[1];
      }
      if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) throw Error('无法获取安装包校验值');
      if (await validInstaller(target, asset, expected)) {
        installer = target;
        expectedHash = expected;
        await fs.writeFile(metadataFile, JSON.stringify({ version: state.version, asset, hash: expected }), 'utf8');
        state = { ...state, phase: 'ready', progress: 100 };
        return state;
      }
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
      expectedHash = expected;
      await fs.writeFile(metadataFile, JSON.stringify({ version: state.version, asset, hash: expected }), 'utf8');
      state = { ...state, phase: 'ready', progress: 100 };
    } catch (error) { await fs.rm(partial, { force: true }).catch(() => {}); fail(error, 'download'); }
    finally { busy = false; }
    return state;
  });

  ipcMain.handle('update:install', async () => {
    if (busy || state.phase !== 'ready' || !installer) return state;
    busy = true;
    state = { ...state, phase: 'installing', error: undefined };
    try {
      if (!asset || !await validInstaller(installer, asset, expectedHash)) {
        installer = '';
        await fs.rm(metadataFile, { force: true });
        throw Error('本地安装包已丢失或校验失败，请重新下载');
      }
      // ShellExecute 交给 Windows 打开安装向导，支持 UAC 提权且不隐藏窗口。
      const launchError = await shell.openPath(installer);
      if (launchError) throw Error(`无法启动安装向导：${launchError}。安装包位于 ${installer}`);
      setTimeout(() => app.quit(), 300);
    } catch (error) {
      if (installer) state = { ...state, phase: 'ready', error: errorText(error) };
      else fail(error, 'download');
    }
    finally { busy = false; }
    return state;
  });
}
