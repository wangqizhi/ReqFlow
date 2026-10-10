// 开发模式：启动 vite dev server，然后以开发 URL 启动 Electron。

import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(process.cwd());
const server = await createServer({ configFile: path.join(root, 'vite.config.ts'), root: path.join(root, 'src/renderer') });
await server.listen();

const electron = spawn(process.platform === 'win32' ? 'node_modules\\.bin\\electron.cmd' : 'node_modules/.bin/electron', ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, REQFLOW_RENDERER_URL: 'http://localhost:5175' }
});
electron.on('exit', (code) => {
  server.close();
  process.exit(code ?? 0);
});
