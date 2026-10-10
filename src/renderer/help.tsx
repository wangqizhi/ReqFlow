// 帮助页 —— 应用内展示 CLI 命令参考与 Agent 对接说明。
// 数据来自 src/core/cli-help.ts（与 `--cli help` 输出同源，保证一致）。

import { useEffect, useState } from 'react';
import { CLI_DOCS, CLI_GLOBAL_OPTIONS, CLI_NOTES, CLI_USAGE } from '../core/cli-help';
import { bridge } from './api';
import { Check, Copy, FolderOpen, Terminal, X } from './icons';

const AGENT_SNIPPET = `# Node.js 子进程调用示例（Agent 对接推荐方式）
import { execFile } from 'node:child_process';

function reqflow(...args) {
  return new Promise((resolve, reject) => {
    // 路径换成实际安装位置，例如 C:\\Users\\<用户>\\AppData\\Local\\Programs\\ReqFlow\\ReqFlow.exe
    execFile('ReqFlow.exe', ['--cli', ...args], { windowsHide: true }, (err, stdout) => {
      const payload = JSON.parse(stdout);          // 永远返回单行 JSON
      if (err || payload.ok === false) reject(new Error(payload.error));
      else resolve(payload);
    });
  });
}

await reqflow('project', 'list');                                  // 1. 拿项目 id
await reqflow('item', 'add', '--project', pid, '--title', '登录限流');
await reqflow('generate', '--project', pid, '--items', id1);       // 2. 生成批次
const { prompt } = await reqflow('batch', 'show', '--project', pid, '--id', bid);
await reqflow('submit', '--project', pid, '--batch', bid);         // 3. 确认提交给 AI
await reqflow('complete', '--project', pid, '--id', id1);          // 4. AI 完成后
await reqflow('verify', '--project', pid, '--id', id1, '--pass', 'true');`;

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<{ version: string; dataFile: string; platform?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    bridge.appInfo().then(setInfo).catch(() => setInfo(null));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function copyExe() {
    try {
      const exe = info?.platform === 'browser' ? 'ReqFlow.exe' : 'ReqFlow.exe';
      await navigator.clipboard.writeText(exe);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 剪贴板不可用时忽略 */ }
  }

  return (
    <div className="overlay" role="dialog" aria-label="帮助与 CLI 参考">
      <div className="help-panel">
        <header className="help-header">
          <div>
            <h2>帮助 · CLI 命令参考</h2>
            <p>ReqFlow {info?.version ?? ''} — 图形界面与命令行共用同一份本地数据，可放心混用。</p>
          </div>
          <button className="icon-btn" aria-label="关闭帮助" onClick={onClose}><X size={20} /></button>
        </header>

        <div className="help-body">
          <section>
            <h3><Terminal size={16} /> 快速上手</h3>
            <ol className="help-steps">
              <li>左侧新建或切换项目，在「需求池」里记录需求（标题、说明、验收条件）。</li>
              <li>勾选需求点击「排期」，需求进入「排期表」。使用 ReqFlow Agent 读取并完成已排期需求。</li>
              <li>开发完成后点击需求卡片或上方的「提交验证」进入待验证；需要修改时退回待执行。</li>
              <li>人工检查：通过则归档；未通过填写原因退回，原因自动带入下一轮 Prompt。</li>
            </ol>
          </section>

          <section>
            <h3><Terminal size={16} /> CLI 用法</h3>
            <p className="help-desc">
              命令行模式不打开窗口，直接读写本地工作区并输出 JSON（成功 <code>{'{"ok":true,...}'}</code>，失败 <code>{'{"ok":false,"error":...}'}</code>，退出码 0/1）。
              这是对接 Agent / 脚本自动化的推荐入口。
            </p>
            <div className="code-line"><code>{CLI_USAGE}</code></div>
            <table className="help-table">
              <thead><tr><th>全局选项</th><th>说明</th></tr></thead>
              <tbody>
                {CLI_GLOBAL_OPTIONS.map((o) => (
                  <tr key={o.name}><td><code>{o.name}</code></td><td>{o.desc}</td></tr>
                ))}
              </tbody>
            </table>
            {CLI_DOCS.map((g) => (
              <div key={g.group} className="help-group">
                <h4>{g.group}<small>{g.desc}</small></h4>
                <table className="help-table">
                  <tbody>
                    {g.commands.map((c) => (
                      <tr key={c.name}>
                        <td><code>{c.name}</code><span className="args">{c.args}</span></td>
                        <td>{c.desc}{c.example && <span className="example">例：{c.example}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <ul className="help-notes">
              {CLI_NOTES.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          </section>

          <section>
            <h3><Terminal size={16} /> Agent 对接示例</h3>
            <pre className="help-code">{AGENT_SNIPPET}</pre>
            <p className="help-desc">
              Windows 图形程序在部分终端直接运行时可能不显示输出；子进程管道读取始终有效。
              交互调试可用 <code>ReqFlow.exe --cli help | more</code> 或重定向到文件。
            </p>
          </section>

          <section>
            <h3><FolderOpen size={16} /> 数据与备份</h3>
            <p className="help-desc">
              全部数据保存在本地单个文件中：{info ? <code>{info.dataFile}</code> : '正在读取…'}
            </p>
            <div className="help-actions">
              <button className="btn ghost" onClick={() => bridge.showDataFile?.()}>
                <FolderOpen size={15} /> 在资源管理器中显示
              </button>
              <button className="btn ghost" onClick={copyExe}>
                {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? '已复制' : '复制可执行文件名'}
              </button>
            </div>
            <p className="help-desc">备份：直接复制该文件；迁移：菜单「导出全部数据」后在其他机器用 <code>--cli workspace import</code> 导入。</p>
          </section>
        </div>
      </div>
    </div>
  );
}
