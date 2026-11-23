import { useEffect, useState } from 'react';
import type { Project } from '../core/domain';
import { localDate } from '../core/dates';
import type { StatsLocalUsage, StatsLocalUsageResult, StatsUsageByRun } from './api';

type UsageRow = { key: string; projectId: string; project: string; requirement: string; client: string; model: string; effort: string; input: number; output: number; cached: number; reasoning: number; source: string; shared: boolean; time: string };

const CLIENT_LABELS: Record<string, string> = { codex: 'Codex', zcode: 'ZCode', pi: 'Pi', 'claude-code': 'Claude Code', dsh: 'DeepSeek Harness', opencode: 'OpenCode', antigravity: 'Antigravity' };
export const statsClientLabel = (id: string) => CLIENT_LABELS[id] || id || '未知';

export function statsExecutionClient(event: { execution?: { client?: string; runId?: string }; note?: string }): string {
  const { client = '', runId } = event.execution || {};
  if (client === 'pi' && runId && typeof event.note === 'string' && event.note.startsWith(`[ReqFlow Antigravity run ${runId}]\n`)) return 'antigravity';
  if (client === 'pi' && runId && typeof event.note === 'string' && event.note.startsWith(`[ReqFlow OpenCode run ${runId}]\n`)) return 'opencode';
  return client;
}

const exactTokens = (value: number) => `${value.toLocaleString('zh-CN')} Token`;
export function formatTokens(value: number): string {
  if (value < 10000) return value.toLocaleString('zh-CN');
  const unit = value >= 100000000 ? 100000000 : 10000;
  return `${Number((value / unit).toFixed(2)).toLocaleString('zh-CN')}${unit === 10000 ? '万' : '亿'}`;
}

// Use local calendar days, including days without a collected completion.
// Long histories are bucketed by month to keep the chart legible.
export function usageTrend(rows: UsageRow[], days: number) {
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const times = rows.map(row => Date.parse(row.time)).filter(Number.isFinite);
  const start = days ? new Date(end) : new Date(times.reduce((earliest, time) => Math.min(earliest, time), end.getTime()));
  start.setHours(0, 0, 0, 0);
  if (days) start.setDate(start.getDate() - days + 1);
  const monthly = end.getTime() - start.getTime() > 90 * 86400000;
  const keyOf = (date: Date) => localDate(date).slice(0, monthly ? 7 : 10);
  const sums = new Map<string, number>();
  for (const row of rows) {
    const date = new Date(row.time);
    if (!Number.isFinite(date.getTime())) continue;
    const key = keyOf(date);
    sums.set(key, (sums.get(key) || 0) + row.input + row.output);
  }
  if (monthly) start.setDate(1);
  const points: { date: string; value: number }[] = [];
  for (const cursor = new Date(start); cursor <= end; monthly ? cursor.setMonth(cursor.getMonth() + 1) : cursor.setDate(cursor.getDate() + 1)) {
    const date = keyOf(cursor);
    points.push({ date, value: sums.get(date) || 0 });
  }
  return { monthly, points };
}

