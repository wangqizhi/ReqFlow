#!/usr/bin/env node
// Node built-ins only. Never edits workspace.json directly.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw new Error(message); };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const canonical = async dir => {
  const resolved = await fs.realpath(path.resolve(dir));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const signature = (p, i, b) => digest({ dir: p.dir, description: p.description, guidance: p.guidance,
  guideVersion: p.guideVersion, deliveryGuidance: p.deliveryGuidance,
  aiValidation: p.aiValidation, item: i, batch: b });

export async function callCli(config, args) {
  return new Promise((resolve, reject) => {
    const argv = [...(config.args || []), '--cli', ...args];
    if (config.dataDir) argv.push('--data-dir', config.dataDir);
    execFile(config.executable, argv, { windowsHide: true, encoding: 'utf8',
      timeout: 30000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      let result;
      try { result = JSON.parse(stdout.trim()); }
      catch { return reject(new Error(`ReqFlow CLI 未返回 JSON：${error?.message || stderr.slice(0, 300)}`)); }
      if (error || result.ok !== true) return reject(new Error(result.error || error?.message || 'CLI 失败'));
      resolve(result);
    });
  });
}

export function submittedBatch(p, i) {
  const batches = p.batches.filter(b => b.status === 'submitted' && b.mode === 'develop'
    && b.items.some(old => old.id === i.id));
  // Submission order can differ from generation order, including equal timestamps.
  for (const h of i.history || []) {
    const found = batches.find(b => h.event === '确认提交 · 批次 ' + b.number);
    if (found) return found;
  }
  return batches.sort((a, b) => String(b.submittedAt || b.time).localeCompare(String(a.submittedAt || a.time)))[0];
}

export function scheduledBatch(p, i) {
  const lastSchedule = i.flowEvents?.slice().reverse().find(e => ['generate', 'revert', 'cancel', 'guidance', 'verify', 'regress'].includes(e.operation));
  if (lastSchedule && lastSchedule.operation !== 'generate') return undefined;
  // Latest live schedule wins; never fall back to an older snapshot after edits.
  return p.batches.find(b => b.mode === 'develop' && b.status !== 'cancelled' && b.items.some(old => old.id === i.id));
}

export async function matchProject(projects, cwd) {
  const current = await canonical(cwd);
  const candidates = [];
  for (const p of projects) {
    if (!p.dir) continue;
    let root;
    try { root = await canonical(p.dir); } catch { continue; }
    const rel = path.relative(root, current);
    if (rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)))
      candidates.push({ project: p, root });
  }
  candidates.sort((a, b) => b.root.length - a.root.length);
  if (!candidates.length) fail('当前目录没有匹配的 ReqFlow 项目。请在 ReqFlow「浏览项目」中绑定该项目目录。');
  if (candidates[1]?.root === candidates[0].root) fail('同一目录绑定了多个 ReqFlow 项目，请先消除重复绑定。');
  return candidates[0];
}

async function workspace(config) {
  const info = await callCli(config, ['version']);
  if (info.app !== 'ReqFlow' || typeof info.dataFile !== 'string') fail('不是兼容的 ReqFlow CLI');
  // workspace get initializes a missing store. Prevent reading the wrong empty workspace.
  await fs.access(info.dataFile).catch(() => fail(`工作区不存在：${info.dataFile}；请核对数据目录。`));
  const result = await callCli(config, ['workspace', 'get']);
  if (!Array.isArray(result.state?.projects)) fail('工作区格式不兼容');
  return { ...result, capabilities: info.capabilities || [], dataFile: await fs.realpath(info.dataFile) };
}

export async function readRun(config, cwd, runDir) {
  const w = await workspace(config);
  const { project: p, root } = await matchProject(w.state.projects, cwd);
  const eligible = [], skipped = [];
  for (const i of p.items) {
    if (!['ready', 'in_progress'].includes(i.status) || i.archived) continue;
    const b = scheduledBatch(p, i);
    if (!b) continue;
    if ((i.executor || 'ai') !== 'ai') { skipped.push({ id: i.id, number: i.number, reason: '非 AI 执行任务' }); continue; }
    const old = b?.items.find(x => x.id === i.id);
    if (old?.version !== i.version || (old.executor || 'ai') !== 'ai' || b.guideVersion !== p.guideVersion) {
      skipped.push({ id: i.id, number: i.number, reason: '排期快照版本、执行方式或引导词已变化' });
      continue;
    }
    const { history, ...requirement } = { ...old, ...i, executor: i.executor || 'ai' };
    eligible.push({ id: i.id, batchId: b.id, hash: b.hash,
      signature: signature(p, i, b), requirement,
      history: i.history.filter(h => h.event === '验证失败' || h.event === '回归退回') });
  }
  const run = { schema: 1, id: randomUUID(), createdAt: new Date().toISOString(),
    config, cwd: await canonical(cwd), root, dataFile: w.dataFile,
    projectId: p.id, projectName: p.name, items: eligible, completed: [] };
  let runFile = null;
  if (eligible.length) {
    await fs.mkdir(runDir, { recursive: true });
    runFile = path.join(runDir, run.id + '.json');
    await fs.writeFile(runFile, JSON.stringify(run, null, 2), { flag: 'wx', mode: 0o600 });
  }
  const selected = new Set(eligible.map(i => i.batchId));
  return { ok: true, runFile, project: { id: p.id, name: p.name, dir: root,
    description: p.description, guidance: p.guidance },
    requirements: eligible.map(({ signature, ...i }) => i), skipped,
    batches: p.batches.filter(b => selected.has(b.id)).map(b => ({ id: b.id, hash: b.hash, prompt: b.text })),
    scope: '仅实现 requirements；批次 Prompt 中其他需求不属于本轮。不得自动 verify / archive。' };
}

