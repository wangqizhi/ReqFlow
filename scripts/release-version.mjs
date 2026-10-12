import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

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
  const archive = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar');
  if (!existsSync(archive)) throw Error('缺少打包应用 app.asar，请先构建打包');
  const { extractFile } = await import('@electron/asar');
  const packaged = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  if (packaged.version !== version) throw Error(`打包应用内部版本 ${packaged.version} 与发布版本 ${version} 不一致`);
  if (process.platform === 'win32') {
    const files = ['Setup', 'Portable'].map(kind => path.join(root, 'release', `ReqFlow-${kind}-${version}.exe`));
    const literals = files.map(file => `'${file.replaceAll("'", "''")}'`).join(',');
    const command = `ConvertTo-Json -InputObject @(@(${literals}) | ForEach-Object { (Get-Item -LiteralPath $_ -ErrorAction Stop).VersionInfo.ProductVersion }) -Compress`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) throw Error(`无法读取安装包内部版本：${result.error?.message || result.stderr.trim()}`);
    const versions = JSON.parse(result.stdout.trim());
    if (!Array.isArray(versions) || versions.length !== 2 || versions.some(value => value !== version && value !== `${version}.0`)) {
      throw Error(`安装版/便携版内部版本 ${JSON.stringify(versions)} 与发布版本 ${version} 不一致`);
    }
  }
  return version;
}
