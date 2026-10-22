#!/usr/bin/env node
/**
 * ReqFlow × DeepSeek Harness 交互终端客户端。
 *
 * 在 ReqFlow 指派的 ConPTY 里运行：先把指派任务交给 `dsh --profile headless --json`
 * 通过临时启动补丁保留运行实例，按行读取 JSON 事件并渲染；后续输入直接发送给
 * 同一个 Agent，避免每轮重新加载插件和恢复历史。
 *
 * 只依赖 Node 内置模块；不读取 ReqFlow 数据，也不修改 DSH 配置。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename, resolve } from 'node:path';
import process from 'node:process';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args.set(token.slice(2), 'true');
  else { args.set(token.slice(2), next); i += 1; }
}

const color = args.get('color') === 'always' || (args.get('color') !== 'never' && process.stdout.isTTY);
const paint = (code, text) => (color && text ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = text => paint('2', text);
const bold = text => paint('1', text);
const cyan = text => paint('36', text);
const red = text => paint('31', text);
const yellow = text => paint('33', text);
const write = text => { process.stdout.write(text); };
// 终端被关闭（PTY 句柄失效）时不抛出未处理的 EPIPE。
process.stdout.on('error', () => {});
const line = (text = '') => write(text + '\r\n');

const profile = args.get('profile') || 'headless';
// ReqFlow 启动的 DSH 默认完全访问：与 Codex 指派的 --sandbox danger-full-access
// 对齐，避免需求实现被工作区沙箱或无人应答的审批拦住。
// base 组合用 DSH_PERMISSION_MODE 同时决定沙箱模式与审批策略
// （danger-full-access → 沙箱完全访问、审批 never），因此只设置一个环境变量。
const permission = args.get('permission') || process.env.REQFLOW_DSH_PERMISSION_MODE || 'danger-full-access';
const permissionLabel = permission === 'danger-full-access' ? '完全访问' : permission;
const cwd = args.get('cwd') || process.cwd();
const label = args.get('label') || '';
const taskFile = args.get('task-file') || '';

if (!existsSync(cwd)) {
  line(red(`工作目录不存在：${cwd}`));
  process.exit(1);
}

function resolveDsh() {
  const candidates = [];
  const explicit = args.get('dsh') || process.env.REQFLOW_DSH_BIN || '';
  if (explicit) candidates.push(explicit);
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  candidates.push(join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  for (const candidate of candidates) {
    try { if (candidate && existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return '';
}
const dshBin = resolveDsh();

let sessionId = '';
let running = false;
let child = null;
let printedText = false;
let finalText = '';
let printedError = '';
let spinner = null;
let spinnerFrame = 0;
let closed = false;
let pendingTurn = null;
let freshSession = false;
let launchDirectory = '';
process.on('exit', () => { if (launchDirectory) rmSync(launchDirectory, { recursive: true, force: true }); });

function clearSpinner() {
  if (!spinner) return;
  clearInterval(spinner);
  spinner = null;
  if (process.stdout.isTTY) write('\r\x1b[2K');
}
function startSpinner(text) {
  if (!process.stdout.isTTY || spinner) return;
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  spinner = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % frames.length;
    write(`\r${dim(`${frames[spinnerFrame]} ${text}`)}`);
  }, 90);
  spinner.unref();
}

function block(text, style = '') {
  const normalised = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalised) return;
  clearSpinner();
  write((style ? style(normalised) : normalised) + '\r\n');
}

function toolSummary(ev) {
  const input = ev.input && typeof ev.input === 'object' ? ev.input : {};
  const candidates = [input.command, input.description, input.file_path, input.path, input.query, input.url, input.pattern];
  const value = candidates.find(item => typeof item === 'string' && item.trim()) || '';
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? compact.slice(0, 117) + '…' : compact;
}

function showError(message) {
  const text = String(message ?? '').replace(/^dsh:\s*/i, '').trim();
  if (!text || text === printedError) return;
  printedError = text;
  clearSpinner();
  line(red(`✗ ${text}`));
}

