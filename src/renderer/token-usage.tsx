import { useState } from 'react';
import type { Project } from '../core/domain';

type UsageRow = { key: string; projectId: string; project: string; requirement: string; model: string; effort: string; input: number; output: number; cached: number; reasoning: number; source: string; shared: boolean; time: string };

export function taskUsageRows(projects: Project[], days: number, projectId = ''): UsageRow[] {
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - Math.max(0, days - 1));
  const cutoff = days ? start.getTime() : 0;
  const rows = new Map<string, UsageRow>();
  for (const project of projects) {
    if (projectId && project.id !== projectId) continue;
    for (const item of project.items || []) for (const event of item.history || []) {
      if (event.event !== '实现完成' || !Array.isArray(event.usage) || Date.parse(event.time) < cutoff) continue;
      for (const [index, u] of event.usage.entries()) {
        const shared = u.scope === 'run';
        const run = event.execution?.runId;
        // Shared task snapshots may be collected again as each requirement
        // completes. Keep the newest cumulative snapshot, never add copies.
        const key = shared && run && u.sessionId
          ? `${project.id}/${run}/${u.sessionId}/${u.model}/${u.reasoningEffort || ''}`
          : `${project.id}/${item.id}/${event.time}/${index}`;
        const previous = rows.get(key);
        const requirement = previous && !previous.requirement.split('、').includes(item.number) ? `${previous.requirement}、${item.number}` : previous?.requirement || item.number;
        if (previous && Date.parse(previous.time) > Date.parse(event.time)) { previous.requirement = requirement; continue; }
        rows.set(key, { key, projectId: project.id, project: project.name, requirement, model: u.model || '未知模型', effort: u.reasoningEffort || '未提供', input: Number(u.inputTokens) || 0, output: Number(u.outputTokens) || 0, cached: Number(u.cachedInputTokens) || 0, reasoning: Number(u.reasoningOutputTokens) || 0, source: u.source || '客户端上报', shared, time: event.time });
      }
    }
  }
  return [...rows.values()];
}

export function TokenUsage({ projects, days, projectId }: { projects: Project[]; days: number; projectId: string }) {
  const [group, setGroup] = useState('model');
  const rows = taskUsageRows(projects, days, projectId);
  const groups = new Map<string, { label: string; input: number; output: number; cached: number; reasoning: number }>();
  for (const row of rows) {
    const label = group === 'model' ? `${row.model} · ${row.effort}` : group === 'project' ? row.project : `${row.project} · ${row.requirement}${row.shared ? '（共享执行）' : ''}`;
    const key = group === 'model' ? label : `${row.projectId}/${group === 'project' ? '' : row.requirement}`;
    const sum = groups.get(key) || { label, input: 0, output: 0, cached: 0, reasoning: 0 };
    sum.input += row.input; sum.output += row.output; sum.cached += row.cached; sum.reasoning += row.reasoning;
    groups.set(key, sum);
  }
  const total = rows.reduce((sum, row) => sum + row.input + row.output, 0);
  return <div className="stats-chart-block token-usage-block">
    <div className="stats-chart-head"><h4>任务 Token 消耗 · {total.toLocaleString()}</h4><div className="segmented" role="group" aria-label="Token 统计维度">{[['model', '模型与思考等级'], ['project', '项目'], ['requirement', '需求']].map(([id, label]) => <button type="button" key={id} aria-pressed={group === id} className={group === id ? 'on' : ''} onClick={() => setGroup(id)}>{label}</button>)}</div></div>
    <p className="settings-hint">仅统计实际采集或上报的已完成任务。未采集不代表零消耗；缓存输入和推理输出已包含在输入、输出中。共享执行只计一次，需求维度标注共享，不估算分摊。遵循当前时间范围与项目筛选。</p>
    {!rows.length ? <p className="settings-hint">暂无已采集用量。Codex 可读取精确会话记录；其他客户端可随完成报告上报实际用量。</p> : <>
      <div className="token-usage-scroll"><table className="stats-table"><thead><tr><th>{group === 'model' ? '模型 · 思考等级' : group === 'project' ? '项目' : '需求'}</th><th>输入</th><th>缓存输入</th><th>输出</th><th>推理输出</th><th>合计</th></tr></thead><tbody>{[...groups].sort((a, b) => b[1].input + b[1].output - a[1].input - a[1].output).map(([key, sum]) => <tr key={key}><td>{sum.label}</td><td>{sum.input.toLocaleString()}</td><td>{sum.cached.toLocaleString()}</td><td>{sum.output.toLocaleString()}</td><td>{sum.reasoning.toLocaleString()}</td><td>{(sum.input + sum.output).toLocaleString()}</td></tr>)}</tbody></table></div>
      <details><summary>采集明细与来源 · {rows.length}</summary><div className="token-usage-scroll"><table className="stats-table"><thead><tr><th>项目 / 需求</th><th>模型</th><th>思考等级</th><th>Token</th><th>来源</th></tr></thead><tbody>{rows.map(row => <tr key={row.key}><td>{row.project} / {row.requirement}{row.shared ? '（共享执行）' : ''}</td><td>{row.model}</td><td>{row.effort}</td><td>{(row.input + row.output).toLocaleString()}</td><td>{row.source}</td></tr>)}</tbody></table></div></details>
    </>}
  </div>;
}
