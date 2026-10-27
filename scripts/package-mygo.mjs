// Ship the verified Go desktop and Linux server executables. NSIS is a packaging tool.
import { readFile, writeFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { scanReleaseFiles } from './defender-scan.mjs';

export const legacyRuntimeFiles = [
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'chrome_elf.dll',
  'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll', 'libGLESv2.dll', 'resources.pak',
  'snapshot_blob.bin', 'v8_context_snapshot.bin', 'vk_swiftshader.dll',
  'vulkan-1.dll', 'vk_swiftshader_icd.json', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll',
  'LICENSE.electron', 'LICENSE.electron.txt', 'LICENSES.chromium.html',
  'resources/app.asar', 'resources/elevate.exe', 'resources/app-update.yml',
  'runtime/node.exe', 'dist/main/backend.cjs', 'ReqFlow-MyGO.exe',
  ...['af', 'am', 'ar', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en-GB', 'en-US',
    'es', 'es-419', 'et', 'fa', 'fi', 'fil', 'fr', 'gu', 'he', 'hi', 'hr', 'hu', 'id',
    'it', 'ja', 'kn', 'ko', 'lt', 'lv', 'ml', 'mr', 'ms', 'nb', 'nl', 'pl', 'pt-BR',
    'pt-PT', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tr', 'uk',
    'ur', 'vi', 'zh-CN', 'zh-TW'].map(locale => `locales/${locale}.pak`)
];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function sha256(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }
export async function serverBinaryDefines(directory, info) {
  const defines = [];
  for (const arch of ['amd64', 'arm64']) {
    const name = `reqflow-server-linux-${arch}`;
    const file = path.join(directory, name);
    const metadata = info.serverBinaries?.find(binary => binary.name === name);
    const details = await stat(file).catch(() => null);
    if (!details?.isFile() || !metadata || details.size !== metadata.size || await sha256(file) !== metadata.sha256) {
      throw Error(`Linux 服务端缺失或与构建信息不一致：${name}，请先 npm run build`);
    }
    defines.push(`/DAPP_SERVER_LINUX_${arch.toUpperCase()}=${file}`);
  }
  return defines;
}
export function cleanupInclude() {
  return '!macro ReqFlowCleanupLegacy\n' + legacyRuntimeFiles.map(file =>
    `  Push "$INSTDIR\\${file.replaceAll('/', '\\')}"\n  Call DeleteLegacyRuntime`).join('\n') +
    '\n  ; Only remove empty directories. Unknown files and user data stay in place.\n' +
    ['resources', 'locales', 'runtime', 'dist\\main', 'dist'].map(dir => `  Push "$INSTDIR\\${dir}"\n  Call RemoveEmptyLegacyDirectory`).join('\n') + '\n!macroend\n';
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(Error(`${command} exited ${code}`)));
  });
}
export async function findNSIS() {
  const candidates = [process.env.REQFLOW_NSIS, 'C:/Program Files (x86)/NSIS/makensis.exe',
    path.join(os.homedir(), 'AppData/Local/electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe'),
    path.join(os.homedir(), 'AppData/Local/electron-builder/Cache/nsis/nsis-3.0.4.1/makensis.exe')].filter(Boolean);
  for (const file of candidates) if ((await stat(file).catch(() => null))?.isFile()) return file;
  throw Error('需要 NSIS 3（安装 NSIS 或通过 REQFLOW_NSIS 指定 makensis.exe）；无需 Electron/electron-builder');
}
export async function packageMyGO() {
  if (process.platform !== 'win32') throw Error('Windows packaging requires Windows');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  const source = path.join(root, 'release/win-unpacked/ReqFlow.exe');
  const info = JSON.parse(await readFile(path.join(root, 'release/win-unpacked/build-info.json'), 'utf8'));
  const sourceHash = await sha256(source);
  if (info.version !== version || info.backend !== 'go' || info.runtime !== 'mygo' || info.sha256 !== sourceHash) throw Error('Go 构建信息或哈希不匹配，请先 npm run build');
  const serverDefines = await serverBinaryDefines(path.dirname(source), info);
  const executableScan = await scanReleaseFiles([source]);
  if (executableScan[0].sha256 !== sourceHash) throw Error('主程序在构建校验后发生变化，请重新构建打包');
  const release = path.join(root, 'release');
  const setupName = `ReqFlow-Setup-${version}.exe`;
  const temp = await mkdtemp(path.join(os.tmpdir(), 'reqflow-go-package-'));
  try {
    const include = path.join(temp, 'legacy-cleanup.nsh');
    await writeFile(include, cleanupInclude(), 'utf8');
    const nsis = await findNSIS();
    // REQ-237：同步服务端 Linux 二进制随安装包分发（SSH 自动安装时上传到服务器）。
    await run(nsis, ['/V2', '/INPUTCHARSET', 'UTF8', `/DAPP_VERSION=${version}`, `/DAPP_FILE_VERSION=${version.split('-')[0]}.0`,
      `/DAPP_SOURCE=${source}`, `/DAPP_BUILD_INFO=${path.join(release, 'win-unpacked/build-info.json')}`,
      `/DAPP_ICON=${path.join(root, 'build/icon.ico')}`, `/DAPP_OUTPUT=${path.join(release, setupName)}`,
      ...serverDefines,
      `/DLEGACY_CLEANUP_INCLUDE=${include}`, path.join(root, 'build/installer-go.nsi')]);
    const assets = {};
    for (const name of [setupName]) assets[name] = { sha256: await sha256(path.join(release, name)), size: (await stat(path.join(release, name))).size };
    const installerScan = await scanReleaseFiles([path.join(release, setupName)]);
    if (installerScan[0].sha256 !== assets[setupName].sha256) throw Error('安装包在校验后发生变化，请重新打包');
    await writeFile(path.join(release, `packaging-manifest-${version}.json`), JSON.stringify({
      version, backend: 'go', runtime: 'mygo', executable: { path: 'win-unpacked/ReqFlow.exe', sha256: sourceHash }, serverBinaries: info.serverBinaries, assets,
      defenderScans: [...executableScan, ...installerScan],
      cleanup: { mode: 'explicit-files-only', recursiveDelete: false, preservesData: true, files: legacyRuntimeFiles }
    }, null, 2) + '\n');
    await writeFile(path.join(release, `SHA256SUMS-${version}.txt`), Object.entries(assets).map(([name, value]) => `${value.sha256}  ${name}`).join('\n') + '\n');
    console.log(`已生成 Go 安装版：\n${path.join(release, setupName)}`);
  } finally {
    if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Invalid packaging temp directory');
    await rm(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  packageMyGO().catch(error => { console.error(error.message); process.exitCode = 1; });
}
