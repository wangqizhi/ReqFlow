// Version negotiation with ReqFlow's embedded catalog. Host caches are never edited.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = files => createHash('sha256').update(JSON.stringify(Object.fromEntries(
  Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))).digest('hex');
const manifests = { codex: 'plugin.json', zcode: '.zcode-plugin/plugin.json', pi: 'package.json' };

export async function runHost(command, args) {
  const options = { windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 };
  // PowerShell argument literals avoid cmd metacharacter interpretation for paths.
  const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
  let exe = command, argv = args;
  if (process.platform === 'win32') {
    const script = '& ' + [command, ...args].map(literal).join(' ') + '; if (!$?) { exit 1 }; if ($LASTEXITCODE) { exit $LASTEXITCODE }';
    exe = 'powershell.exe';
    argv = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  }
  return new Promise((resolve, reject) => execFile(exe, argv, options, (error, stdout, stderr) => {
    if (error) reject(Error(`宿主插件更新失败：${stderr?.trim() || error.message}`));
    else resolve(stdout);
  }));
}

export async function ensurePlugin(config, info, host, callCli, options = {}) {
  if (!manifests[host]) throw Error('未知插件宿主');
  if (!info.capabilities?.includes('plugin-release-v1')) {
    throw Error('ReqFlow 不支持插件版本查询，请先安装 ReqFlow 2.2.3 或更新版本；未领取或回写需求。');
  }
  const source = options.root || root;
  const installed = JSON.parse(await fs.readFile(path.join(source, manifests[host]), 'utf8'));
  const release = await callCli(config, ['plugin', 'version', '--host', host, '--plugin-version', installed.version]);
  if (!release.updateAvailable) return { updated: false, version: installed.version, latestVersion: release.version };
  const bundle = await callCli(config, ['plugin', 'bundle', '--host', host]);
  if (bundle.version !== release.version || bundle.name !== installed.name || bundle.sha256 !== release.sha256
    || !bundle.files || sha256(bundle.files) !== bundle.sha256) throw Error('插件更新包版本或 SHA256 校验失败');
  const meta = JSON.parse(bundle.files[manifests[host]] || '{}');
  if (meta.version !== release.version || meta.name !== installed.name) throw Error('插件更新包清单不匹配');
  const cache = options.updateDir || path.join(os.homedir(), `.reqflow-${host}`, 'updates');
  await fs.mkdir(cache, { recursive: true });
  const lock = path.join(cache, 'update.lock');
  const handle = await fs.open(lock, 'wx').catch(() => { throw Error('插件正在更新，请待另一会话结束后重试'); });
  try {
    const stage = await fs.mkdtemp(path.join(cache, 'release-'));
    const plugin = path.join(stage, bundle.name);
    for (const [file, content] of Object.entries(bundle.files)) {
      if (typeof content !== 'string' || !file || file.includes('\\') || file.includes(':')
        || file.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(file)) throw Error('插件更新包包含非法路径');
      const target = path.join(plugin, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, { flag: 'wx' });
    }
    const run = options.runHost || runHost;
    if (host === 'codex') {
      const marketplace = { name: 'reqflow-local', plugins: [{ name: bundle.name,
        source: { source: 'local', path: './' + bundle.name }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] };
      await fs.mkdir(path.join(stage, '.agents/plugins'), { recursive: true });
      await fs.writeFile(path.join(stage, '.agents/plugins/marketplace.json'), JSON.stringify(marketplace));
      const sources = JSON.parse(await run('codex', ['plugin', 'marketplace', 'list', '--json']));
      const previous = sources.marketplaces?.find(item => item.name === 'reqflow-local');
      if (previous) {
        const previousManifest = JSON.parse(await fs.readFile(path.join(previous.root, '.agents/plugins/marketplace.json'), 'utf8'));
        if (previousManifest.plugins?.length !== 1 || previousManifest.plugins[0].name !== bundle.name) {
          throw Error('reqflow-local 市场包含其他插件，请通过宿主更新 ReqFlow 插件；未更改市场');
        }
      }
      try {
        if (previous) await run('codex', ['plugin', 'marketplace', 'remove', 'reqflow-local', '--json']);
        await run('codex', ['plugin', 'marketplace', 'add', stage, '--json']);
        const installed = JSON.parse(await run('codex', ['plugin', 'add', `${bundle.name}@reqflow-local`, '--json']));
        if (installed.version !== release.version) throw Error('宿主安装后插件版本不一致');
      } catch (error) {
        try {
          await run('codex', ['plugin', 'marketplace', 'remove', 'reqflow-local', '--json']);
          if (previous) await run('codex', ['plugin', 'marketplace', 'add', previous.root, '--json']);
        } catch (restore) { throw Error(`${error.message}；恢复市场来源失败：${restore.message}`); }
        throw error;
      }
    } else if (host === 'pi') {
      // Older releases were installed as a local extension source, not a host cache.
      // Keep that entrypoint, or use a stable managed source so repeated updates
      // do not register a second extension package on every version.
      const direct = options.piExtensionDir || path.join(os.homedir(), '.pi/agent/extensions/reqflow');
      const legacy = await fs.stat(path.join(direct, 'index.ts')).catch(() => null);
      const destination = legacy?.isFile() ? direct : (options.piSourceDir || path.join(os.homedir(), '.reqflow-pi/plugin'));
      await fs.mkdir(destination, { recursive: true });
      if (await fs.realpath(destination) !== path.resolve(destination)) throw Error('Pi 插件源目录为链接，请通过宿主更新');
      for (const file of Object.keys(bundle.files).sort((a, b) => Number(a === manifests.pi) - Number(b === manifests.pi))) {
        const target = path.join(destination, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        if (await fs.realpath(path.dirname(target)) !== path.resolve(path.dirname(target))) throw Error('Pi 插件子目录为链接，请通过宿主更新');
        const temporary = target + '.reqflow-update';
        await fs.writeFile(temporary, bundle.files[file], { flag: 'wx' });
        await fs.rename(temporary, target);
      }
      if (!legacy) await run('pi', ['install', destination]);
    } else {
      const adapter = config.pluginUpdater;
      if (adapter?.executable && Array.isArray(adapter.args) && adapter.args.includes('{pluginDir}')) {
        await run(adapter.executable, adapter.args.map(arg => arg === '{pluginDir}' ? plugin : arg));
      } else {
        const candidates = [config.zcodeCli, process.env.REQFLOW_ZCODE_CLI,
          process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/ZCode/resources/glm/zcode.cjs')].filter(Boolean);
        let cli;
        for (const file of candidates) if ((await fs.stat(file).catch(() => null))?.isFile()) { cli = file; break; }
        if (!cli) return { updated: false, updateRequired: true, host, installedVersion: installed.version,
          latestVersion: release.version, pluginDir: plugin,
          instruction: '未找到 ZCode 附带的 CLI，请设置 REQFLOW_ZCODE_CLI 或配置 zcodeCli 为 resources/glm/zcode.cjs 的实际路径后重试。未领取或回写需求。' };
        const zcode = args => run(process.execPath, [cli, 'plugins', ...args]);
        const installed = JSON.parse(await zcode(['list', '--json']));
        const current = installed.find(item => item.name === bundle.name);
        const marketName = current?.marketplace || 'dev-reqflow-0621a305';
        const sources = JSON.parse(await zcode(['marketplace', 'list', '--json']));
        const previous = sources.find(item => item.name === marketName);
        if (previous && (previous.isOfficial || previous.pluginCount !== 1 || previous.source?.source !== 'directory')) {
          throw Error('ZCode ReqFlow 市场不是独立本地市场，请配置受支持的 pluginUpdater；未更改市场');
        }
        await fs.writeFile(path.join(stage, 'marketplace.json'), JSON.stringify({ name: marketName,
          plugins: [{ name: bundle.name, source: './' + bundle.name, version: release.version }] }));
        try {
          if (previous) await zcode(['marketplace', 'remove', marketName]);
          await zcode(['marketplace', 'add', stage]);
          await zcode([current ? 'update' : 'install', `${bundle.name}@${marketName}`]);
          const after = JSON.parse(await zcode(['list', '--json']));
          if (after.find(item => item.name === bundle.name && item.marketplace === marketName)?.version !== release.version) {
            throw Error('ZCode 安装后插件版本不一致');
          }
        } catch (error) {
          try {
            await zcode(['marketplace', 'remove', marketName]);
            if (previous) await zcode(['marketplace', 'add', previous.source.path]);
          } catch (restore) { throw Error(`${error.message}；恢复市场来源失败：${restore.message}`); }
          throw error;
        }
      }
    }
    return { updated: true, version: release.version, pluginDir: plugin, reloadRequired: true };
  } finally {
    await handle.close();
    await fs.unlink(lock);
  }
}
