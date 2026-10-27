import assert from 'node:assert/strict';
import { assertCleanScan } from './defender-scan.mjs';

const clean = { status: 0, stdout: 'Scan starting...\nScan finished.\nScanning app.exe found no threats.' };
assert.doesNotThrow(() => assertCleanScan(clean, 'app.exe'));
for (const result of [
  { status: 2, stdout: 'Scanning app.exe found 1 threats. Trojan:Win32/Bearfoos.B!ml' },
  { status: 0, stdout: 'Scanning app.exe found 1 threats.' },
  { status: 0, stdout: 'File excluded from scanning' },
  { status: 0, stdout: '' },
  { ...clean, status: 2 },
  { ...clean, error: new Error('scan timed out') },
  { ...clean, stderr: 'LIST OF DETECTED THREATS' },
]) assert.throws(() => assertCleanScan(result, 'app.exe'), /Defender 检查未通过/);
console.log('PASS: clean scans pass; threats, exclusions, missing verdicts, errors and timeouts block release');