function handleEvent(raw) {
  let ev;
  try { ev = JSON.parse(raw); } catch { return; }
  if (!ev || typeof ev !== 'object') return;
  switch (ev.type) {
    case 'session':
      if (ev.sessionId) sessionId = String(ev.sessionId);
      break;
    case 'status':
      if (ev.phase === 'step_start') startSpinner('思考中');
      if (ev.phase === 'turn_end' && ev.reason && ev.reason.kind === 'error') {
        showError(ev.reason.error && ev.reason.error.message ? ev.reason.error.message : '运行失败');
      }
      break;
    case 'text':
      if (ev.text) {
        clearSpinner();
        if (printedText) line();
        write(String(ev.text).replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\r\n');
        printedText = true;
      }
      break;
    case 'thinking': {
      const text = String(ev.text ?? '').replace(/\r\n/g, '\n').trim();
      if (text) {
        const rows = text.split('\n').slice(0, 6).map(row => dim('· ' + row.slice(0, 160)));
        clearSpinner();
        for (const row of rows) line(row);
      }
      break;
    }
    case 'tool_call': {
      clearSpinner();
      const summary = toolSummary(ev);
      line(cyan(`⏺ ${ev.tool || 'tool'}`) + (summary ? dim(' · ' + summary) : ''));
      break;
    }
    case 'tool_result': {
      const result = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '');
      const rows = String(result).replace(/\r\n/g, '\n').split('\n').map(row => row.trimEnd()).filter(row => row.trim());
      if (!rows.length) break;
      if (ev.status === 'error') {
        clearSpinner();
        for (const row of rows.slice(0, 6)) line(red('  ⎿ ' + row.slice(0, 200)));
        if (rows.length > 6) line(red(`  ⎿ … 其余 ${rows.length - 6} 行`));
      } else {
        line(dim(`  ⎿ ${rows[0].slice(0, 160)}${rows.length > 1 ? `（共 ${rows.length} 行）` : ''}`));
      }
      break;
    }
    case 'final':
      if (typeof ev.text === 'string') finalText = ev.text;
      break;
    case 'error':
      showError(ev.message || '运行失败');
      break;
    default:
      break;
  }
}

function startRuntime() {
  if (child) return child;
  if (!dshBin) throw Error('未找到 DeepSeek Harness（dsh）。请先安装 @deepseek-ai/dsh，或设置 REQFLOW_DSH_BIN 指向 lib/bin.js。');
  launchDirectory = mkdtempSync(join(tmpdir(), 'reqflow-dsh-runtime-'));
  const patch = join(launchDirectory, 'chat.patch.yml');
  const runtime = fileURLToPath(new URL('./dsh_runtime.mjs', import.meta.url));
  writeFileSync(patch, `- id: headless-startup
  disabled: true
- id: headless-runner
  disabled: true
- insert:
    - id: reqflow-chat-runtime
      name: ${JSON.stringify(runtime.replaceAll('\\', '/'))}
`, 'utf8');
  const proc = spawn(process.execPath, [dshBin, '--profile', profile, '--patch', patch], {
    cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DSH_PERMISSION_MODE: permission, REQFLOW_DSH_BIN: dshBin },
  });
  child = proc;
  let buffered = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const row = buffered.slice(0, index).replace(/\r$/, '');
      buffered = buffered.slice(index + 1);
      if (!row.trim()) continue;
      handleEvent(row);
      let event; try { event = JSON.parse(row); } catch { continue; }
      if (event.type === 'ready') clearSpinner();
      if (event.type === 'final') finishTurn();
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', chunk => {
    for (const row of String(chunk).split(/\r?\n/)) {
      if (/^dsh:/i.test(row.trim()) && !/^dsh:\s*reasoning:/i.test(row.trim())) showError(row);
    }
  });
  proc.stdin.on('error', error => { if (!closed) showError(error.message); });
  proc.on('error', error => showError(`无法启动 DeepSeek Harness：${error.message}`));
  proc.on('close', code => {
    if (buffered.trim()) handleEvent(buffered.trim());
    if (child === proc) child = null;
    if (!closed) showError(`DeepSeek Harness 实例已退出（${code}），下次输入将重新启动。`);
    finishTurn();
    if (launchDirectory) { rmSync(launchDirectory, { recursive: true, force: true }); launchDirectory = ''; }
    if (closed) process.exit(0);
    else if (sessionId) { sessionId = ''; freshSession = true; line(yellow('原实例已结束，下一条输入将开始新会话。')); }
  });
  return proc;
}

function finishTurn() {
  clearSpinner();
  if (!printedText && finalText) block(finalText);
  running = false;
  const resolve = pendingTurn; pendingTurn = null;
  resolve?.();
}

