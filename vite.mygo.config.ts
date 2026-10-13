import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { build } from 'esbuild';

export default defineConfig(async () => {
  const bootstrap = await build({
    entryPoints: ['src/mygo/preload/index.ts'], bundle: true, write: false,
    format: 'iife', platform: 'browser', target: 'chrome110', minify: true,
  });
  return {
    root: 'src/renderer', base: './',
    plugins: [react(), {
      name: 'reqflow-mygo-preload',
      transformIndexHtml: {
        order: 'post',
        handler(html: string) {
          return html.replace('<head>', '<head><script src="./mygo-preload.js"></script>');
        }
      },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'mygo-preload.js', source: bootstrap.outputFiles[0].text });
      },
      transform(code: string, id: string) {
        if (!id.endsWith('.css')) return;
        return code.replace(/-webkit-app-region:\s*(drag|no-drag);/g, '$& --app-region: $1;');
      }
    }],
    build: {
      outDir: '../../dist/mygo/renderer', emptyOutDir: true,
      target: 'chrome110', chunkSizeWarningLimit: 1500
    }
  };
});