function TokenTrend({ rows, days, includeLocal }: { rows: UsageRow[]; days: number; includeLocal: boolean }) {
  const { monthly, points } = usageTrend(rows, days);
  const [focus, setFocus] = useState('');
  const tip = points.find(point => point.date === focus);
  const width = 720, left = 76, right = 12, top = 14, bottom = 162;
  const max = Math.max(1, ...points.map(point => point.value));
  const slot = (width - left - right) / points.length;
  const x = (index: number) => left + slot * (index + 0.5);
  const y = (value: number) => bottom - value / max * (bottom - top);
  const labels = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  return <figure className="token-trend">
    <figcaption><strong>{monthly ? '每月' : '每日'} Token 消耗</strong><span role="status">{tip ? `${tip.date} · ${exactTokens(tip.value)}` : `${includeLocal ? '按任务完成日期与本地会话用量日期汇总' : '按任务完成日期汇总'} · 悬停或聚焦查看精确值`}</span></figcaption>
    <svg viewBox={`0 0 ${width} 198`} role="group" aria-label={`${monthly ? '每月' : '每日'} Token 消耗趋势`}>
      {[0, max / 2, max].map(value => <g key={value} aria-hidden="true">
        <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className="token-grid" />
        <text x={left - 10} y={y(value) + 4} textAnchor="end" className="stats-axis">{formatTokens(Math.round(value))}</text>
      </g>)}
      {points.map((point, index) => <g key={point.date}>
        <rect x={left + index * slot + slot * 0.18} y={y(point.value)} width={slot * 0.64} height={bottom - y(point.value)} rx={Math.min(3, slot * 0.1)} className="token-trend-bar" aria-hidden="true" />
        <rect x={left + index * slot} y={top} width={slot} height={bottom - top} className="token-trend-hit" tabIndex={0} role="img" aria-label={`${point.date}：${exactTokens(point.value)}`} onFocus={() => setFocus(point.date)} onBlur={() => setFocus('')} onPointerEnter={() => setFocus(point.date)} onPointerLeave={() => setFocus('')}>
          <title>{point.date}：{exactTokens(point.value)}</title>
        </rect>
      </g>)}
      {labels.map(index => <text key={index} x={x(index)} y={185} textAnchor="middle" className="stats-axis">{points[index].date}</text>)}
    </svg>
    <details><summary>趋势数据明细</summary><div className="token-usage-scroll"><table className="stats-table"><thead><tr><th>{monthly ? '月份' : '日期'}</th><th>Token 合计</th></tr></thead><tbody>{points.map(point => <tr key={point.date}><td>{point.date}</td><td>{point.value.toLocaleString('zh-CN')}</td></tr>)}</tbody></table></div></details>
  </figure>;
}

function TokenValue({ value }: { value: number }) {
  return <span title={exactTokens(value)} aria-label={exactTokens(value)}>{formatTokens(value)}</span>;
}

function usageRangeStart(days: number, today: string) {
  const start = new Date(today + 'T00:00:00');
  start.setDate(start.getDate() - Math.max(0, days - 1));
  return start;
}

export function taskUsageRows(projects: Project[], days: number, projectId = '', usageByRun: StatsUsageByRun = {}, today = localDate()): UsageRow[] {
  const cutoff = days ? usageRangeStart(days, today).getTime() : 0;
  const end = new Date(today + 'T00:00:00');
  end.setDate(end.getDate() + 1);
  const rows = new Map<string, UsageRow>();
  for (const project of projects) {
    if (projectId && project.id !== projectId) continue;
    for (const item of project.items || []) for (const event of item.history || []) {
      const stamp = Date.parse(event.time);
      if (event.event !== '实现完成' || !Number.isFinite(stamp) || stamp < cutoff || stamp >= end.getTime()) continue;
      const run = event.execution?.runId;
      const client = statsExecutionClient(event);
      const usage = Array.isArray(event.usage) && event.usage.length ? event.usage : client === 'antigravity' && run ? usageByRun[run] : undefined;
      if (!Array.isArray(usage)) continue;
      for (const [index, u] of usage.entries()) {
        const shared = u.scope === 'run';
        // Shared task snapshots may be collected again as each requirement
        // completes. Keep the newest cumulative snapshot, never add copies.
        const key = shared && run && u.sessionId
          ? `${project.id}/${run}/${u.sessionId}/${u.model}/${u.reasoningEffort || ''}`
          : `${project.id}/${item.id}/${event.time}/${index}`;
        const previous = rows.get(key);
        const requirement = previous && !previous.requirement.split('、').includes(item.number) ? `${previous.requirement}、${item.number}` : previous?.requirement || item.number;
        if (previous && Date.parse(previous.time) > Date.parse(event.time)) { previous.requirement = requirement; continue; }
        rows.set(key, { key, projectId: project.id, project: project.name, requirement, client, model: u.model || '未知模型', effort: u.reasoningEffort || '未提供', input: Number(u.inputTokens) || 0, output: Number(u.outputTokens) || 0, cached: Number(u.cachedInputTokens) || 0, reasoning: Number(u.reasoningOutputTokens) || 0, source: u.source || '客户端上报', shared, time: event.time });
      }
    }
  }
  return [...rows.values()];
}

