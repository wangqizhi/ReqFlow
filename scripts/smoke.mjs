// 领域核心冒烟测试（纯 Node，无需 Electron / GUI）。
// 覆盖完整状态流 + 并发版本冲突，与线上领域规则逐条对应。

import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'reqflow-smoke-'));
let failed = 0;

async function test() {
  const entry = path.join(dir, 'entry.mjs');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(entry, `export { WorkspaceService } from ${JSON.stringify(path.resolve('src/core/service.ts').replaceAll('\\\\', '\\\\'))};`);
  const out = path.join(dir, 'bundle.mjs');
  await build({ entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
  const { WorkspaceService } = await import('file://' + out.replaceAll('\\', '/'));
  const { WorkspaceStore } = await import('file://' + out.replaceAll('\\', '/')).catch(() => ({}));

  // storage 单独打包
  const entry2 = path.join(dir, 'entry2.mjs');
  await writeFile(entry2, `export { WorkspaceStore, VersionConflictError } from ${JSON.stringify(path.resolve('src/core/storage.ts').replaceAll('\\\\', '\\\\'))};`);
  const out2 = path.join(dir, 'bundle2.mjs');
  await build({ entryPoints: [entry2], outfile: out2, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
  const storage = await import('file://' + out2.replaceAll('\\', '/'));

  const store = new storage.WorkspaceStore(path.join(dir, 'workspace.json'));
  const svc = new WorkspaceService(store);

  // 1. 初始化
  let r = await svc.get();
  assert.equal(r.state.projects.length, 1, '默认创建一个项目');
  assert.equal(r.state.projects[0].name, '我的第一个项目');

  // 2. 新建项目 + 加需求（新项目 AI 测试验证默认关闭；itemA 显式开启）
  r = await svc.mutate({ op: 'project', name: '官网改版', description: 'Next.js 站点' }, null);
  const pid = r.state.projects[1].id;
  assert.equal(r.state.projects[1].aiValidation, false, '新项目 AI 测试验证默认关闭');
  r = await svc.mutate({ op: 'item', project: pid, title: '登录限流', body: '连续失败5次锁定', type: 'bug', priority: 'P0', criteria: '锁定后提示剩余时间', aiValidation: true, deliveryGuidance: '说明改动与测试结果。' }, null);
  const itemA = r.state.projects[1].items[0];
  assert.equal(itemA.number, 'REQ-001');
  assert.equal(itemA.status, 'ready');
  r = await svc.mutate({ op: 'item', project: pid, title: '暗色模式', type: 'feature', priority: 'P2', deliveryGuidance: '说明改动与测试结果。' }, null);
  const itemB = r.state.projects[1].items[1];
  assert.equal(itemB.number, 'REQ-002');
  assert.equal(itemB.aiValidation, false, '需求默认继承项目的关闭设置');

  // 2b. 标题选填：无标题需求可保存，Prompt 仅显示需求编号、不出现「未命名需求」
  r = await svc.mutate({ op: 'item', project: pid, type: 'improvement', priority: 'P2' }, null);
  const itemC = r.state.projects[1].items[2];
  assert.equal(itemC.title, '', '标题允许为空');
  r = await svc.mutate({ op: 'generate', project: pid, ids: [itemC.id] }, null);
  const noTitleText = r.state.projects[1].batches[0].text;
  assert.ok(!noTitleText.includes('未命名需求'), '空标题不显示「未命名需求」');
  assert.ok(noTitleText.includes('### 1. ' + itemC.number + ' [improvement / P2]'), '空标题时仅显示编号');

  // 3. 生成批次 → 校验 Prompt 内容包含标题/验收条件/AI 测试段
  r = await svc.mutate({ op: 'generate', project: pid, ids: [itemA.id, itemB.id] }, null);
  const batch = r.state.projects[1].batches[0];
  assert.equal(batch.status, 'draft');
  assert.ok(batch.text.includes('# 项目：官网改版'));
  assert.ok(batch.text.includes('REQ-001 · 登录限流 [bug / P0]'));
  assert.ok(batch.text.includes('- [ ] 锁定后提示剩余时间'));
  assert.ok(batch.text.includes('AI 测试验证（仅适用于 REQ-001）：'), 'AI 测试验证仅列出显式开启的需求');
  assert.ok(!batch.text.includes('AI 测试验证（仅适用于 REQ-001、REQ-002'), '默认关闭的需求不进入 AI 测试验证');
  assert.equal((batch.text.match(/AI 测试验证（/g) || []).length, 1, 'AI 测试验证只出现一次');
  assert.ok(batch.text.includes('交付引导（本轮全部需求）：\n说明改动与测试结果。'), '相同交付引导合并为本轮一块');
  assert.equal((batch.text.match(/交付引导（/g) || []).length, 1, '交付引导只出现一次');
  assert.match(batch.hash, /^[0-9a-f]{64}$/, 'SHA-256');

  // 4. 提交批次 → 需求进入执行中
  r = await svc.mutate({ op: 'submit', project: pid, batch: batch.id }, null);
  assert.equal(r.state.projects[1].items[0].status, 'in_progress');

  // 5. 业务校验：执行中不可编辑
  await assert.rejects(
    () => svc.mutate({ op: 'item', project: pid, id: itemA.id, title: '改标题', type: 'bug', priority: 'P0' }, null),
    /请先取消执行或退回/,
    '执行中的需求禁止编辑'
  );

  // 6. 实现完成 → 待验证 → 验证未通过 → 退回待执行并记录原因
  r = await svc.mutate({ op: 'complete', project: pid, id: itemA.id }, null);
  assert.equal(r.state.projects[1].items[0].status, 'pending_verification');
  r = await svc.mutate({ op: 'verify', project: pid, id: itemA.id, pass: false, note: '样式未生效' }, null);
  assert.equal(r.state.projects[1].items[0].status, 'ready');
  assert.ok(r.state.projects[1].items[0].history[0].event === '验证失败');

  // 7. 未通过问题带入下一轮 Prompt
  r = await svc.mutate({ op: 'generate', project: pid, ids: [itemA.id] }, null);
  const batch2 = r.state.projects[1].batches[0];
  assert.ok(batch2.text.includes('未通过的问题（本轮需修复）：'));
  assert.ok(batch2.text.includes('样式未生效'));

  // 8. 完整通过流：提交 → 完成 → 通过 → 归档
  r = await svc.mutate({ op: 'submit', project: pid, batch: batch2.id }, null);
  r = await svc.mutate({ op: 'complete', project: pid, id: itemA.id }, null);
  r = await svc.mutate({ op: 'verify', project: pid, id: itemA.id, pass: true }, null);
  assert.equal(r.state.projects[1].items[0].status, 'archived');
  assert.equal(r.state.projects[1].items[0].archived, true);

  // 9. 回归：归档 → 待执行
  r = await svc.mutate({ op: 'regress', project: pid, id: itemA.id, note: '线上复现' }, null);
  assert.equal(r.state.projects[1].items[0].status, 'ready');

  const events = r.state.projects[1].items[0].flowEvents;
  assert.deepEqual(events.map(e => e.stage), ['ready', 'ready', 'in_progress', 'pending_verification', 'ready', 'ready', 'in_progress', 'pending_verification', 'archived', 'ready'], '两轮开发及回归保留完整步骤');
  assert.ok(events.every(e => Number.isFinite(Date.parse(e.time))), '每个步骤包含有效时间');
  const persisted = await svc.get();
  assert.deepEqual(persisted.state.projects[1].items[0].flowEvents, events, '流转时间落盘后保持不变');

  // 9b. 二次退回的问题标识：区分「此前未修复」与「本轮新问题」，确认已修复的不再带入
  r = await svc.mutate({ op: 'item', project: pid, title: '二次退回标识', type: 'feature', priority: 'P1' }, null);
  const itemD = r.state.projects[1].items[r.state.projects[1].items.length - 1];
  // 一轮完整流转：生成 → 提交 → 实现完成 → 按传入动作退回
  const round = async (failAction) => {
    await svc.mutate({ op: 'generate', project: pid, ids: [itemD.id] }, null);
    const st = await svc.get();
    await svc.mutate({ op: 'submit', project: pid, batch: st.state.projects[1].batches[0].id }, null);
    await svc.mutate({ op: 'complete', project: pid, id: itemD.id }, null);
    await svc.mutate({ op: 'verify', project: pid, id: itemD.id, ...failAction }, null);
  };
  // 第一轮失败：单条新问题，无来源标识（兼容既有 Prompt 格式）
  await round({ pass: false, note: '接口超时' });
  r = await svc.mutate({ op: 'generate', project: pid, ids: [itemD.id] }, null);
  let promptD = r.state.projects[1].batches[0].text;
  assert.ok(promptD.includes('接口超时'), '第一轮失败问题进入 Prompt');
  assert.ok(!promptD.includes('【'), '单条问题时 Prompt 不加来源标识');
  // 第二轮失败：旧问题仍未修复 + 新问题 → Prompt 分别标注
  await round({ pass: false, note: '页面乱码', fixed: [] });
  r = await svc.mutate({ op: 'generate', project: pid, ids: [itemD.id] }, null);
  promptD = r.state.projects[1].batches[0].text;
  assert.ok(promptD.includes('【此前问题未修复】接口超时'), '旧问题标注未修复');
  assert.ok(promptD.includes('【本轮新问题】页面乱码'), '新问题标注本轮新增');
  // 第三轮失败：确认旧问题全部已修复 → 只剩新问题且无标识
  await round({ pass: false, note: '按钮错位', fixed: [0, 1] });
  r = await svc.mutate({ op: 'generate', project: pid, ids: [itemD.id] }, null);
  promptD = r.state.projects[1].batches[0].text;
  assert.ok(promptD.includes('按钮错位'), '最新问题仍在 Prompt');
  assert.ok(!promptD.includes('接口超时') && !promptD.includes('页面乱码'), '确认已修复的问题不再带入 Prompt');
  // fixed 下标非法应报错（先把需求送回待验证）
  await svc.mutate({ op: 'generate', project: pid, ids: [itemD.id] }, null);
  const st9b = await svc.get();
  await svc.mutate({ op: 'submit', project: pid, batch: st9b.state.projects[1].batches[0].id }, null);
  await svc.mutate({ op: 'complete', project: pid, id: itemD.id }, null);
  await assert.rejects(
    () => svc.mutate({ op: 'verify', project: pid, id: itemD.id, pass: false, note: 'x', fixed: [9] }, null),
    /已修复标记无效/,
    '非法 fixed 下标必须被拒绝'
  );
  await svc.mutate({ op: 'verify', project: pid, id: itemD.id, pass: false, note: '收尾' }, null);

  // 10. 乐观并发：带旧 expectedVersion 写入应报冲突
  const staleVersion = r.version - 1;
  await assert.rejects(
    () => svc.mutate({ op: 'item', project: pid, title: '并发写入', type: 'feature', priority: 'P1' }, staleVersion),
    (e) => e.code === 'VERSION_CONFLICT',
    '版本冲突必须被拒绝'
  );

  // 11. 取消批次（先取消第一批次让 itemB 退回待执行，再走 取消 新批次）
  r = await svc.mutate({ op: 'cancel', project: pid, batch: batch.id }, null);
  assert.equal(r.state.projects[1].items[1].status, 'ready');
  r = await svc.mutate({ op: 'generate', project: pid, ids: [itemB.id] }, null);
  const b3 = r.state.projects[1].batches[0];
  r = await svc.mutate({ op: 'submit', project: pid, batch: b3.id }, null);
  assert.equal(r.state.projects[1].items[1].status, 'in_progress');
  r = await svc.mutate({ op: 'cancel', project: pid, batch: b3.id }, null);
  assert.equal(r.state.projects[1].items[1].status, 'ready');

  // 12. 引导词版本推进
  r = await svc.mutate({ op: 'guidance', project: pid, text: '新引导词', deliveryGuidance: '新交付引导' }, null);
  assert.equal(r.state.projects[1].guideVersion, 2);
  assert.equal(r.state.projects[1].guideHistory.length, 1);

  // 13. 交付引导去重：相同内容合并为一组，不同内容按需求编号分组
  for (const [title, delivery] of [['去重A', '打包A'], ['去重B', '打包A'], ['去重C', '打包C']])
    r = await svc.mutate({ op: 'item', project: pid, title, type: 'feature', priority: 'P2', deliveryGuidance: delivery }, null);
  const dedupItems = r.state.projects[1].items.slice(-3);
  r = await svc.mutate({ op: 'generate', project: pid, ids: dedupItems.map((i) => i.id) }, null);
  const dedupText = r.state.projects[1].batches[0].text;
  assert.equal((dedupText.match(/交付引导（/g) || []).length, 2, '两种交付引导只出现两块');
  assert.ok(dedupText.includes('交付引导（' + dedupItems[0].number + '、' + dedupItems[1].number + '）：\n打包A'), '相同交付引导合并并列出需求编号');
  assert.ok(dedupText.includes('交付引导（' + dedupItems[2].number + '）：\n打包C'), '不同交付引导单独分组');
  assert.equal(r.state.projects[1].batches[0].templateVersion, 5, 'Prompt 模板版本');

  // 14. 迁移/删除需求：存储持久化、目标编号、历史与设置保留、旧快照失效、状态限制。
  const targetPid = r.state.projects[0].id;
  await svc.mutate({ op: 'item', project: targetPid, title: '目标已有需求' }, null);
  await svc.mutate({ op: 'generate', project: pid, ids: [itemB.id] }, null);
  let beforeMove = await svc.get();
  const oldMoveBatch = beforeMove.state.projects[1].batches[0];
  const original = beforeMove.state.projects[1].items.find((i) => i.id === itemB.id);
  for (const targetProject of [pid, 'missing-project']) {
    await assert.rejects(() => svc.mutate({ op: 'moveItem', project: pid, id: itemB.id, targetProject }, null), /请选择其他项目|目标项目不存在/);
  }
  r = await svc.mutate({ op: 'moveItem', project: pid, id: itemB.id, targetProject: targetPid }, null);
  assert.ok(!r.state.projects[1].items.some((i) => i.id === itemB.id), '源项目不再包含迁移需求');
  const moved = (await svc.get()).state.projects[0].items.find((i) => i.id === itemB.id);
  assert.equal(moved.number, 'REQ-002', '使用目标项目递增编号');
  assert.equal(moved.version, original.version + 1);
  for (const key of ['title', 'body', 'criteria', 'type', 'priority', 'aiValidation', 'deliveryGuidance'])
    assert.deepEqual(moved[key], original[key], '保留需求字段 ' + key);
  assert.deepEqual(moved.history.slice(1), original.history, '原有历史完整保留');
  assert.equal(moved.history[0].event, '迁移项目');
  assert.deepEqual(r.state.projects[1].batches[0], oldMoveBatch, '迁移不修改历史批次快照');
  await assert.rejects(() => svc.mutate({ op: 'submit', project: pid, batch: oldMoveBatch.id }, null), /源内容或状态已变化/);
  await svc.mutate({ op: 'generate', project: targetPid, ids: [itemB.id] }, null);
  const moveBatch = (await svc.get()).state.projects[0].batches[0];
  await svc.mutate({ op: 'submit', project: targetPid, batch: moveBatch.id }, null);
  for (const op of ['moveItem', 'deleteItem'])
    await assert.rejects(() => svc.mutate({ op, project: targetPid, id: itemB.id, targetProject: pid }, null), /只有待执行需求/);
  await svc.mutate({ op: 'complete', project: targetPid, id: itemB.id }, null);
  for (const op of ['moveItem', 'deleteItem'])
    await assert.rejects(() => svc.mutate({ op, project: targetPid, id: itemB.id, targetProject: pid }, null), /只有待执行需求/);
  await svc.mutate({ op: 'verify', project: targetPid, id: itemB.id, pass: true }, null);
  for (const op of ['moveItem', 'deleteItem'])
    await assert.rejects(() => svc.mutate({ op, project: targetPid, id: itemB.id, targetProject: pid }, null), /只有待执行需求/);
  await svc.mutate({ op: 'regress', project: targetPid, id: itemB.id }, null);
  await svc.mutate({ op: 'generate', project: targetPid, ids: [itemB.id] }, null);
  const deleteBatch = (await svc.get()).state.projects[0].batches[0];
  await svc.mutate({ op: 'deleteItem', project: targetPid, id: itemB.id }, null);
  r = await svc.get();
  assert.ok(!r.state.projects[0].items.some((i) => i.id === itemB.id), '删除需求持久化');
  assert.deepEqual(r.state.projects[0].batches[0], deleteBatch, '删除不修改批次快照');
  await assert.rejects(() => svc.mutate({ op: 'submit', project: targetPid, batch: deleteBatch.id }, null), /源内容或状态已变化/);
  await assert.rejects(() => svc.mutate({ op: 'deleteItem', project: targetPid, id: itemB.id }, null), /需求不存在/);

  // 15. 删除项目：非最后项目可删且移除其全部数据；最后一个项目禁止删除
  r = await svc.mutate({ op: 'project', name: '待删除项目', description: '临时' }, null);
  const delPid = r.state.projects[2].id;
  r = await svc.mutate({ op: 'item', project: delPid, title: '临时需求', type: 'feature', priority: 'P2', deliveryGuidance: '说明改动。' }, null);
  r = await svc.mutate({ op: 'deleteProject', project: delPid }, null);
  assert.equal(r.state.projects.length, 2, '删除后项目数减一');
  assert.ok(!r.state.projects.some((p) => p.id === delPid), '目标项目及其需求数据已移除');
  await assert.rejects(
    () => svc.mutate({ op: 'deleteProject', project: 'not-exist' }, null),
    /项目不存在/,
    '删除不存在的项目报错'
  );
  // 删到只剩一个项目时，拒绝删除最后一个
  const keepPid = pid;
  const otherPid = r.state.projects.find((p) => p.id !== keepPid).id;
  r = await svc.mutate({ op: 'deleteProject', project: otherPid }, null);
  assert.equal(r.state.projects.length, 1, '只剩一个项目');
  await assert.rejects(
    () => svc.mutate({ op: 'deleteProject', project: keepPid }, null),
    /至少保留一个项目/,
    '最后一个项目禁止删除'
  );
  // 引导词更新必须退回全部排期，独立发布设置和无变化保存不得退回。
  const settingsSvc = new WorkspaceService(new storage.WorkspaceStore(path.join(dir, 'settings.json')));
  let settings = await settingsSvc.get();
  const settingsPid = settings.state.projects[0].id;
  const settingsOp = async (a) => { settings = await settingsSvc.mutate({ ...a, project: settingsPid }, null); return settings.state.projects[0]; };
  let sp = await settingsOp({ op: 'item', body: '排期退回测试', type: 'feature', priority: 'P1' });
  const scheduledItem = sp.items[0].id;
  sp = await settingsOp({ op: 'generate', ids: [scheduledItem], mode: 'develop' });
  sp = await settingsOp({ op: 'submit', batch: sp.batches[0].id });
  const guideVersion = sp.guideVersion;
  sp = await settingsOp({ op: 'publishScript', script: 'scripts/deploy.mjs' });
  assert.equal(sp.publishScript, 'scripts/deploy.mjs');
  assert.equal(sp.items[0].status, 'in_progress');
  sp = await settingsOp({ op: 'guidance', text: sp.guidance });
  assert.equal(sp.guideVersion, guideVersion, '无变化保存不递增版本');
  assert.equal(sp.items[0].status, 'in_progress', '无变化保存不退回排期');
  sp = await settingsOp({ op: 'guidance', text: '更新后的引导词' });
  assert.equal(sp.items[0].status, 'ready', '引导词变化自动退回需求池');
  assert.equal(sp.batches[0].status, 'cancelled', '旧排期批次失效');
  await assert.rejects(() => settingsOp({ op: 'publishScript', script: '../deploy.mjs' }), /相对路径/);
  sp = await settingsOp({ op: 'publishScript', script: '' });
  assert.equal(sp.publishScript, '', '支持禁用发布');
  sp = await settingsOp({ op: 'publishScript', script: null });
  assert.equal(sp.publishScript, undefined, '支持恢复自动检测');
}

try {
  await test();
  console.log('冒烟测试全部通过 ✔（原16组断言及项目设置/排期自动退回回归检查）');
} catch (e) {
  failed = 1;
  console.error('冒烟测试失败：', e.message);
  console.error(e);
} finally {
  await rm(dir, { recursive: true, force: true });
  process.exit(failed);
}
