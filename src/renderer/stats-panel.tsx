// 数据看板：从工作区数据派生需求与 AI 执行统计，全部前端计算。
// 图表遵循 docs/ui-guidelines.md 与数据可视化规范：每图单轴、单系列单色（槽 1 蓝）、
// hairline 实线网格、2px 线宽 + 白环端点、crosshair 悬浮提示与明细表兜底；
// 次数与时长分图呈现，不做双坐标轴。文案与轴刻度用文字色，不借用系列色。
// REQ-190：点击项目进入里程碑视图，把 Git 提交历史呈现为带 commit log 文案的时间轴。
import { useEffect, useMemo, useState } from 'react';
import { activeAIExecution, type Item, type Project, type Workspace } from '../core/domain';
import { localDate } from '../core/dates';
import { bridge, type GitCommit, type GitMilestoneInfo } from './api';
import { ActivityCalendar } from './stats-calendar';
import { ChevronRight, GitBranch, RefreshCw } from './icons';

const SERIES_BLUE = '#2a78d6';        // 分类槽 1（白面板 4.6:1）
const TRACK_BLUE = '#cde2fb';         // 同 ramp 浅阶，条形图轨道
const RANGES: [label: string, days: number][] = [['近 7 天', 7], ['近 14 天', 14], ['近 30 天', 30], ['全部', 0]];
const CLIENT_LABELS: Record<string, string> = { codex: 'Codex', zcode: 'ZCode', pi: 'Pi', 'claude-code': 'Claude Code', dsh: 'DeepSeek Harness', opencode: 'OpenCode' };

function dayKeyOf(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : localDate(new Date(t));
}
function createdTime(item: Item): string | undefined {
  const hit = (item.history || []).find((e: any) => e?.event === '创建' && typeof e.time === 'string');
  return hit?.time || item.flowEvents?.[0]?.time;
}
function dayLabel(key: string): string {
  const [, m, d] = key.split('-');
  return `${Number(m)}月${Number(d)}日`;
}
function formatMinutes(min: number): string {
  if (min <= 0) return '0 分钟';
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}
function compact(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}
// 把最大值抬升到 1-2-5 良值，保证 y 轴刻度干净
function niceMax(max: number): number {
  if (max <= 5) return Math.max(1, Math.ceil(max));
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) if (max <= step * pow) return step * pow;
  return 10 * pow;
}

type DayValue = { day: string; value: number };