export async function completeRun(runFile, report, cwd) {
  const run = await json(runFile);
  if (run.schema !== 1 || !Array.isArray(report.items) || !report.items.length) fail('报告需要非空 items 数组');
  if (await canonical(cwd) !== run.cwd) fail('当前工作目录与领取目录不一致');
  const ids = report.items.map(i => i.id);
  if (new Set(ids).size !== ids.length) fail('报告包含重复需求 ID');
  for (const result of report.items) {
    if (!run.items.some(i => i.id === result.id)) fail('不能完成本轮未领取的需求：' + result.id);
    if (typeof result.summary !== 'string' || !result.summary.trim() || typeof result.validation !== 'string' || !result.validation.trim())
      fail('每条完成报告必须提供 summary 和 validation（检查结果或未运行原因）');
  }
  const outcomes = [];
  for (const result of report.items) {
    try {
      const w = await workspace(run.config);
      if (!w.capabilities.includes('scheduled-ai-complete')) fail('ReqFlow 桌面版需升级到支持 AI 排期条件完成的版本，未进行回写');
      if (w.dataFile !== run.dataFile) fail('ReqFlow 数据文件已变化');
      const match = await matchProject(w.state.projects, cwd);
      if (match.project.id !== run.projectId || match.root !== run.root) fail('项目绑定已变化');
      const p = match.project, i = p.items.find(i => i.id === result.id);
      if (!i) fail('需求已删除');
      const prior = run.completed.find(x => x.id === i.id);
      if (prior && i.status === 'pending_verification' && i.history[0]?.note === prior.note) {
        outcomes.push({ id: i.id, status: 'already_completed' }); continue;
      }
      const snapshot = run.items.find(x => x.id === i.id), b = scheduledBatch(p, i);
      if (!['ready', 'in_progress'].includes(i.status) || (i.executor || 'ai') !== 'ai' || i.archived || !b || signature(p, i, b) !== snapshot.signature)
        fail('需求、批次或项目设置已变化，请重新领取并核对实现');
      const note = `[ReqFlow Codex run ${run.id}]\n${result.summary}\n验证：${result.validation}`;
      // Legacy CLI has no conditional-write API. Pre/post checks narrow but cannot eliminate the race.
      await callCli(run.config, ['complete', '--project', p.id, '--id', i.id, '--batch', b.id, '--item-version', String(i.version), '--note', note]);
      const after = await workspace(run.config);
      const updated = after.state.projects.find(p => p.id === run.projectId)?.items.find(x => x.id === i.id);
      if (updated?.status !== 'pending_verification' || updated.version !== i.version || updated.history[0]?.note !== note)
        fail('写回后状态不一致，请人工核对；不要自动重试');
      run.completed.push({ id: i.id, note });
      await fs.writeFile(runFile, JSON.stringify(run, null, 2), { mode: 0o600 });
      outcomes.push({ id: i.id, status: 'pending_verification' });
    } catch (e) {
      outcomes.push({ id: result.id, status: 'conflict_or_error', error: e.message });
      // Earlier rows may have succeeded. Never hide partial progress or continue after uncertainty.
      break;
    }
  }
  return { ok: outcomes.every(x => x.status !== 'conflict_or_error'), outcomes,
    unprocessed: ids.slice(outcomes.length), warning: 'CLI 写回非原子条件更新；执行期间避免并发修改同一需求。' };
}

function parse(argv) {
  const opts = {};
  for (let n = 1; n < argv.length; n += 2) {
    if (!argv[n].startsWith('--') || argv[n + 1] === undefined) fail('参数格式：--key value');
    opts[argv[n].slice(2)] = argv[n + 1];
  }
  return { command: argv[0], opts };
}

export async function main(argv) {
  const { command, opts } = parse(argv);
  const configFile = path.resolve(opts.config || process.env.REQFLOW_PLUGIN_CONFIG || path.join(os.homedir(), '.reqflow-codex', 'config.json'));
  const cwd = opts.cwd || process.cwd();
  if (command === 'complete') return completeRun(path.resolve(opts.run || fail('缺少 --run')), await json(opts.report || fail('缺少 --report')), cwd);
  let config;
  try { config = await json(configFile); }
  catch (e) { if (e.code !== 'ENOENT') throw e; config = {}; }
  if (opts.exe || process.env.REQFLOW_EXE) config.executable = path.resolve(opts.exe || process.env.REQFLOW_EXE);
  if (opts.app) config.args = [path.resolve(opts.app)];
  if (opts['data-dir'] || process.env.REQFLOW_DATA_DIR) config.dataDir = path.resolve(opts['data-dir'] || process.env.REQFLOW_DATA_DIR);
  if (!config.executable && process.platform === 'win32') {
    const candidate = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ReqFlow', 'ReqFlow.exe');
    if (await fs.access(candidate).then(() => true, () => false)) config.executable = candidate;
  }
  if (!config.executable) fail('请先 configure --exe <ReqFlow.exe 路径> [--data-dir <数据目录>]');
  if (['.cmd', '.ps1', '.bat'].includes(path.extname(config.executable).toLowerCase())) fail('需要真实可执行文件，不能使用 shell shim');
  const info = await callCli(config, ['version']);
  if (info.app !== 'ReqFlow') fail('程序不是 ReqFlow');
  if (command === 'configure') {
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    return { ok: true, configFile, ...info };
  }
  if (command === 'doctor') return { ok: true, configFile, ...info };
  if (command === 'read') return readRun(config, cwd, path.join(path.dirname(configFile), 'runs'));
  fail('支持 configure / doctor / read / complete');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const result = await main(process.argv.slice(2)); console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1; }
  catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1; }
}
