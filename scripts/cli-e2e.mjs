// CLI 端到端测试：用真实 electron.exe 走完 Agent 典型工作流。
// 运行：node scripts/cli-e2e.mjs（数据写入 .test-data，测试后自动清理）

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const packaged = process.env.REQFLOW_E2E_EXE;
const exe = path.resolve(packaged || 'node_modules/electron/dist/electron.exe');
const dataDir = path.resolve('.test-data');
const env = { ...process.env, REQFLOW_DATA_DIR: dataDir };
const appVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;

function rf(...args) {
  const out = execFileSync(exe, [...(packaged ? [] : ['.']), '--cli', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env });
  return JSON.parse(out.trim());
}
function rfFail(...args) {
  try {
    rf(...args);
    return null; // 不应成功
  } catch (e) {
    return JSON.parse((e.stdout || '').trim());
  }
}

const ok = (label, cond) => {
  console.log((cond ? '  ✔ ' : '  ✘ ') + label);
  if (!cond) process.exitCode = 1;
};

rmSync(dataDir, { recursive: true, force: true });
try {
  console.log('CLI 端到端测试（' + exe + ' --cli）:');
  let r = rf('version');
  ok('version 输出应用信息', r.ok && r.version === appVersion);

  r = rf('project', 'create', '--name', 'CLI 测试项目', '--description', '全流程测试');
  ok('project create', r.ok && r.project.name === 'CLI 测试项目');
  const pid = r.project.id;

  r = rf('item', 'add', '--project', pid, '--title', '登录限流', '--body', '连续失败锁定', '--type', 'bug', '--priority', 'P0', '--criteria', '锁定提示;解锁流程', '--date', '2028-02-29');
  ok('item add（分号分隔验收条件→2条）', r.ok && r.item.criteria.length === 2);
  ok('item add --date 保存有效闰日', r.item.scheduledDate === '2028-02-29');
  const id1 = r.item.id;
  r = rf('item', 'add', '--project', pid, '--title', '暗色模式', '--type', 'feature', '--priority', 'P2');
  const id2 = r.item.id;
  ok('未传 --date 默认不带计划日期', r.item.scheduledDate === undefined);
  const badDate = rfFail('item', 'add', '--project', pid, '--body', 'invalid date', '--date', '2027-02-29');
  ok('无效日期失败且不新增需求', badDate?.ok === false && badDate.error.includes('日期'));

  r = rf('item', 'list', '--project', pid, '--status', 'ready');
  ok('item list --status ready = 2', r.ok && r.total === 2);

  r = rf('generate', '--project', pid, '--items', id1 + ',' + id2);
  ok('generate 两条需求', r.ok && r.batch.status === 'draft' && r.prompt.includes('REQ-002'));
  ok('AI 验证默认关闭；交付引导只出现一次', r.ok &&
    !r.prompt.includes('AI 测试验证（') &&
    (r.prompt.match(/交付引导（/g) || []).length === 1);
  const bid = r.batch.id;

  r = rf('batch', 'show', '--project', pid, '--id', bid);
  ok('batch show 含 Prompt 全文与哈希', r.ok && r.prompt.length > 100 && r.hash.length === 64);

  r = rf('submit', '--project', pid, '--batch', bid);
  ok('submit', r.ok);
  r = rf('item', 'show', '--project', pid, '--id', id1);
  ok('提交后 in_progress', r.item.status === 'in_progress');

  // 累积生成：前一轮未完成（执行中）的需求可与新增需求一起生成，也可单独生成
  r = rf('item', 'add', '--project', pid, '--title', '新补充需求', '--type', 'feature', '--priority', 'P1');
  const id3 = r.item.id;
  r = rf('generate', '--project', pid, '--items', id2 + ',' + id3);
  ok('执行中需求与新需求累积生成', r.ok && r.prompt.includes('REQ-002') && r.prompt.includes('REQ-003'));
  const bidAcc = r.batch.id;
  r = rf('submit', '--project', pid, '--batch', bidAcc);
  ok('累积批次 submit', r.ok);
  r = rf('item', 'show', '--project', pid, '--id', id3);
  ok('累积批次提交后新需求 in_progress', r.item.status === 'in_progress');
  r = rf('generate', '--project', pid, '--items', id2);
  ok('执行中需求可单独生成', r.ok && r.prompt.includes('REQ-002'));
  r = rf('cancel', '--project', pid, '--batch', bidAcc);
  ok('取消累积批次', r.ok);
  r = rf('item', 'show', '--project', pid, '--id', id2);
  ok('仍被其他已提交批次执行的需求保持执行中', r.item.status === 'in_progress');
  r = rf('item', 'show', '--project', pid, '--id', id3);
  ok('仅属于被取消批次的需求退回待执行', r.item.status === 'ready');

  // 单条退回：执行中需求退回待执行后可编辑，同批次其他需求不受影响
  r = rf('revert', '--project', pid, '--id', id2);
  ok('执行中需求单条退回待执行', r.ok);
  r = rf('item', 'show', '--project', pid, '--id', id2);
  ok('退回后 ready 且记录历史', r.item.status === 'ready' && r.item.history[0].event === '退回待执行');
  r = rf('item', 'edit', '--project', pid, '--id', id2, '--priority', 'P0');
  ok('退回后可编辑，未传字段保留原值', r.ok && r.item.priority === 'P0' && r.item.type === 'feature');
  r = rf('item', 'show', '--project', pid, '--id', id1);
  ok('同批次其他需求保持执行中', r.item.status === 'in_progress');
  const errRevert = rfFail('revert', '--project', pid, '--id', id3);
  ok('对非执行中需求 revert 报错', errRevert && errRevert.ok === false);

  r = rf('complete', '--project', pid, '--id', id1);
  ok('complete → 待验证', r.ok);

  r = rf('verify', '--project', pid, '--id', id1, '--pass', 'false', '--note', '样式未生效');
  ok('verify 未通过退回待执行', r.ok);

  r = rf('generate', '--project', pid, '--items', id1);
  ok('未通过问题带入下一轮 Prompt', r.ok && r.prompt.includes('样式未生效'));
  const bid2 = r.batch.id;
  rf('submit', '--project', pid, '--batch', bid2);
  rf('complete', '--project', pid, '--id', id1);
  r = rf('verify', '--project', pid, '--id', id1, '--pass', 'true');
  ok('verify 通过归档', r.ok);
  r = rf('item', 'show', '--project', pid, '--id', id1);
  ok('最终 archived', r.item.status === 'archived');

  r = rf('regress', '--project', pid, '--id', id1, '--note', '线上复现');
  ok('regress 回到待执行', r.ok);

  r = rf('guidance', 'set', '--project', pid, '--text', '新引导词', '--delivery', '新交付引导');
  ok('guidance set 版本推进', r.ok && r.guideVersion === 2);

  r = rf('workspace', 'export');
  ok('workspace export', r.ok && r.workspace.projects.length === 2);

  r = rf('item', 'add', '--project', pid, '--type', 'improvement', '--priority', 'P2');
  ok('标题可省略（空标题需求）', r.ok && r.item.title === '');
  ok('未传 --ai-validation 时默认关闭', r.item.aiValidation === false);
  const noTitleNum = r.item.number;
  r = rf('generate', '--project', pid, '--items', r.item.id);
  ok('空标题不显示「未命名需求」，仅显示编号', r.ok &&
    !r.prompt.includes('未命名需求') &&
    r.prompt.includes('### 1. ' + noTitleNum + ' [improvement / P2]'));

  r = rf('item', 'add', '--project', pid, '--title', '需要验证的需求', '--ai-validation', 'true');
  r = rf('generate', '--project', pid, '--items', r.item.id);
  ok('已移除的 --ai-validation 参数不再生成测试要求', r.ok && !r.prompt.includes('AI 测试验证（'));

  const err = rfFail('verify', '--project', pid, '--id', id1, '--pass', 'true');
  ok('对非待验证需求 verify 报错且 ok=false', err && err.ok === false);

  const err2 = rfFail('submit', '--project', pid, '--batch', 'not-exist');
  ok('批次不存在报错', err2 && err2.ok === false);

  // 删除项目：新建→删除→列表不再包含；不存在的项目报错；最后一个项目不可删
  r = rf('project', 'create', '--name', '待删除项目');
  const delPid = r.project.id;
  r = rf('project', 'delete', '--project', delPid);
  ok('project delete', r.ok && r.remaining === 2);
  const errDel = rfFail('project', 'delete', '--project', delPid);
  ok('删除不存在的项目报错', errDel && errDel.ok === false);
  r = rf('project', 'list');
  const otherPid = r.projects.find((p) => p.id !== pid).id;
  r = rf('project', 'delete', '--project', otherPid);
  ok('删除另一个项目', r.ok && r.remaining === 1);
  const errLast = rfFail('project', 'delete', '--project', pid);
  ok('最后一个项目不可删除', errLast && errLast.ok === false && errLast.error.includes('至少保留一个项目'));

  console.log(process.exitCode ? 'CLI 端到端测试存在失败项' : 'CLI 端到端测试全部通过 ✔');
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
