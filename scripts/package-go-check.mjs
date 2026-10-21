// Exercise the actual NSIS cleanup/install/uninstall in isolated directories.
// SANDBOX_DIR compiles out every registry and shortcut mutation.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, stat, symlink } from 'node:fs/promises';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { legacyRuntimeFiles, cleanupInclude, findNSIS, sha256 } from './package-mygo.mjs';
import { prepareReleaseVersion, verifyReleaseVersion } from './release-version.mjs';

const root = path.resolve(process.cwd());
const temp = await mkdtemp(path.join(os.tmpdir(), 'reqflow-go-install-check-'));
const version = '2.0.0';
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: temp, windowsHide: true, encoding: 'utf8', timeout: 120000, ...options });
  if (result.error || result.status !== 0) throw Error(`${command}: ${result.error?.message || result.stderr || result.stdout} (exit ${result.status})`);
  return result;
}
async function put(base, name, value = 'fixture') {
  const target = path.join(base, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value);
}
async function exists(file) { return !!(await stat(file).catch(() => null)); }
try {
  const sourceDir = path.join(temp, 'source');
  await mkdir(sourceDir);
  await put(sourceDir, 'go.mod', 'module installer/fixture\n\ngo 1.27.1\n');
  await put(sourceDir, 'main.go', 'package main\nimport "time"\nfunc main(){time.Sleep(time.Hour)}\n');
  const resourceJSON = path.join(sourceDir, 'version.json');
  await writeFile(resourceJSON, JSON.stringify({ RT_VERSION: { '#1': { '0000': { fixed: { file_version: '2.0.0.0', product_version: '2.0.0.0' },
    info: { '0409': { ProductVersion: version, FileVersion: version, ProductName: 'ReqFlow' } } } } } }));
  run('go', ['run', 'github.com/tc-hib/go-winres@v0.3.3', 'make', '--in', resourceJSON, '--out', path.join(sourceDir, 'rsrc'), '--arch', 'amd64'], { cwd: sourceDir });
  const app = path.join(sourceDir, 'ReqFlow.exe');
  run('go', ['build', '-o', app, '.'], { cwd: sourceDir });
  const infoFile = path.join(sourceDir, 'build-info.json');
  const appHash = await sha256(app);
  await writeFile(infoFile, JSON.stringify({ version, backend: 'go', runtime: 'mygo', executable: 'ReqFlow.exe', sha256: appHash }));
  const include = path.join(temp, 'cleanup.nsh');
  const text = cleanupInclude();
  assert.ok(!/RMDir\s+\/r|Delete\s+[^\r\n]*\*/i.test(text), 'No recursive deletes or wildcards');
  await writeFile(include, text);
  const nsis = await findNSIS();
  async function installer(directory, name, sandbox = true) {
    const setup = path.join(temp, name + '.exe');
    run(nsis, ['/V2', '/INPUTCHARSET', 'UTF8', '/DAPP_VERSION=2.0.0', '/DAPP_FILE_VERSION=2.0.0.0', `/DAPP_SOURCE=${app}`,
      `/DAPP_BUILD_INFO=${infoFile}`, `/DAPP_ICON=${path.join(root, 'build/icon.ico')}`, `/DAPP_OUTPUT=${setup}`,
      `/DLEGACY_CLEANUP_INCLUDE=${include}`, ...(sandbox ? [`/DSANDBOX_DIR=${directory}`] : []), path.join(root, 'build/installer-go.nsi')]);
    return setup;
  }
  const install = path.join(temp, 'old install');
  const dataDir = path.join(install, 'data');
  const sentinelFiles = ['data/workspace.json', 'data/requirements.sqlite', 'data/ai-settings.json',
    'data/images/image.png', 'AppData/Roaming/ReqFlow/ai-settings.json', 'profile/Local State',
    'LocalState/preferences', 'resources/custom-user.json', 'locales/custom.pak', 'runtime/user-document.json'];
  for (const name of legacyRuntimeFiles) await put(install, name, 'old runtime');
  for (const name of sentinelFiles) await put(install, name, 'DO NOT DELETE ' + name);
  const cfg = Buffer.concat([Buffer.from([255, 254]), Buffer.from(dataDir + '\r\n', 'utf16le')]);
  await put(install, 'data-dir.cfg', cfg);
  const setup = await installer(install, 'setup');
  // Compile the real registry/shortcut branch without executing it.
  await installer(install, 'setup-production-compile-only', false);
  run(setup, ['/S', `/D=${install}`]);
  for (const name of legacyRuntimeFiles) assert.equal(await exists(path.join(install, name)), false, 'Removed ' + name);
  for (const name of sentinelFiles) assert.equal(await readFile(path.join(install, name), 'utf8'), 'DO NOT DELETE ' + name, 'Preserved ' + name);
  assert.deepEqual(await readFile(path.join(install, 'data-dir.cfg')), cfg, 'UTF-16 legacy data-dir.cfg is unchanged');
  assert.equal(await sha256(path.join(install, 'ReqFlow.exe')), appHash);
  console.log('PASS: actual silent NSIS upgrade replaces app, clears explicit Electron/Node files, preserves SQLite/JSON/images/AI/profile/LocalState/custom files and UTF-16 data marker');

  const protectedInstall = path.join(temp, 'protected install');
  await put(protectedInstall, 'runtime/node.exe', 'user data in selected directory');
  await put(protectedInstall, 'data-dir.cfg', Buffer.concat([Buffer.from([255, 254]), Buffer.from(path.join(protectedInstall, 'runtime'), 'utf16le')]));
  const protectedSetup = await installer(protectedInstall, 'protected-setup');
  run(protectedSetup, ['/S', `/D=${protectedInstall}`]);
  assert.equal(await readFile(path.join(protectedInstall, 'runtime/node.exe'), 'utf8'), 'user data in selected directory');

  const junctionInstall = path.join(temp, 'junction install');
  const outside = path.join(temp, 'outside data');
  await mkdir(junctionInstall);
  await put(outside, 'app.asar', 'JUNCTION TARGET USER DATA');
  await symlink(outside, path.join(junctionInstall, 'resources'), 'junction');
  const junctionSetup = await installer(junctionInstall, 'junction-setup');
  run(junctionSetup, ['/S', `/D=${junctionInstall}`]);
  assert.equal(await readFile(path.join(outside, 'app.asar'), 'utf8'), 'JUNCTION TARGET USER DATA');
  console.log('PASS: cleanup respects selected data directory and does not follow junctions');

  const running = spawn(path.join(install, 'ReqFlow.exe'), [], { windowsHide: true, stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 500));
  try {
    const locked = spawnSync(setup, ['/S', `/D=${install}`], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert.equal(locked.status, 2, 'Upgrade refuses a running executable');
    assert.equal(await sha256(path.join(install, 'ReqFlow.exe')), appHash);
  } finally { running.kill(); await new Promise(resolve => running.once('exit', resolve)); }
  console.log('PASS: running app blocks silent upgrade without terminating it or deleting files');

  // REQ-129: the wizard's close-and-continue helpers terminate the process that
  // matches the install path exactly, then wait for the executable to unlock.
  const harnessNsi = path.join(temp, 'close-harness.nsi');
  const harnessExe = path.join(temp, 'close-harness.exe');
  const closeReport = path.join(temp, 'close-report.txt');
  const victim = path.join(install, 'ReqFlow.exe');
  await writeFile(harnessNsi, `Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${harnessExe}"
!include "${path.join(root, 'build/close-app.nsh')}"
Function .onInit
  FileOpen $9 "${closeReport}" w
  Push "${victim}"
  Call KillAppProcesses
  FileWrite $9 "killed=$AppKillCount$\\r$\\n"
  Push "${victim}"
  Call WaitAppWritable
  FileWrite $9 "writable=$AppWritable$\\r$\\n"
  FileClose $9
  Quit
FunctionEnd
Section ""
SectionEnd
`, 'utf8');
  run(nsis, ['/V2', '/INPUTCHARSET', 'UTF8', harnessNsi]);
  const otherDir = path.join(temp, 'same name elsewhere');
  await mkdir(otherDir);
  await copyFile(victim, path.join(otherDir, 'ReqFlow.exe'));
  const closing = spawn(victim, [], { windowsHide: true, stdio: 'ignore' });
  const untouched = spawn(path.join(otherDir, 'ReqFlow.exe'), [], { windowsHide: true, stdio: 'ignore' });
  const closed_ = child => new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  await new Promise(resolve => setTimeout(resolve, 500));
  try {
    // .onInit exits (Quit) surface as NSIS cancel code 2; the report file is the real verdict.
    const closed = spawnSync(harnessExe, [], { windowsHide: true, timeout: 60000 });
    assert.ok(!closed.error && [0, 2].includes(closed.status), `close harness exited ${closed.status}`);
    assert.equal(await readFile(closeReport, 'utf8'), 'killed=1\r\nwritable=1\r\n');
    await closed_(closing);
    assert.equal(untouched.exitCode, null, 'Same image name outside the install directory stays alive');
  } finally {
    closing.kill(); untouched.kill();
    await Promise.all([closing, untouched].map(closed_));
  }
  console.log('PASS: wizard close helpers terminate the path-matched running app, wait for unlock and leave other directories alone');

  const fixtureRoot = path.join(temp, 'release fixture');
  await put(fixtureRoot, 'package.json', JSON.stringify({ version }));
  await put(fixtureRoot, 'package-lock.json', JSON.stringify({ version: '1.11.8', packages: { '': { version: '1.11.8' }, 'node_modules/fixture': { version: '9.0.0' } } }));
  prepareReleaseVersion(fixtureRoot);
  assert.equal(JSON.parse(await readFile(path.join(fixtureRoot, 'package-lock.json'))).packages['node_modules/fixture'].version, '9.0.0');
  const releaseDir = path.join(fixtureRoot, 'release');
  await mkdir(path.join(releaseDir, 'win-unpacked'), { recursive: true });
  await copyFile(app, path.join(releaseDir, 'win-unpacked/ReqFlow.exe'));
  await copyFile(infoFile, path.join(releaseDir, 'win-unpacked/build-info.json'));
  await copyFile(setup, path.join(releaseDir, `ReqFlow-Setup-${version}.exe`));
  const assets = {};
  for (const kind of ['Setup']) {
    const name = `ReqFlow-${kind}-${version}.exe`;
    assets[name] = { sha256: await sha256(path.join(releaseDir, name)), size: (await stat(path.join(releaseDir, name))).size };
  }
  await put(releaseDir, `packaging-manifest-${version}.json`, JSON.stringify({ version, backend: 'go', runtime: 'mygo', executable: { path: 'win-unpacked/ReqFlow.exe', sha256: appHash }, assets, cleanup: { mode: 'explicit-files-only', recursiveDelete: false, preservesData: true } }));
  assert.equal(await verifyReleaseVersion(fixtureRoot, version), version);
  // A stale portable file is ignored; only the installer is a release asset.
  await put(releaseDir, `ReqFlow-Portable-${version}.exe`, 'stale portable');
  assert.equal(await verifyReleaseVersion(fixtureRoot, version), version);
  await put(releaseDir, `ReqFlow-Setup-${version}.exe`, 'MZ OLD ELECTRON ARTIFACT');
  await assert.rejects(verifyReleaseVersion(fixtureRoot, version), /产物与打包清单不一致/);
  await copyFile(setup, path.join(releaseDir, `ReqFlow-Setup-${version}.exe`));
  await put(releaseDir, 'win-unpacked/resources/app.asar', 'old Electron');
  await assert.rejects(verifyReleaseVersion(fixtureRoot, version), /多余运行库/);
  console.log('PASS: PE product versions match 2.0.0; Go manifest/hash checks reject substituted Electron assets and stale runtime directories');

  // _?= keeps the uninstaller in place and makes the test wait for real completion.
  run(path.join(install, 'Uninstall ReqFlow.exe'), ['/S', `_?=${install}`]);
  for (const name of sentinelFiles) assert.ok(await exists(path.join(install, name)), 'Uninstall preserves ' + name);
  assert.deepEqual(await readFile(path.join(install, 'data-dir.cfg')), cfg);
  console.log('PASS: actual silent uninstaller retains user data and data-dir.cfg');
} finally {
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive: true, force: true });
}
