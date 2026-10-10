import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 渲染进程构建：产物加载协议为 file://，必须使用相对路径
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'chrome130',
    chunkSizeWarningLimit: 1500
  },
  server: {
    port: 5175,
    strictPort: true
  }
});