/** 单系列折线图：hairline 网格、末端值标签、crosshair 悬浮提示（值为主、名称为辅）。 */
function LineChart({ title, points, unit = '', width, height = 176 }: { title: string; points: DayValue[]; unit?: string; width: number; height?: number }) {
  const [hover, setHover] = useState(-1);
  const padL = 38, padR = 14, padT = 12, padB = 22;
  const plotW = Math.max(10, width - padL - padR), plotH = Math.max(10, height - padT - padB);
  const max = niceMax(points.reduce((m, p) => Math.max(m, p.value), 0));
  const x = (i: number) => padL + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => padT + (1 - v / max) * plotH;
  const ticks = [0, max / 2, max];
  // 半宽图只放首尾标签，避免日期相邻拥挤；全宽图取 4 个均匀位置
  const labelIdx = points.length > 1
    ? (width > 500 ? [0, Math.floor((points.length - 1) / 3), Math.floor(((points.length - 1) * 2) / 3), points.length - 1] : [0, points.length - 1])
    : [0];
  const tip = hover >= 0 && hover < points.length ? points[hover] : null;
  const tipLeft = tip ? Math.min(Math.max(x(hover) + 12, 6), width - 132) : 0;
  const last = points.length - 1, lastPoint = points[last];
  return <figure className="stats-chart" style={{ width }}>
    <div className="stats-plot" style={{ width, height }} role="img" aria-label={`${title}，共 ${points.length} 天，最大值 ${max}${unit}`}
      onPointerMove={e => {
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = ((e.clientX - rect.left) * width / rect.width - padL) / plotW;
        setHover(Math.round((points.length - 1) * Math.min(1, Math.max(0, ratio))));
      }}
      onPointerLeave={() => setHover(-1)}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {ticks.map(t => <g key={t}>
          <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
          <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" className="stats-axis">{compact(t)}</text>
        </g>)}
        {labelIdx.map((i, n) => <text key={n} x={Math.min(Math.max(x(i), padL), width - padR)} y={height - 6} textAnchor={n === 0 ? 'start' : n === labelIdx.length - 1 ? 'end' : 'middle'} className="stats-axis">{dayLabel(points[i].day)}</text>)}
        <path d={points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ')} fill="none" stroke={SERIES_BLUE} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {lastPoint && <g>
          <circle cx={x(last)} cy={y(lastPoint.value)} r={4.5} fill={SERIES_BLUE} stroke="#fff" strokeWidth={2} />
          <text x={x(last) - 8} y={Math.max(12, y(lastPoint.value) - 8)} textAnchor="end" className="stats-end-value">{compact(lastPoint.value)}{unit}</text>
        </g>}
        {tip && <g>
          <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} stroke="var(--line-2)" strokeWidth={1} />
          <circle cx={x(hover)} cy={y(tip.value)} r={4.5} fill={SERIES_BLUE} stroke="#fff" strokeWidth={2} />
        </g>}
      </svg>
      {tip && <div className="stats-tooltip" style={{ left: tipLeft, top: Math.max(4, y(tip.value) - 44) }}>
        <p className="stats-tooltip-day">{dayLabel(tip.day)}</p>
        <p className="stats-tooltip-row"><strong>{compact(tip.value)}{unit}</strong>{title}</p>
      </div>}
    </div>
  </figure>;
}

/** 单色水平条形列表：类别身份由行标签承载，条形恒用槽 1 蓝，值标注在条尾之外。 */
function BarList({ rows, unit = '', onSelect }: { rows: { id?: string; label: string; value: number; hint?: string }[]; unit?: string; onSelect?(id: string): void }) {
  const max = Math.max(...rows.map(r => r.value), 1);
  return <div className="stats-bars">
    {rows.length === 0 && <p className="settings-hint">暂无数据</p>}
    {rows.map(r => <div className="stats-bar-row" key={r.id || r.label} title={r.hint || `${r.label}：${r.value}${unit}`}>
      {onSelect && r.id ? <button type="button" className="stats-bar-label stats-project-link" title={`查看 ${r.label} 的里程碑`} onClick={() => onSelect(r.id!)}>{r.label}</button> : <span className="stats-bar-label">{r.label}</span>}
      <span className="stats-bar-track"><span className="stats-bar-fill" style={{ width: `${(r.value / max) * 100}%` }} /></span>
      <span className="stats-bar-value">{compact(r.value)}{unit}</span>
    </div>)}
  </div>;
}

type MilestoneState = { loading: boolean; error: string; data: GitMilestoneInfo | null; missing?: 'dir' | 'desktop' };

