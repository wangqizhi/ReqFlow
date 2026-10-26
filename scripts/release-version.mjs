import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { serverBinaryDefines } from './package-mygo.mjs';

const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

export function prepareReleaseVersion(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!versionPattern.test(pkg.version)) throw Error('package.json 版本必须为 x.y.z 或 x.y.z-预发布版本');
  const lockPath = path.join(root, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (!lock.packages?.['']) throw Error('package-lock.json 缺少根包信息，请先运行 npm install');
  if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version) {
    lock.version = pkg.version;
    lock.packages[''].version = pkg.version;
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  }
  return pkg.version;
}

export async function verifyReleaseVersion(root, version) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  if (pkg.version !== version || lock.version !== version || lock.packages?.['']?.version !== version) {
    throw Error('发布版本与 package.json / package-lock.json 不一致，请先运行发布脚本同步并打包');
  }
  const directory = path.join(root, 'release', 'win-unpacked');
  const infoFile = path.join(directory, 'build-info.json');
  if (!existsSync(infoFile)) throw Error('缺少打包应用 Go build-info.json，请先构建打包');
  const packaged = JSON.parse(readFileSync(infoFile, 'utf8'));
  if (packaged.version !== version || packaged.backend !== 'go' || packaged.runtime !== 'mygo' || packaged.executable !== 'ReqFlow.exe') {
    throw Error('打包应用必须是版本一致的 Go/MyGO 产物；拒绝上传 Electron 或 Node 版本');
  }
  const files = readdirSync(directory).sort();
  // REQ-237：reqflow-server-linux-* 是随包分发的同步服务端二进制，允许存在；其余一律拒绝。
  const allowed = ['ReqFlow.exe', 'build-info.json', 'reqflow-server-linux-amd64', 'reqflow-server-linux-arm64'];
  if (files.some(name => !allowed.includes(name)) || !files.includes('ReqFlow.exe') || !files.includes('build-info.json')) throw Error('Go 构建目录包含多余运行库或未知文件，请重新构建');
  await serverBinaryDefines(directory, packaged);
  const digest = file => {
    const bytes = readFileSync(file);
    if (bytes.subarray(0, 2).toString() !== 'MZ') throw Error(`产物不是 Windows 可执行文件：${path.basename(file)}`);
    return createHash('sha256').update(bytes).digest('hex');
  };
  const executable = path.join(directory, 'ReqFlow.exe');
  const executableHash = digest(executable);
  if (packaged.sha256 !== executableHash) throw Error('Go 程序 SHA256 与构建信息不一致');
  const manifestFile = path.join(root, 'release', `packaging-manifest-${version}.json`);
  if (!existsSync(manifestFile)) throw Error('缺少 Go 打包清单，请运行 npm run dist');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const names = [`ReqFlow-Setup-${version}.exe`];
  if (manifest.version !== version || manifest.backend !== 'go' || manifest.runtime !== 'mygo' ||
      manifest.executable?.path !== 'win-unpacked/ReqFlow.exe' || manifest.executable?.sha256 !== executableHash ||
      JSON.stringify(manifest.serverBinaries) !== JSON.stringify(packaged.serverBinaries) ||
      JSON.stringify(Object.keys(manifest.assets || {}).sort()) !== JSON.stringify([...names].sort()) ||
      manifest.cleanup?.mode !== 'explicit-files-only' || manifest.cleanup?.recursiveDelete !== false || manifest.cleanup?.preservesData !== true) {
    throw Error('Go 打包清单与当前构建不一致；拒绝旧 Electron 产物');
  }
  for (const name of names) {
    const file = path.join(root, 'release', name);
    if (digest(file) !== manifest.assets[name].sha256 || readFileSync(file).length !== manifest.assets[name].size) throw Error(`Go 产物与打包清单不一致：${name}`);
  }
  if (process.platform === 'win32') {
    const executables = [executable, ...names.map(name => path.join(root, 'release', name))];
    const literals = executables.map(file => `'${file.replaceAll("'", "''")}'`).join(',');
    const command = `ConvertTo-Json -InputObject @(@(${literals}) | ForEach-Object { (Get-Item -LiteralPath $_ -ErrorAction Stop).VersionInfo.ProductVersion }) -Compress`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) throw Error(`无法读取安装包内部版本：${result.error?.message || result.stderr.trim()}`);
    const versions = JSON.parse(result.stdout.trim());
    if (!Array.isArray(versions) || versions.length !== executables.length || versions.some(value => value !== version && value !== `${version}.0`)) {
      throw Error(`安装版内部版本 ${JSON.stringify(versions)} 与发布版本 ${version} 不一致`);
    }
  }
  return version;
}
