// Node is a build tool only. The shipped application is a single Go executable.
import { build as viteBuild } from 'vite';
import { mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderCliDocsMarkdown } from './gen-docs-helper.mjs';
import { buildPluginBundles } from './build-plugin-bundles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const goRoot = path.join(root, 'src/mygo');
const output = path.join(root, 'release/win-unpacked');
const executable = path.join(output, 'ReqFlow.exe');
const version = pkg.version;
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw Error('Invalid application version');
if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('ReqFlow currently builds Windows x64');

function run(command, args, cwd = root, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true, env });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
function assertBuildDirectory(directory, expected) {
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.replaceAll('\\', '/') !== expected) throw Error('Invalid build directory');
}

console.log('[Go 1/3] 构建 React 界面…');
process.chdir(root);
await writeFile(path.join(root, 'docs/cli-reference.md'), await renderCliDocsMarkdown(root), 'utf8');
await buildPluginBundles(root);
await viteBuild({ configFile: path.join(root, 'vite.mygo.config.ts') });
const embedded = path.join(goRoot, 'frontend');
assertBuildDirectory(embedded, 'src/mygo/frontend');
await rm(embedded, { recursive: true, force: true });
await cp(path.join(root, 'dist/mygo/renderer'), embedded, { recursive: true });

console.log('[Go 2/3] 嵌入图标、清单、Windows 版本资源…');
const resources = path.join(goRoot, 'rsrc_windows_amd64.syso');
const config = path.join(goRoot, 'reqflow-winres.json');
const windowsVersion = `${version.split('-')[0]}.0`;
await writeFile(config, JSON.stringify({
  // MyGO's Windows notifications load the application's icon by resource ID 1.
  RT_GROUP_ICON: { '#1': { '0000': '../../build/icon.ico' } },
  RT_MANIFEST: { '#1': { '0409': '../../build/mygo.manifest' } },
  RT_VERSION: { '#1': { '0000': {
    fixed: { file_version: windowsVersion, product_version: windowsVersion },
    info: { '0409': { CompanyName: 'ReqFlow Local', FileDescription: 'ReqFlow — 需求流',
      FileVersion: version, ProductVersion: version, ProductName: 'ReqFlow',
      InternalName: 'ReqFlow', OriginalFilename: 'ReqFlow.exe', LegalCopyright: 'ReqFlow Local' } }
  } } }
}, null, 2));
await rm(path.join(goRoot, 'reqflow_windows_amd64.syso'), { force: true });
try {
  await run('go', ['run', 'github.com/tc-hib/go-winres@v0.3.3', 'make', '--in', config, '--out', path.join(goRoot, 'rsrc'), '--arch', 'amd64'], goRoot);
  console.log('[Go 3/3] 编译独立 Go 程序（内嵌界面，无 Node/Electron）…');
  assertBuildDirectory(output, 'release/win-unpacked');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await run('go', ['build', '-trimpath', '-ldflags',
    `-s -w -H windowsgui -X main.appVersion=${version} -X github.com/egoist/mygo.production=1 -X github.com/egoist/mygo.packageName=ReqFlow -X github.com/egoist/mygo.packageVersion=${version} -X github.com/egoist/mygo.packageIdentifier=com.reqflow.desktop`,
    '-o', executable, '.'], goRoot);
} finally {
  await rm(resources, { force: true });
  await rm(config, { force: true });
}
// REQ-237：同步服务端独立入口（reqflow-server）交叉编译 Linux amd64/arm64，
// 供「设置 → Server Agent → SSH 自动安装」上传到 NAS / 云主机；随安装包一起分发。
const serverBinaries = [];
for (const arch of ['amd64', 'arm64']) {
  const target = path.join(output, `reqflow-server-linux-${arch}`);
  await run('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.appVersion=${version}`, '-o', target, './server'], goRoot,
    { ...process.env, GOOS: 'linux', GOARCH: arch, CGO_ENABLED: '0' });
  const raw = await readFile(target);
  serverBinaries.push({ name: path.basename(target), sha256: createHash('sha256').update(raw).digest('hex'), size: raw.length });
}
const bytes = await readFile(executable);
await writeFile(path.join(output, 'build-info.json'), JSON.stringify({
  name: 'ReqFlow', version, backend: 'go', runtime: 'mygo', platform: 'win32-x64',
  runtimeDependencies: ['Microsoft Edge WebView2 Runtime'],
  executable: 'ReqFlow.exe', sha256: createHash('sha256').update(bytes).digest('hex'),
  serverBinaries
}, null, 2) + '\n');
console.log(`Go 程序完成：${executable} (${(bytes.length / 1024 / 1024).toFixed(1)} MiB)`);
for (const binary of serverBinaries) console.log(`同步服务端：${binary.name} (${(binary.size / 1024 / 1024).toFixed(1)} MiB)`);
