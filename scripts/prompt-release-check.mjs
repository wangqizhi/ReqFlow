import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(path.join(os.tmpdir(), 'reqflow-prompt-release-'));
try {
  const outfile = path.join(directory, 'domain.mjs');
  await build({ entryPoints: ['src/core/domain.ts'], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
  const { buildPrompt, makeProject, RELEASE_NOTES_GUIDANCE } = await import(pathToFileURL(outfile));
  const project = makeProject('测试项目', '项目背景');
  const item = { number: 'REQ-001', title: '普通需求', body: '修改页面', type: 'feature', priority: 'P1', criteria: [], history: [] };
  assert.ok(!buildPrompt(project, [item]).includes('## 版本交付与发布说明'));
  for (const source of ['guidance', 'deliveryGuidance', 'title', 'body', 'criteria']) {
    const p = structuredClone(project), i = structuredClone(item);
    if (source === 'guidance' || source === 'deliveryGuidance') p[source] = '完成后生成安装包';
    else if (source === 'criteria') i.criteria = ['发布说明符合规范'];
    else i[source] = '更新 changelog';
    const prompt = buildPrompt(p, [i, { ...i, number: 'REQ-002', deliveryGuidance: '独立交付' }]);
    assert.equal(prompt.split('## 版本交付与发布说明').length - 1, 1, source);
    assert.ok(prompt.endsWith(RELEASE_NOTES_GUIDANCE), source);
    assert.match(prompt, /「## 主要更新」/);
  }
  const go = await readFile('src/mygo/backendgo/domain.go', 'utf8');
  const declaration = go.slice(go.indexOf('const ReleaseNotesGuidance ='), go.indexOf('func ProjectConcurrencyToken'));
  const goGuidance = [...declaration.matchAll(/"(?:\\.|[^"\\])*"/g)].map(match => JSON.parse(match[0])).join('');
  assert.equal(goGuidance, RELEASE_NOTES_GUIDANCE, 'Go and renderer must send identical release instructions');
  console.log('PASS: 发布规范覆盖项目引导、交付引导、需求正文/标题/验收条件；多需求只追加一次；Go 与界面规范一致。');
} finally {
  await rm(directory, { recursive: true, force: true });
}
