// 构建脚本：esbuild 打包主进程与 preload（CJS），vite 构建渲染进程，
// 并从 src/core/cli-help.ts 生成 docs/cli-reference.md（保持三处文档同源）。

import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { renderCliDocsMarkdown } from './gen-docs-helper.mjs';

const root = path.resolve(process.cwd());

async function main() {
  await import('./make-icon.mjs');
  console.log('[1/3] esbuild：主进程 + preload…');
  await build({
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(root, 'dist/main/index.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ['electron'],
    minify: true
  });
  await build({
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(root, 'dist/preload/index.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ['electron'],
    minify: true
  });

  console.log('[2/3] vite：渲染进程…');
  await copyFile(path.join(root, 'build/icon.ico'), path.join(root, 'dist/main/icon.ico'));
  await viteBuild({ configFile: path.join(root, 'vite.config.ts') });

  console.log('[3/3] 生成 docs/cli-reference.md…');
  const markdown = await renderCliDocsMarkdown(root);
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs/cli-reference.md'), markdown, 'utf8');

  console.log('构建完成：dist/（main / preload / renderer）+ docs/cli-reference.md');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
