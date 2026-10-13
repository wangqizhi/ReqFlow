import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(program, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error(`${program} exited ${code}`)));
  });
}
if (!(await stat(path.join(root, 'src/mygo/frontend/index.html')).catch(() => null))) {
  await run(process.execPath, [path.join(root, 'scripts/build-mygo.mjs')], root);
}
await run('go', ['test', './...'], path.join(root, 'src/mygo'));
await run('go', ['vet', './...'], path.join(root, 'src/mygo'));