function runTurn(task) {
  return new Promise(resolve => {
    running = true; printedText = false; finalText = ''; printedError = '';
    startSpinner(child ? '思考中' : '正在启动 DeepSeek Harness');
    pendingTurn = resolve;
    try {
      const proc = startRuntime();
      proc.stdin.write(JSON.stringify({ type: 'prompt', task: String(task ?? ''), fresh: freshSession }) + '\n', 'utf8');
      freshSession = false;
    } catch (error) { showError(error.message); finishTurn(); }
  });
}

function stopChild() {
  if (!child) return;
  try { child.stdin.write(JSON.stringify({ type: 'cancel' }) + '\n'); } catch { /* ignore */ }
}

function shutdown(code = 0) {
  if (closed) return;
  closed = true;
  clearSpinner();
  stopChild();
  if (rl) rl.close();
  if (!child) { process.exit(code); return; }
  child.stdin.end();
  setTimeout(() => { child?.kill(); process.exit(code); }, 2000).unref();
}

function banner() {
  line(bold('DeepSeek Harness') + (label ? dim(' · ' + label) : ''));
  line(dim(`workspace: ${cwd}`));
  line(dim(`权限：${permissionLabel}` + (permission === 'danger-full-access' ? '' : `（${permission}）`)));
  line(dim('输入消息继续沟通；/exit 退出，/new 开新会话。'));
  line();
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: Boolean(process.stdin.isTTY),
  prompt: process.stdin.isTTY ? '❯ ' : '',
});

// 输入串行处理：一轮执行期间输入的消息排队，当前轮结束后按顺序继续，
// 与 Codex / Claude Code 终端的“边跑边输入”一致。
let chain = Promise.resolve();
let eof = false;

function handleLine(input) {
  const text = String(input ?? '').trim();
  if (!text) { rl.prompt(); return; }
  if (text === '/exit' || text === '/quit') { shutdown(0); return; }
  if (text === '/new') {
    sessionId = ''; freshSession = true;
    line(dim('已开始新会话（复用运行实例）。'));
    rl.prompt();
    return;
  }
  if (text.startsWith('/reqflow-task-file ')) {
    const file = resolve(text.slice('/reqflow-task-file '.length));
    if (dirname(file).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !/^reqflow-dsh-task-.+\.txt$/.test(basename(file))) {
      showError('指派任务文件路径无效'); rl.prompt(); return;
    }
    try {
      const task = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      rmSync(file);
      line(dim('已接收新的指派任务，复用当前实例…'));
      return runTurn(task).then(() => { if (!closed) rl.prompt(); });
    } catch (error) { showError('读取指派任务失败：' + error.message); rl.prompt(); return; }
  }
  if (!rl.terminal) line(dim('❯ ' + text));
  return runTurn(text).then(() => { if (!closed) rl.prompt(); });
}

rl.on('SIGINT', () => {
  if (running) {
    stopChild();
    clearSpinner();
    line(yellow('\n已中止本轮，可继续输入。'));
  } else {
    shutdown(0);
  }
});
rl.on('line', input => {
  if (closed) return;
  chain = chain
    .then(() => (closed ? undefined : handleLine(input)))
    .catch(error => line(red('处理输入失败：' + (error && error.message ? error.message : error))));
});
process.stdin.on('end', () => {
  eof = true;
  chain = chain.then(() => { if (!running) shutdown(0); });
});
process.on('SIGTERM', () => shutdown(0));

function main() {
  banner();
  if (!dshBin) {
    line(red('未找到 DeepSeek Harness（dsh）。请先安装 @deepseek-ai/dsh，或设置 REQFLOW_DSH_BIN 指向 lib/bin.js。'));
    rl.prompt();
    return;
  }
  let firstTask = '';
  if (taskFile) {
    try { firstTask = readFileSync(taskFile, 'utf8').replace(/^\uFEFF/, ''); } catch (error) {
      line(red(`读取指派任务失败：${error.message}`));
    }
  }
  chain = chain.then(async () => {
    if (firstTask.trim()) {
      line(dim('已接收指派任务，开始执行…'));
      await runTurn(firstTask);
      line();
    }
  });
  chain = chain.then(() => { if (!closed && !eof) rl.prompt(); else if (eof && !running) shutdown(0); });
}

main();
