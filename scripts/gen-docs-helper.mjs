// 把 src/core/cli-help.ts 渲染为 docs/cli-reference.md。
// 通过 esbuild 临时打包消除「node 无法直接 import TS」的问题。

import { build } from 'esbuild';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function renderCliDocsMarkdown(root) {
  const dir = await mkdtemp(path.join(tmpdir(), 'reqflow-docs-'));
  try {
    const entry = path.join(dir, 'entry.mjs');
    await writeFile(entry, `export { CLI_DOCS, CLI_GLOBAL_OPTIONS, CLI_NOTES, CLI_USAGE } from ${JSON.stringify(
      path.join(root, 'src/core/cli-help.ts').replaceAll('\\\\', '\\\\')
    )};`);
    const out = path.join(dir, 'bundle.mjs');
    await build({
      entryPoints: [entry],
      outfile: out,
      bundle: true,
      format: 'esm',
      platform: 'node',
      minify: false,
      logLevel: 'silent'
    });
    const mod = await import('file://' + out.replaceAll('\\', '/'));
    const { CLI_DOCS, CLI_GLOBAL_OPTIONS, CLI_NOTES, CLI_USAGE } = mod;
    const help = JSON.stringify({ usage: CLI_USAGE, options: CLI_GLOBAL_OPTIONS, groups: CLI_DOCS, notes: CLI_NOTES });
    await writeFile(path.join(root, 'src/mygo/backendgo/cli_help_generated.go'),
      '// Code generated from src/core/cli-help.ts by scripts/gen-docs-helper.mjs. DO NOT EDIT.\npackage backendgo\n\nconst coreCLIHelpJSON = ' + JSON.stringify(help) + '\n', 'utf8');

    const lines = [];
    lines.push('# ReqFlow CLI 参考（Agent 对接指南）');
    lines.push('');
    lines.push('> 本文档由 `src/core/cli-help.ts` 生成（`npm run build` 时自动更新），与 `ReqFlow.exe --cli help` 输出、应用内「帮助 · CLI 参考」页面同源一致。');
    lines.push('');
    lines.push('## 用法');
    lines.push('');
    lines.push('```sh');
    lines.push(CLI_USAGE);
    lines.push('```');
    lines.push('');
    lines.push('所有命令输出单行 JSON：成功 `{"ok":true,...}`，失败 `{"ok":false,"error":"..."}`；退出码 0/1。');
    lines.push('');
    lines.push('## 全局选项');
    lines.push('');
    lines.push('| 选项 | 说明 |');
    lines.push('| --- | --- |');
    for (const o of CLI_GLOBAL_OPTIONS) lines.push('| `' + o.name + '` | ' + o.desc + ' |');
    for (const g of CLI_DOCS) {
      lines.push('');
      lines.push('## ' + g.group);
      lines.push('');
      lines.push(g.desc);
      lines.push('');
      lines.push('| 命令 | 参数 | 说明 |');
      lines.push('| --- | --- | --- |');
      for (const c of g.commands) {
        lines.push('| `' + c.name + '` | `' + c.args + '` | ' + c.desc + (c.example ? '<br/>例：`' + c.example + '`' : '') + ' |');
      }
    }
    lines.push('');
    lines.push('## 说明');
    lines.push('');
    for (const n of CLI_NOTES) lines.push('- ' + n);
    lines.push('');
    lines.push('## 典型 Agent 工作流');
    lines.push('');
    lines.push('```text');
    lines.push('project list');
    lines.push('→ item add（若干条）→ item list 取需求 id');
    lines.push('→ generate --items id1,id2 → batch show 取 Prompt 全文交给模型');
    lines.push('→ submit →（模型实现完成后）complete');
    lines.push('→ verify --pass true|false（未通过原因自动带入下一轮 Prompt）');
    lines.push('```');
    lines.push('');
    return lines.join('\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