function commitDate(commit: GitCommit): Date | null {
  const value = new Date(commit.date);
  return Number.isNaN(value.getTime()) ? null : value;
}
function dateParts(commit: GitCommit): { month: string; day: string; time: string; full: string } {
  const date = commitDate(commit);
  if (!date) return { month: '未知', day: '--', time: '', full: commit.date };
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    month: `${date.getFullYear()} 年 ${pad(date.getMonth() + 1)} 月`,
    day: `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    full: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}
function refLabel(ref: string): string {
  if (ref.startsWith('HEAD -> ')) return 'HEAD · ' + ref.slice(8);
  if (ref.startsWith('tag: ')) return ref.slice(5);
  if (ref === 'HEAD') return 'HEAD';
  return ref;
}

/** 里程碑时间轴：每个提交是一个节点，标注 commit log 文案、作者与短哈希。 */
function MilestoneTimeline({ commits }: { commits: GitCommit[] }) {
  const groups = useMemo(() => {
    const list: { month: string; commits: GitCommit[] }[] = [];
    for (const commit of commits) {
      const month = dateParts(commit).month;
      const last = list[list.length - 1];
      if (last && last.month === month) last.commits.push(commit);
      else list.push({ month, commits: [commit] });
    }
    return list;
  }, [commits]);
  return <div className="milestone-timeline">
    {groups.map(group => <section className="milestone-month" key={group.month}>
      <h3>{group.month}<span>{group.commits.length} 个里程碑</span></h3>
      <div className="milestone-list">
        {group.commits.map(commit => {
          const parts = dateParts(commit);
          const refs = commit.refs.filter(ref => ref === 'HEAD' || ref.startsWith('HEAD ->') || ref.startsWith('tag:'));
          const head = refs.some(ref => ref === 'HEAD' || ref.startsWith('HEAD ->'));
          return <article className={'milestone-item' + (head ? ' head' : '')} key={commit.hash}>
            <div className="milestone-date"><strong>{parts.day}</strong><span>{parts.time}</span></div>
            <div className="milestone-rail" aria-hidden="true"><span className="milestone-dot" /></div>
            <div className="milestone-card">
              <div className="milestone-card-head">
                <strong>{commit.subject || '（无提交信息）'}</strong>
                {refs.length > 0 && <span className="milestone-refs">{refs.slice(0, 3).map(ref => <span className="milestone-ref" key={ref}>{refLabel(ref)}</span>)}</span>}
              </div>
              {commit.body && <p className="milestone-body" title={commit.body}>{commit.body}</p>}
              <div className="milestone-meta">
                <span className="milestone-avatar" aria-hidden="true">{Array.from(commit.author || '?')[0]}</span>
                <span>{commit.author || '未知作者'}</span>
                <code title={commit.hash}>{commit.short || commit.hash.slice(0, 7)}</code>
                <time dateTime={commit.date} title={parts.full}>{parts.full}</time>
              </div>
            </div>
          </article>;
        })}
      </div>
    </section>)}
  </div>;
}

function MilestoneView({ project, state, onBack, onReload }: { project: Project; state: MilestoneState; onBack(): void; onReload(): void }) {
  const commits = state.data?.commits || [];
  const authors = new Set(commits.map(commit => commit.author).filter(Boolean));
  const newest = commits[0] && dateParts(commits[0]);
  const oldest = commits.length > 1 && dateParts(commits[commits.length - 1]);
  const span = oldest && newest ? `${oldest.full.slice(0, 10)} → ${newest.full.slice(0, 10)}` : newest ? newest.full.slice(0, 10) : '—';
  return <section className="milestone-view" aria-label={`${project.name} 里程碑`}>
    <header className="milestone-hero">
      <div className="milestone-hero-main">
        <button type="button" className="btn milestone-back" onClick={onBack}><ChevronRight size={15} />返回统计</button>
        <p className="eyebrow">PROJECT MILESTONES</p>
        <h2>{project.name}</h2>
        <p className="milestone-hero-path"><GitBranch size={14} />{state.data?.branch || '未检测到分支'}<code title={project.dir}>{project.dir || '未关联本地目录'}</code></p>
      </div>
      <div className="milestone-stats">
        <div className="milestone-stat"><strong>{state.loading ? '—' : compact(state.data?.total || commits.length)}</strong><span>提交总数</span></div>
        <div className="milestone-stat"><strong>{state.loading ? '—' : compact(commits.length)}</strong><span>已展示</span></div>
        <div className="milestone-stat"><strong>{state.loading ? '—' : compact(authors.size)}</strong><span>参与作者</span></div>
        <div className="milestone-stat"><strong className="milestone-span">{state.loading ? '—' : span}</strong><span>时间跨度</span></div>
      </div>
    </header>
    <div className="milestone-toolbar">
      <h3>提交历史即里程碑</h3>
      <button type="button" className="btn" disabled={state.loading || state.missing !== undefined} onClick={onReload}><RefreshCw size={15} />{state.loading ? '读取中…' : '刷新'}</button>
    </div>
    {state.loading && <div className="milestone-empty milestone-loading"><strong>正在读取 Git 历史…</strong><span>位置：{project.dir || '未关联本地目录'}</span></div>}
    {!state.loading && state.missing === 'dir' && <div className="milestone-empty">
      <strong>还没有关联本地目录</strong>
      <span>在「编辑设置 · 关联目录」绑定项目目录后，就能按 Git 提交历史生成里程碑。</span>
      <span>没有 Git 时仍可正常记录与排期需求，绑定后将自动读取提交。</span>
    </div>}
    {!state.loading && state.missing === 'desktop' && <div className="milestone-empty"><strong>里程碑需要桌面版</strong><span>浏览器预览无法读取本地 Git 历史，请使用 ReqFlow 桌面版查看。</span></div>}
    {!state.loading && !state.missing && state.error && <div className="milestone-empty"><strong>读取 Git 历史失败</strong><span>{state.error}</span><span>请确认目录存在且 Git 可用，然后点「刷新」重试。</span></div>}
    {!state.loading && !state.missing && !state.error && state.data && !state.data.repo && <div className="milestone-empty">
      <strong>这个目录还不是 Git 仓库</strong>
      <span>在项目目录执行 <code>git init</code> 并完成首次提交后，提交历史会在这里成为里程碑。</span>
    </div>}
    {!state.loading && !state.missing && !state.error && state.data?.repo && commits.length === 0 && <div className="milestone-empty"><strong>仓库还没有提交记录</strong><span>完成第一次提交后，这里会出现第一个里程碑。</span></div>}
    {!state.loading && !state.missing && !state.error && commits.length > 0 && <>
      <p className="milestone-legend"><span className="milestone-dot" aria-hidden="true" />每个节点对应一条 Git 提交；带标签或位于 HEAD 的提交会额外标记。</p>
      <MilestoneTimeline commits={commits} />
      {!!state.data?.total && state.data.total > commits.length && <p className="settings-hint">仅展示最近 {commits.length} 条提交（仓库共 {state.data.total} 条）。</p>}
    </>}
  </section>;
}

export function StatsPanel({ workspace }: { workspace?: Workspace | null }) {
  const [range, setRange] = useState(7);
  const [projectId, setProjectId] = useState(''); // 空 = 全部项目合计
  const [showTable, setShowTable] = useState(false);
  const [milestoneId, setMilestoneId] = useState('');
  const [milestones, setMilestones] = useState<MilestoneState>({ loading: false, error: '', data: null });
  const [reload, setReload] = useState(0);

  const projects = workspace?.projects || [];
  const milestoneDir = projects.find(p => p.id === milestoneId)?.dir || '';

  // REQ-190：点击项目后读取该项目目录的 Git 历史（只读，最多 120 条）。
  useEffect(() => {
    if (!milestoneId) return;
    if (!milestoneDir) { setMilestones({ loading: false, error: '', data: null, missing: 'dir' }); return; }
    if (!bridge.gitMilestones) { setMilestones({ loading: false, error: '', data: null, missing: 'desktop' }); return; }
    let cancelled = false;
    setMilestones({ loading: true, error: '', data: null });
    bridge.gitMilestones(milestoneDir, 120).then(r => {
      if (cancelled) return;
      if (!r.ok) setMilestones({ loading: false, error: r.error || '读取 Git 历史失败', data: null });
      else setMilestones({ loading: false, error: '', data: r });
    }).catch((e: any) => { if (!cancelled) setMilestones({ loading: false, error: e?.message || '读取 Git 历史失败', data: null }); });
    return () => { cancelled = true; };
  }, [milestoneId, milestoneDir, reload]);

  // 全量事件流：创建（按项目）、AI 领取（按客户端）、已完成执行的时长（按领取日归组）
  const events = useMemo(() => {
    const created: { day: string; project: string }[] = [];
    const claims: { day: string; client: string }[] = [];
    const finished: { day: string }[] = [];          // 实现完成且带 AI 执行快照
    const durations: { day: string; minutes: number }[] = []; // 完成 + 释放的真实用时
    for (const project of workspace?.projects || []) {
      for (const item of project.items || []) {
        const c = createdTime(item);
        if (c) created.push({ day: dayKeyOf(c), project: project.id });
        for (const e of item.history || []) {
          if (e?.event === 'AI 领取任务' && typeof e.time === 'string') claims.push({ day: dayKeyOf(e.time), client: String(e.client || '') || '未知' });
          const execution = e?.event === '实现完成' || e?.event === '释放 AI 任务' ? e.execution : null;
          if (execution?.startedAt) {
            const day = dayKeyOf(execution.startedAt);
            if (e.event === '实现完成') finished.push({ day });
            const ms = Number(execution.durationMs);
            if (Number.isFinite(ms) && ms > 0) durations.push({ day, minutes: Math.round(ms / 60000) });
          }
        }
      }
    }
    return { created, claims, finished, durations };
  }, [workspace]);

  // 范围内日期序列（旧 → 新）；「全部」从数据最早一天起
  const days = useMemo(() => {
    const all = [...events.created, ...events.claims, ...events.finished, ...events.durations].map(e => e.day).filter(Boolean).sort();
    const start = range === 0 ? (all[0] || localDate(new Date(Date.now() - 6 * 864e5))) : localDate(new Date(Date.now() - (range - 1) * 864e5));
    const end = localDate();
    const list: string[] = [];
    for (let t = new Date(start + 'T00:00:00'), last = new Date(end + 'T00:00:00'); t <= last && list.length < 400; t = new Date(t.getTime() + 864e5)) list.push(localDate(t));
    return list;
  }, [events, range]);

  const inRange = useMemo(() => {
    const set = new Set(days);
    return { created: events.created.filter(e => set.has(e.day)), claims: events.claims.filter(e => set.has(e.day)), finished: events.finished.filter(e => set.has(e.day)), durations: events.durations.filter(e => set.has(e.day)) };
  }, [events, days]);

  const projectRows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of inRange.created) counts.set(e.project, (counts.get(e.project) || 0) + 1);
    return (workspace?.projects || []).map(p => ({ id: p.id, label: p.name, value: counts.get(p.id) || 0 })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  }, [inRange, workspace]);

  const clientRows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of inRange.claims) counts.set(e.client, (counts.get(e.client) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([client, value]) => ({ label: CLIENT_LABELS[client] || client, value }));
  }, [inRange]);

  const series = useMemo(() => {
    const byDay = (rows: { day: string }[]) => {
      const counts = new Map<string, number>();
      for (const e of rows) counts.set(e.day, (counts.get(e.day) || 0) + 1);
      return days.map(day => ({ day, value: counts.get(day) || 0 }));
    };
    const minutes = new Map<string, number>();
    for (const e of inRange.durations) minutes.set(e.day, (minutes.get(e.day) || 0) + e.minutes);
    return {
      created: byDay(projectId ? inRange.created.filter(e => e.project === projectId) : inRange.created),
      claims: byDay(inRange.claims),
      finished: byDay(inRange.finished),
      minutes: days.map(day => ({ day, value: minutes.get(day) || 0 })),
    };
  }, [days, inRange, projectId]);

  const totals = useMemo(() => ({
    created: inRange.created.length,
    claims: inRange.claims.length,
    finished: inRange.finished.length,
    minutes: inRange.durations.reduce((sum, e) => sum + e.minutes, 0),
    executing: (workspace?.projects || []).reduce((sum, p) => sum + (p.items || []).filter(i => activeAIExecution(i)).length, 0),
  }), [inRange, workspace]);

  const currentName = projectId ? projects.find(p => p.id === projectId)?.name : '';
  const milestoneProject = milestoneId ? projects.find(p => p.id === milestoneId) : undefined;

  if (milestoneProject) return <MilestoneView project={milestoneProject} state={milestones}
    onBack={() => setMilestoneId('')} onReload={() => setReload(n => n + 1)} />;

  return <section className="stats-panel" aria-label="数据面板">
    <div className="stats-filters">
      <div className="segmented" role="group" aria-label="统计时间范围">{RANGES.map(([label, value]) => <button key={value} aria-pressed={range === value} className={range === value ? 'on' : ''} onClick={() => setRange(value)}>{label}</button>)}</div>
    </div>
    <div className="stats-kpis">
      <div className="stats-kpi"><strong>{compact(totals.created)}</strong><span>新建需求</span></div>
      <div className="stats-kpi"><strong>{compact(totals.claims)}</strong><span>AI 执行次数</span></div>
      <div className="stats-kpi"><strong>{compact(totals.finished)}</strong><span>完成执行</span></div>
      <div className="stats-kpi"><strong title={formatMinutes(totals.minutes)}>{formatMinutes(totals.minutes)}</strong><span>AI 执行用时</span></div>
      <div className="stats-kpi"><strong>{compact(totals.executing)}</strong><span>当前执行中</span></div>
    </div>
    <div className="stats-chart-block">
      <div className="stats-chart-head">
        <h4>每日新建需求{currentName ? ` · ${currentName}` : ''}</h4>
        <div className="stats-project-tags">
          <button className={'tag-btn' + (projectId === '' ? ' on' : '')} aria-pressed={projectId === ''} onClick={() => setProjectId('')}>全部</button>
          {projects.map(p => <button key={p.id} className={'tag-btn' + (projectId === p.id ? ' on' : '')} aria-pressed={projectId === p.id} onClick={() => setProjectId(p.id)}>{p.name}</button>)}
        </div>
      </div>
      <ActivityCalendar events={projectId ? events.created.filter(event => event.project === projectId) : events.created} />
      <LineChart key={`created-${range}-${projectId}`} title="新建需求" points={series.created} width={740} />
    </div>
    <div className="stats-grid-2">
      <div className="stats-chart-block"><h4>每日 AI 执行次数</h4><LineChart key={`claims-${range}`} title="AI 执行次数" points={series.claims} width={354} height={150} /></div>
      <div className="stats-chart-block"><h4>每日 AI 执行用时</h4><LineChart key={`minutes-${range}`} title="AI 执行用时" unit=" 分" points={series.minutes} width={354} height={150} /></div>
    </div>
    <div className="stats-grid-2">
      <div className="stats-chart-block"><h4>各项目需求量</h4><BarList rows={projectRows} onSelect={id => { setMilestones({ loading: true, error: '', data: null }); setMilestoneId(id); }} /></div>
      <div className="stats-chart-block"><h4>AI 客户端使用</h4><BarList rows={clientRows} unit=" 次" /></div>
    </div>
    <div className="settings-actions">
      <button className="btn" aria-expanded={showTable} onClick={() => setShowTable(!showTable)}>{showTable ? '收起明细表' : '展开明细表'}</button>
    </div>
    {showTable && (() => {
      const rows = days.slice().reverse().map(day => ({ day, created: series.created.find(p => p.day === day)?.value || 0, claims: series.claims.find(p => p.day === day)?.value || 0, finished: series.finished.find(p => p.day === day)?.value || 0, minutes: series.minutes.find(p => p.day === day)?.value || 0 })).filter(r => r.created || r.claims || r.finished || r.minutes);
      if (rows.length === 0) return <p className="settings-hint">所选范围暂无数据。</p>;
      return <table className="stats-table">
        <thead><tr><th>日期</th><th>新建需求</th><th>AI 执行</th><th>完成执行</th><th>AI 执行用时</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.day}><td>{r.day}</td><td>{r.created}</td><td>{r.claims}</td><td>{r.finished}</td><td>{r.minutes ? formatMinutes(r.minutes) : '—'}</td></tr>)}</tbody>
      </table>;
    })()}
  </section>;
}