function localUsageRows(sessions: StatsLocalUsage[], projects: Project[], projectId: string, since: string, today: string): UsageRow[] {
  const names = new Map(projects.map(project => [project.id, project.name]));
  return sessions.filter(row => (!projectId || row.projectId === projectId) && row.day >= since && row.day <= today)
    .map(row => ({
      key: JSON.stringify([row.projectId, row.client, row.sessionId, row.day, row.model, row.reasoningEffort]),
      projectId: row.projectId, project: names.get(row.projectId) || '未关联项目', requirement: '本地会话',
      client: row.client, model: row.model, effort: row.reasoningEffort || '未提供', input: row.inputTokens,
      output: row.outputTokens, cached: row.cachedInputTokens || 0, reasoning: row.reasoningOutputTokens || 0,
      source: 'Agent 本地会话', shared: false, time: row.day + 'T00:00:00',
    }));
}

export function TokenUsage({ projects, days, projectId, today, loadLocalUsage }: {
  projects: Project[]; days: number; projectId: string; today: string;
  loadLocalUsage?: (since: string) => Promise<StatsLocalUsageResult>;
}) {
  const [group, setGroup] = useState('model');
  const [includeLocal, setIncludeLocal] = useState(false);
  const [localUsage, setLocalUsage] = useState<StatsLocalUsageResult | null>(null);
  const since = days ? usageRangeStart(days, today).toISOString() : '';

  useEffect(() => {
    setLocalUsage(null);
    if (!includeLocal) return;
    if (!loadLocalUsage) {
      setLocalUsage({ ok: false, error: '本地会话用量需要桌面版' });
      return;
    }
    let cancelled = false;
    loadLocalUsage(since).then(result => {
      if (!cancelled) setLocalUsage(result);
    }).catch(() => {
      if (!cancelled) setLocalUsage({ ok: false, error: '读取本地会话用量失败，可重新勾选重试' });
    });
    return () => { cancelled = true; };
  }, [includeLocal, since, projects, loadLocalUsage]);

  const supplemental = includeLocal && localUsage?.ok ? localUsage : null;
  const rows = taskUsageRows(projects, days, projectId, supplemental?.usageByRun, today);
  if (supplemental) rows.push(...localUsageRows(supplemental.sessions, projects, projectId, days ? localDate(new Date(since)) : '', today));
  const groups = new Map<string, { label: string; input: number; output: number; cached: number; reasoning: number }>();
  for (const row of rows) {
    const label = group === 'model' ? `${row.model} · ${row.effort}` : group === 'project' ? row.project : `${row.project} · ${row.requirement}${row.shared ? '（共享执行）' : ''}`;
    const key = group === 'model' ? label : `${row.projectId}/${group === 'project' ? '' : row.requirement}`;
    const sum = groups.get(key) || { label, input: 0, output: 0, cached: 0, reasoning: 0 };
    sum.input += row.input; sum.output += row.output; sum.cached += row.cached; sum.reasoning += row.reasoning;
    groups.set(key, sum);
  }
  const totals = rows.reduce((sum, row) => ({ input: sum.input + row.input, output: sum.output + row.output, cached: sum.cached + row.cached, reasoning: sum.reasoning + row.reasoning }), { input: 0, output: 0, cached: 0, reasoning: 0 });
  const total = totals.input + totals.output;
  const ranked = [...groups].sort((a, b) => b[1].input + b[1].output - a[1].input - a[1].output);
  const largest = Math.max(1, ...ranked.map(([, sum]) => sum.input + sum.output));
  return <div className="stats-chart-block token-usage-block">
    <div className="stats-chart-head">
      <h4>任务 Token 消耗</h4>
      <div className="segmented" role="group" aria-label="Token 统计维度">{[['model', '模型与思考等级'], ['project', '项目'], ['requirement', '需求']].map(([id, label]) => <button type="button" key={id} aria-pressed={group === id} className={group === id ? 'on' : ''} onClick={() => setGroup(id)}>{label}</button>)}</div>
      <label className="fb-show-hidden token-local-check"><input type="checkbox" checked={includeLocal} onChange={e => setIncludeLocal(e.target.checked)} />计入 Agent 本地会话</label>
    </div>
    <p className="settings-hint">默认统计已回写用量的完成任务。未采集不代表零消耗。缓存输入与推理输出已包含在总量中，共享执行只计一次。</p>
    {includeLocal && <p className="settings-hint" role="status">{!localUsage ? '正在读取本地会话用量…' : localUsage.ok ? '本地会话按实际用量日期统计。未关联项目的会话可在「全部」项目中查看。' : localUsage.error}</p>}
    {!rows.length ? <p className="settings-hint">当前筛选范围暂无已采集用量。</p> : <>
      <div className="token-summary">
        {[['总消耗', total, '输入 + 输出'], ['输入', totals.input, `其中缓存 ${formatTokens(totals.cached)}`], ['输出', totals.output, `其中推理 ${formatTokens(totals.reasoning)}`]].map(([label, value, hint]) => <div className="token-summary-card" key={label}><span>{label}</span><strong><TokenValue value={Number(value)} /><small>Token</small></strong><span>{hint}</span></div>)}
        <div className="token-summary-card"><span>缓存输入占比</span><strong>{totals.input ? `${(totals.cached / totals.input * 100).toFixed(1)}%` : '—'}</strong><span title={exactTokens(totals.cached)}>已采集缓存 / 输入</span></div>
      </div>
      <TokenTrend rows={rows} days={days} includeLocal={!!supplemental} />
      <div className="token-ranking"><h4>{group === 'model' ? '模型与思考等级' : group === 'project' ? '项目' : '需求'}消耗排行 <span>前 {Math.min(8, ranked.length)} 项 · 合计占比</span></h4>
        {ranked.slice(0, 8).map(([key, sum]) => { const value = sum.input + sum.output; return <div className="token-rank-row" key={key} title={`${sum.label}：${exactTokens(value)}`}>
          <span className="token-rank-label">{sum.label}</span><span className="token-rank-track" aria-hidden="true"><span style={{ width: `${value / largest * 100}%` }} /></span><strong><TokenValue value={value} /></strong><span>{total ? `${(value / total * 100).toFixed(1)}%` : '—'}</span>
        </div>; })}
      </div>
      <p className="settings-hint">悬停数值可查看精确 Token 数。无采集记录的日期显示 0。</p>
      <div className="token-usage-scroll"><table className="stats-table"><thead><tr><th>{group === 'model' ? '模型 · 思考等级' : group === 'project' ? '项目' : '需求'}</th><th>输入</th><th>其中缓存</th><th>输出</th><th>其中推理</th><th>合计</th></tr></thead><tbody>{ranked.map(([key, sum]) => <tr key={key}><td>{sum.label}</td><td><TokenValue value={sum.input} /></td><td><TokenValue value={sum.cached} /></td><td><TokenValue value={sum.output} /></td><td><TokenValue value={sum.reasoning} /></td><td><TokenValue value={sum.input + sum.output} /></td></tr>)}</tbody></table></div>
      <details><summary>采集明细与来源 · {rows.length}</summary><div className="token-usage-scroll"><table className="stats-table"><thead><tr><th>项目 / 需求</th><th>客户端</th><th>模型</th><th>思考等级</th><th>Token（精确值）</th><th>来源</th></tr></thead><tbody>{rows.map(row => <tr key={row.key}><td>{row.project} / {row.requirement}{row.shared ? '（共享执行）' : ''}</td><td>{statsClientLabel(row.client)}</td><td>{row.model}</td><td>{row.effort}</td><td>{(row.input + row.output).toLocaleString('zh-CN')}</td><td>{row.source}</td></tr>)}</tbody></table></div></details>
    </>}
  </div>;
}
