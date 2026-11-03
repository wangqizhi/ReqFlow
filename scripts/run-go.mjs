import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scanReleaseFiles } from './defender-scan.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(root, 'release/win-unpacked/ReqFlow.exe');
if (!(await stat(executable).catch(() => null))?.isFile()) throw Error('请先运行 npm run build 生成 ReqFlow Go 程序');
// Recheck GUI launches against current signatures; packaging scans can become stale.
// CLI calls remain lightweight and are protected by Defender real-time protection.
if (!process.argv.slice(2).includes('--cli')) await scanReleaseFiles([executable]);
const child = spawn(executable, process.argv.slice(2), { cwd: root, stdio: 'inherit', windowsHide: true });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
