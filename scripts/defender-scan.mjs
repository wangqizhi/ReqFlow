// Scan the exact release bytes; a successful build is not an antivirus verdict.
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function assertCleanScan(result, file) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  // With -DisableRemediation a detected threat is never a successful cleanup.
  // Require an explicit clean verdict as well: exclusions/unknown output fail closed.
  if (result.error || result.status !== 0 || !/found no threats\./i.test(output) ||
      /found\s+[1-9]\d*\s+threats?|LIST OF DETECTED THREATS/i.test(output)) {
    throw Error(`Defender 检查未通过：${file}\n${result.error?.message || output.trim() || `退出码 ${result.status}`}\n停止打包/发布；请检查检测记录，不要添加排除项。`);
  }
}

export async function scanReleaseFiles(files) {
  if (process.platform !== 'win32') throw Error('Windows 发布产物必须在启用 Defender 的 Windows 主机上检查');
  const command = String.raw`
$ErrorActionPreference = 'Stop'
$s = Get-MpComputerStatus
if (-not $s.AntivirusEnabled -or -not $s.RealTimeProtectionEnabled) {
  throw 'Defender protection is not active'
}
$platform = Join-Path $env:ProgramData 'Microsoft\Windows Defender\Platform'
$exe = Get-ChildItem -LiteralPath $platform -Directory |
  Where-Object Name -Match '^\d+\.' |
  Sort-Object { [version]($_.Name -replace '-.*$','') } -Descending |
  ForEach-Object { Join-Path $_.FullName 'MpCmdRun.exe' } |
  Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $exe) { $exe = Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe' }
if (-not (Test-Path -LiteralPath $exe)) { throw 'MpCmdRun.exe not found' }
@{ executable=$exe; engine=$s.AMEngineVersion; signatures=$s.AntivirusSignatureVersion } |
  ConvertTo-Json -Compress
`;
  const status = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  if (status.error || status.status !== 0) throw Error(`无法检查 Defender：${status.error?.message || status.stderr?.trim()}；停止打包/发布`);
  const defender = JSON.parse(status.stdout.trim());
  const results = [];
  for (const input of files) {
    const file = path.resolve(input);
    if (!(await stat(file)).isFile()) throw Error(`扫描目标不是文件：${file}`);
    const hash = async () => createHash('sha256').update(await readFile(file)).digest('hex');
    const before = await hash();
    console.log(`Defender 扫描：${file}`);
    const scan = spawnSync(defender.executable, ['-Scan', '-ScanType', '3', '-File', file, '-DisableRemediation'],
      { windowsHide: true, encoding: 'utf8', timeout: 300000 });
    assertCleanScan(scan, file);
    if (await hash() !== before) throw Error(`扫描期间文件发生变化：${file}`);
    results.push({ file, sha256: before, checkedAt: new Date().toISOString(), engine: defender.engine, signatures: defender.signatures });
    console.log(`Defender 通过：${path.basename(file)} / ${before}`);
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  const files = process.argv.slice(2);
  scanReleaseFiles(files.length ? files : [path.join(root, 'release/win-unpacked/ReqFlow.exe'),
    path.join(root, 'release', `ReqFlow-Setup-${version}.exe`)])
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
