// ReqFlow 主界面 —— 移植自线上 app/page.tsx 的完整工作台逻辑，
// 交互与状态流与线上一致；新增「帮助 / CLI 参考」入口。

import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_DELIVERY, buildPrompt, requirementSettings, unresolvedFailures, pendingCommitItems, compareArchivedItems, mutationProjectIds, projectConcurrencyToken,
  type Item, type Project, type Workspace
} from '../core/domain';
import { bridge } from './api';
import {
  Check, ChevronDown, Download, FileText, FolderOpen, HelpCircle, History,
  Layers, Plus, RefreshCw, Search, Trash, X, ImageIcon, Settings
} from './icons';
import { HelpOverlay } from './help';
import { ProjectBrowser } from './browser';
import { SettingsOverlay } from './settings';
import { AIRequirements } from './ai-requirements';
import { ProjectCreate } from './project-create';
import { ModsOverlay } from './mods';
import { localDate, matchesSchedule } from '../core/dates';

const labels: Record<string, string> = {
  feature: '新需求', improvement: '优化', bug: '修复',
  ready: '待执行', in_progress: '待开发', pending_verification: '待验证', archived: '已归档'
};
const phases: [string, string][] = [
  ['feature', '需求池'], ['generate', '排期表'],
  ['pending_verification', '待验证'], ['archived', '归档']
];
const emptyForm = { title: '', body: '', criteria: '', type: 'feature', priority: 'P1' };
// 上次使用的项目（REQ-029）：启动时恢复；项目切换即记录，关闭程序时最近一次选择已保存
const LAST_PROJECT_KEY = 'reqflow-last-project';

export default function App() {
  const [data, setData] = useState<Workspace | null>(null);
  const [version, setVersion] = useState(0);
  const [appVersion, setAppVersion] = useState('');
  const [pid, setPid] = useState('');
  const [tab, setTab] = useState('feature');
  const [archiveView, setArchiveView] = useState('items');
  const [scheduleMode, setScheduleMode] = useState('through');
  const [scheduleDate, setScheduleDate] = useState(localDate());
  const [selected, setSelected] = useState<string[]>([]);
  const [batchId, setBatchId] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('已保存');
  const [modal, setModal] = useState('');
  const [editing, setEditing] = useState<Item | null>(null);
  const [form, setForm] = useState<any>(emptyForm);
  const [guide, setGuide] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [note, setNote] = useState('');
  const [fixedIdx, setFixedIdx] = useState<number[]>([]); // 二次退回时确认「已修复」的旧问题下标
  const [delivery, setDelivery] = useState('');
  const [aiValidation, setAiValidation] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modsOpen, setModsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [targetProject, setTargetProject] = useState('');
  const [browserOpen, setBrowserOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [sort, setSort] = useState('desc');
  const [folderName, setFolderName] = useState('');
  const [folderForm, setFolderForm] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [backgroundEditing, setBackgroundEditing] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);

  const versionRef = useRef(0);
  const workspaceRef = useRef<Workspace | null>(null);
  const busyRef = useRef(false);
  const autoRef = useRef<any>(null);
  const formRef = useRef(form);
  const dirtyRef = useRef(false);
  formRef.current = form;

  const p = data?.projects.find((x) => x.id === pid) || data?.projects[0];

  function notify(text: string, kind: 'ok' | 'err' = 'ok') {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 1800);
  }

  function switchProject(id: string) {
    setBackgroundEditing(false);
    setPid(id); setSelected([]); setBatchId(''); setQuery(''); setTab('feature');
    setBrowserOpen(false);
  }

  // 浏览项目：未关联目录先弹出系统目录选择框，关联后打开文件浏览器
  async function browseProject() {
    if (!bridge.pickDir || !bridge.listDir) {
      notify('文件浏览仅桌面版支持（浏览器预览无本地文件访问）', 'err');
      return;
    }
    if (!p?.dir) {
      const r = await bridge.pickDir();
      if (!r.ok || !r.dir) return;
      if (!await act({ op: 'projectDir', dir: r.dir }, true)) return;
    }
    setBrowserOpen(true);
  }

  async function load() {
    try {
      const r = await bridge.getWorkspace();
      if (!r.ok) throw Error(r.error);
      setData(r.state); workspaceRef.current = r.state; setVersion(r.version); versionRef.current = r.version; setError('');
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
    bridge.appInfo().then((i) => setAppVersion(i.version)).catch(() => { /* 取不到版本号时仅不显示 */ });
  }, []);

  // REQ-029：首次数据加载后恢复上次使用的项目（项目已被删除时回退第一个）
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!data || restoredRef.current) return;
    restoredRef.current = true;
    try {
      const last = localStorage.getItem(LAST_PROJECT_KEY);
      if (last && data.projects.some((x) => x.id === last)) setPid(last);
    } catch { /* localStorage 不可用时保持默认项目 */ }
  }, [data]);
  useEffect(() => {
    if (!p) return;
    try { localStorage.setItem(LAST_PROJECT_KEY, p.id); } catch { /* 记录失败不影响使用 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.id]);

  // 数据刷新后同步弹窗持有的条目快照：弹窗标题/正文始终显示该需求最新信息，
  // 避免连续操作多条需求时显示退回前的旧条目
  useEffect(() => {
    if (!editing || !data) return;
    const fresh = p?.items.find((x) => x.id === editing.id);
    if (fresh && fresh !== editing) setEditing(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  async function act(a: any, quiet = false): Promise<(Workspace & { createdProjectId?: string }) | false> {
    if (busyRef.current) {
      if (!quiet) notify('正在保存，请稍后再试', 'err');
      return false;
    }
    busyRef.current = true; setBusy(true); setSaved('保存中…');
    try {
      // 默认作用于当前项目；操作显式携带 project 时（如删除其他项目）以传入值为准
      const action = { project: p?.id, ...a };
      const scopes = mutationProjectIds(action);
      const expectedProjectVersions = scopes ? Object.fromEntries(scopes.map(id => [id, workspaceRef.current?.projects.find(pr => pr.id === id)?.revision ?? 0])) : undefined;
      const expectedProjectSignatures = scopes ? Object.fromEntries(await Promise.all(scopes.map(async id => {
        const project = workspaceRef.current?.projects.find(pr => pr.id === id);
        if (!project) throw Error('项目已不存在，请刷新后重试');
        return [id, await projectConcurrencyToken(project)];
      }))) : undefined;
      const r = await bridge.apply({ ...action, expectedVersion: versionRef.current, expectedProjectVersions, expectedProjectSignatures });
      if (!r.ok) throw Error(r.error);
      if (r.version >= versionRef.current) { setData(r.state); workspaceRef.current = r.state; setVersion(r.version); versionRef.current = r.version; }
      setSaved('已保存'); setError(r.warning || '');
      if (r.warning) notify(r.warning, 'err');
      else if (!quiet) notify(r.summary || '已保存');
      return { ...r.state, createdProjectId: r.createdProjectId };
    } catch (e: any) {
      setError(e.message); setSaved('保存失败');
      notify(e.message, 'err');
      return false;
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }

  function edit(i?: Item) {
    dirtyRef.current = false;
    clearTimeout(autoRef.current);
    setEditing(i || null);
    setForm(i
      ? { ...i, ...requirementSettings(p!, i), criteria: i.criteria.join('\n') }
      : {
          ...emptyForm, scheduledDate: localDate(), aiValidation: p!.aiValidation,
          deliveryGuidance: !p!.aiValidation && p!.deliveryGuidance === DEFAULT_DELIVERY
            ? '说明改动、未解决的问题。' : p!.deliveryGuidance
        });
    setAdvanced(false); setNewMenu(false);
    setModal('item');
  }

  async function uploadImages(files: FileList | File[] | null) {
    if (!files?.length || uploading) return;
    setUploading(true);
    try {
      const additions = [];
      const current = formRef.current.attachments || [];
      if (current.length + files.length > 12) throw Error('最多上传 12 张图片');
      let next = Math.max(0, ...current.map((a: any) => Number(a.label.replace('图片', '')))) + 1;
      for (const file of Array.from(files)) {
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 10 * 1024 * 1024)
          throw Error('支持 PNG/JPG/WebP/GIF，每张最多 10MB');
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(Error('读取图片失败')); reader.readAsDataURL(file);
        });
        additions.push({ id: crypto.randomUUID(), label: '图片' + next++, name: file.name, dataUrl });
      }
      change({ ...formRef.current, attachments: [...current, ...additions] });
    } catch (e: any) { notify(e.message, 'err'); }
    finally { setUploading(false); }
  }

  function change(f: any) {
    dirtyRef.current = true;
    formRef.current = f;
    setForm(f);
    if (editing) {
      setSaved('等待保存…');
      clearTimeout(autoRef.current);
      autoRef.current = setTimeout(async () => {
        if (f.deliveryGuidance?.trim() && await act({ op: 'item', ...f, id: editing.id }, true)) {
          if (formRef.current === f) dirtyRef.current = false;
        }
      }, 800);
    }
  }

  // 执行中的需求也可参与生成：前一轮未完成时可与新需求累积生成，或单独生成
  const eligible = (i: Item) => !i.archived && (i.status === 'ready' || i.status === 'in_progress');
  const picked = selected.map((id) => p?.items.find((i) => i.id === id)).filter((i): i is Item => !!i && eligible(i));
  // 「提交验证」页顶部按钮：把待执行与执行中的全部需求合成一条 Prompt
  const allInProgress = (p?.items || []).filter((i) => !i.archived && i.status === 'in_progress');
  const inProgress = allInProgress.filter(i => matchesSchedule(i.scheduledDate, scheduleMode, scheduleDate));
  const viewingHistory = tab === 'archived' && archiveView === 'batches';
  const visible = (p?.items || []).filter((i) =>
    (tab === 'archived' ? !!i.archived
      : !i.archived && (tab === 'feature' ? i.status === 'ready' : tab === 'generate' ? i.status === 'in_progress' : i.status === tab))
    && (tab !== 'generate' || matchesSchedule(i.scheduledDate, scheduleMode, scheduleDate))
    && [i.title, i.number, i.body].join(' ').toLowerCase().includes(query.toLowerCase()));
  const helpText =
    viewingHistory ? '历史排期快照保留在这里，点击批次可到排期表查看。' : tab === 'feature' ? '勾选本轮需求，点击排期转入待开发'
      : tab === 'pending_verification' ? '你验证完成后，点击「通过并归档」即可；未通过可退回待执行。'
      : tab === 'archived' ? '已归档的需求与验证记录保存在这里，发现问题可重新打开。'
      : '';
  const batch = p?.batches.find((b) => b.id === batchId) || p?.batches.find((b) => b.mode === 'develop');
  const stale = !!batch && !!p && (
    batch.guideVersion !== p.guideVersion ||
    batch.items.some((old) => p.items.find((i) => i.id === old.id)?.version !== old.version));

  async function generate(ids = picked.map((i) => i.id)) {
    const r = await act({ op: 'generate', ids });
    if (!r) return;
    const pr = r.projects.find((x) => x.id === p?.id)!;
    const b = pr.batches[0];
    // 界面没有「确认提交」步骤：生成即提交，需求直接进入执行中（CLI 仍可 generate/submit 分步）
    if (!await act({ op: 'submit', batch: b.id }, true)) return;
    setBatchId(b.id);
    setSelected(ids);
    setTab('generate');
    notify(`已排期 ${ids.length} 条需求，进入待开发`);
  }

  // 单条提交：AI 完成这一条后，单独把它送入待验证，不影响同批其他需求
  async function submitItem(i: Item) {
    if (await act({ op: 'complete', id: i.id }, true)) {
      notify('已提交 AI，需求进入待验证');
    }
  }

  async function completeBatch() {
    // 顶部「提交验证」一次提交全部执行中的需求（不限当前批次：多轮生成的需求一并进入待验证）
    for (const i of inProgress) {
      if (!await act({ op: 'complete', id: i.id }, true)) return;
    }
    setTab('pending_verification'); setSelected([]);
    notify(`已提交 ${inProgress.length} 条需求进入待验证，验证后点击「通过并归档」`);
  }
  async function recordPass(i: Item) {
    if (await act({ op: 'verify', id: i.id, pass: true })) {
      setSelected([]);
      notify('验证通过，已直接归档');
    }
  }
  async function revertItem(i: Item) {
    if (await act({ op: 'revert', id: i.id })) {
      setTab('feature');
      notify('已退回待执行，可编辑后重新生成 Prompt');
    }
  }
  function changeTab(v: string) {
    setTab(v);
    if (v === 'generate') { setScheduleMode('through'); setScheduleDate(localDate()); }
    if (v === 'archived') setArchiveView('items');
    if (v !== 'feature' && v !== 'generate') setSelected([]);
  }

  async function copyPrompt(items: Item[]) {
    if (!p || !items.length) return;
    try { await navigator.clipboard.writeText(buildPrompt(p, items)); notify('Prompt 已复制'); }
    catch { notify('复制失败，请检查剪贴板权限', 'err'); }
  }

  async function closeModal() {
    if (busyRef.current) return;
    clearTimeout(autoRef.current);
    if (modal === 'item' && editing && dirtyRef.current) {
      if (!await act({ op: 'item', ...formRef.current, id: editing.id }, true)) return;
      dirtyRef.current = false;
    }
    setModal('');
  }

  function download(text: string, file: string) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = file; a.click();
    URL.revokeObjectURL(url);
  }

  if (!data) {
    return (
      <div className="boot">
        <img className="mark" src="./app-icon.png" alt="ReqFlow" />
        <h1>ReqFlow · 需求流</h1>
        <p>{error || '正在打开你的工作区…'}</p>
        {error && <button className="btn primary" onClick={load}>重试</button>}
      </div>
    );
  }

  return (
    <div className="app">
      {toast && <div className={'toast ' + toast.kind}>{toast.text}</div>}

      <aside className="side">
        <div className="brand"><img className="mark" src="./app-icon.png" alt="ReqFlow" /><div>ReqFlow<small>需求流{appVersion ? ` v${appVersion}` : ''}</small></div></div>
        <div className="side-label">我的项目</div>
        <nav className="side-projects">
          {(data.folders || [{id: 'default', name: 'default'}]).map((folder) => <details open className="project-folder" key={folder.id} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('application/reqflow-project'); if (id) void act({op: 'projectFolder', project: id, folderId: folder.id}); }}><summary><FolderOpen size={14} />{folder.name}</summary>{data.projects.filter((pr) => (pr.folderId || 'default') === folder.id).map((pr) => (
            <div key={pr.id} role="button" tabIndex={0}
              draggable={!busy} onDragStart={(e) => e.dataTransfer.setData('application/reqflow-project', pr.id)}
              className={'side-project' + (p?.id === pr.id ? ' active' : '')}
              onClick={() => switchProject(pr.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchProject(pr.id); } }}
              title={pr.name}>
              <Layers size={16} />
              <span className="project-name">{pr.name}</span>
              <span className="small-count">{pr.items.filter((i) => !i.archived).length}</span>
              {data.projects.length > 1 && (
                <button className="side-project-del" aria-label={'删除项目 ' + pr.name} title="删除项目"
                  onClick={(e) => { e.stopPropagation(); setDeleting(pr); setModal('deleteProject'); }}>
                  <Trash size={13} />
                </button>
              )}
            </div>
          ))}</details>)}
          <button className="side-project add" disabled={busy} onClick={() => setFolderForm(!folderForm)}><Plus size={16} />新建文件夹</button>
          {folderForm && <form className="folder-form" onSubmit={async (e) => { e.preventDefault(); if (await act({ op: "folder", name: folderName })) { setFolderName(""); setFolderForm(false); } }}><label className="field"><input aria-label="文件夹名称" value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="文件夹名称" /></label><button className="btn sm" disabled={busy || !folderName.trim()}>创建</button></form>}
          <button className="side-project add" onClick={() => { setName(''); setDescription(''); setModal('project'); }}>
            <Plus size={16} /><span>新建项目</span>
          </button>
        </nav>
        <div className="side-label">协作项目</div>
        <div className="flow-note">开发中<br /><small>后续支持项目同步与协作</small></div>
        <div className="side-foot">
          <button className="btn plain" onClick={() => setModsOpen(true)}><Layers />插件/MOD</button>
          <button className="btn plain" onClick={() => setSettingsOpen(true)}><Settings />设置</button>
          <button className="btn plain" onClick={() => download(JSON.stringify(data, null, 2), 'reqflow-backup.json')}>
            <Download size={15} />导出全部数据
          </button>
          <button className="btn plain" onClick={() => setHelpOpen(true)}>
            <HelpCircle size={15} />帮助 · CLI 参考
          </button>
          <p className="side-hint">本地工作区 · 数据保存在本机</p>
        </div>
      </aside>

      <main className="main">
        <header className="top">
          <div className="switcher" onClick={() => setSwitcherOpen(!switcherOpen)} onBlur={() => setTimeout(() => setSwitcherOpen(false), 150)}>
            <span className="switcher-icon"><Layers size={18} /></span>
            <span className="switcher-text"><small>切换项目</small><strong>{p?.name}</strong></span>
            <ChevronDown size={16} className={'chev' + (switcherOpen ? ' up' : '')} />
            {switcherOpen && (
              <div className="switcher-menu">
                <div className="switcher-label">我的项目 <span>{data.projects.length}</span></div>
                {data.projects.map((pr) => (
                  <button key={pr.id} className={'switcher-row' + (pr.id === p?.id ? ' current' : '')}
                    onClick={() => { switchProject(pr.id); setSwitcherOpen(false); }}>
                    <strong>{pr.name}</strong>
                    <small>{pr.items.filter((i) => !i.archived).length} 条进行中的需求</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="save">
            <Check size={14} />{saved}
            <button className="icon-btn" aria-label="刷新数据" onClick={load}><RefreshCw size={15} /></button>
          </div>
        </header>

        {error && (
          <div className="error">
            {error} <button className="btn plain" onClick={load}>刷新数据</button>
            <p>当前编辑内容会保留在编辑框中，请确认最新内容后再保存。</p>
          </div>
        )}

        <section className="title-row">
          <div>
            <div className="eyebrow">PROJECT WORKSPACE</div>
            <h1>{p?.name}</h1>
            {backgroundEditing ? <form className="background-editor" onSubmit={async (e) => { e.preventDefault(); if (await act({ op: 'projectDescription', description })) setBackgroundEditing(false); }}>
              <textarea autoFocus aria-label="项目背景" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setBackgroundEditing(false); }} />
              <div className="settings-actions"><button className="btn sm primary" disabled={busy}>保存背景</button><button type="button" className="btn sm" onClick={() => setBackgroundEditing(false)}>取消</button></div>
            </form> : <button className="project-background" title="点击编辑项目背景" onClick={() => { setDescription(p?.description || ''); setBackgroundEditing(true); }}>{p?.description || '点击添加项目背景、技术栈与运行方式'}</button>}
            {p?.dir && (
              <p className="linked-dir" title={p.dir}>
                <FolderOpen size={13} />{p.dir}
              </p>
            )}
          </div>
          <div className="title-actions">
            <button className="btn" onClick={browseProject} title={p?.dir ? '浏览项目文件：' + p.dir : '关联本地项目目录并浏览文件'}>
              <FolderOpen size={16} />{p?.dir ? '浏览项目' : '关联目录'}
            </button>
            <div className="new-requirement-split"><button className="btn primary" onClick={() => edit()}><Plus size={17} />记录新需求</button><button className="btn primary" aria-label="选择记录需求方式" aria-expanded={newMenu} onClick={() => setNewMenu(!newMenu)}><ChevronDown size={17} /></button>{newMenu && <div className="new-requirement-menu"><button type="button" onClick={() => { setNewMenu(false); setAiOpen(true); }}>AI 需求</button></div>}</div>
          </div>
        </section>

        <section className="guidance">
          <div className="guide-symbol"><FileText size={20} /></div>
          <div className="guide-main">
            <h2>项目引导词 <span>v{p?.guideVersion}</span></h2>
            <p>{p?.guidance}</p>
            <div className="guide-settings-summary">
              <span>AI 验证：{p?.aiValidation ? '开启' : '关闭'}</span>
              <span>新需求的默认设置</span>
            </div>
          </div>
          <button className="btn plain" onClick={() => {
            setGuide(p!.guidance); setDelivery(p!.deliveryGuidance); setAiValidation(p!.aiValidation); setModal('guide');
          }}>编辑设置</button>
        </section>

        <div className="workspace-grid single">
          <section className="requirements">
            <div className="navtabs">
              {phases.map(([v, l]) => (
                <button key={v} className={'navtab' + (tab === v ? ' active' : '')} onClick={() => changeTab(v)}>
                  {l}
                  <span>{v === 'generate' ? allInProgress.length
                    : p!.items.filter((i) =>
                      v === 'archived' ? !!i.archived : !i.archived && (v === 'feature' ? i.status === 'ready' : i.status === v)).length}</span>
                </button>
              ))}
            </div>
            {helpText && (
              <div className="workflow-help">
                <p>{helpText}</p>
                {tab === 'feature' && picked.length > 0 && (
                  <button className="btn primary" disabled={busy} onClick={() => generate()}>
                    排期 · 已选 {picked.length} 条
                  </button>
                )}
              </div>
            )}

            {tab === 'archived' && <div className="archive-navigation segmented" role="group" aria-label="归档次级入口"><button className={archiveView === 'items' ? 'on' : ''} aria-pressed={archiveView === 'items'} onClick={() => setArchiveView('items')}>归档需求</button><button className={archiveView === 'batches' ? 'on' : ''} aria-pressed={archiveView === 'batches'} onClick={() => setArchiveView('batches')}>批次历史 · {p!.batches.length}</button></div>}
            {tab === 'generate' && <div className="schedule-filter"><label className="field">筛选日期<input type="date" aria-label="排期筛选日期" value={scheduleDate} onChange={e => { if (e.target.value) setScheduleDate(e.target.value); }} disabled={scheduleMode === 'all'} /></label><div className="segmented" role="group" aria-label="排期日期范围">{[['through', '日期及之前'], ['exact', '指定日期'], ['all', '所有需求']].map(([mode, label]) => <button key={mode} aria-pressed={scheduleMode === mode} className={scheduleMode === mode ? 'on' : ''} onClick={() => setScheduleMode(mode)}>{label}</button>)}</div><span className="settings-hint">当前 {inProgress.length} / 全部 {allInProgress.length} 条；未设日期的旧需求归入「日期及之前」。顶部操作仅处理当前日期范围。</span></div>}
            {tab === 'generate' && (
              <div className="gen-panel">
                <div className="gen-head">
                  <h3>本轮排期</h3>
                  <span>{batch
                    ? `批次 ${String(batch.number).padStart(2, '0')} · ${batch.items.length} 条需求`
                    : '暂无批次'}</span>
                </div>
                <div className="gen-actions"><button className="btn" disabled={inProgress.length === 0} onClick={() => copyPrompt(inProgress)}>复制全部 Prompt</button>
                  <button className="btn primary" disabled={busy || inProgress.length === 0} onClick={completeBatch}>
                    <Check size={15} />提交验证 · 全部{inProgress.length > 0 ? ` ${inProgress.length} 条` : ''}
                  </button>
                </div>
                {stale && <p className="warning gen-warning">源内容已变化，请退回待执行后重新排期。</p>}
                <p className="gen-hint">{batch
                  ? '排期后由 ReqFlow Agent 读取需求执行；完成开发后提交验证。'
                  : '到「待执行」勾选需求并排期。'}</p>
              </div>
            )}
            {tab === 'generate' && inProgress.length > 0 && (
              <h3 className="gen-sub">待开发 <span>{inProgress.length} 条等待 AI 完成</span></h3>
            )}
            {!viewingHistory && (
              <div className="list-tools">
                {(tab === 'feature') && (
                  <label className="check-label">
                    <input type="checkbox"
                      checked={visible.filter(eligible).length > 0 && visible.filter(eligible).every((i) => selected.includes(i.id))}
                      onChange={(e) => setSelected(e.target.checked
                        ? [...new Set([...selected, ...visible.filter(eligible).map((i) => i.id)])]
                        : selected.filter((id) => !visible.some((i) => i.id === id)))} />
                    选择本轮需求
                  </label>
                )}
                <div className="search"><Search size={15} />
                  <input aria-label="搜索需求" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索需求" />
                </div>
              </div>
            )}
            <div className="list-scroll">
              {viewingHistory ? (
              <div className="batch-list">
                {p!.batches.length === 0 ? (
                  <div className="empty"><History size={28} /><h3>还没有批次</h3><p>选择待执行需求，创建第一轮排期。</p></div>
                ) : p!.batches.map((b) => (
                  <article key={b.id} className={'batch-card' + (batch?.id === b.id ? ' chosen' : '')}>
                    <button className="batch-open" onClick={() => { setBatchId(b.id); setScheduleMode('all'); setTab('generate'); }}>
                      <strong>批次 {String(b.number).padStart(2, '0')}</strong>
                      <span>开发任务 · {b.items.length} 条需求</span>
                      <small>{new Date(b.time).toLocaleString('zh-CN')}</small>
                    </button>
                    <span className={'batch-badge ' + b.status}>
                      {({ draft: '未提交', submitted: '已提交', cancelled: '已取消' } as any)[b.status]}
                    </span>
                    {b.status === 'submitted' && (
                      <button className="btn plain" disabled={busy} onClick={() => act({ op: 'cancel', batch: b.id })}>取消执行</button>
                    )}
                    <div className="batch-ids">{b.items.map((i) => (i.number + ' ' + i.title).trim()).join(' · ')}</div>
                  </article>
                ))}
              </div>
            ) : (
              <>
                {!visible.length && (
                  <div className="empty"><Layers size={28} /><h3>{query ? '没有匹配的需求' : tab === 'generate' ? '还没有待开发的需求' : '这里还没有需求'}</h3>
                    <p>{tab === 'feature' ? '记录想法，按需求说明加入下一轮任务。'
                      : tab === 'generate' ? '排期后需求进入这里跟踪；开发完成后提交验证。'
                      : '需求进入此阶段后，会在这里显示。'}</p></div>
                )}

                {tab === 'feature' && <div className="requirement-sort segmented" role="group" aria-label="需求排序">{[['desc', '最新在前'], ['asc', '最早在前'], ['priority', '优先级']].map(([id, label]) => <button key={id} aria-pressed={sort === id} className={sort === id ? 'on' : ''} onClick={() => setSort(id)}>{label}</button>)}</div>}
                {[...visible].sort(tab === 'archived' ? compareArchivedItems : tab === 'feature' && sort !== 'priority' ? (a, b) => (sort === 'desc' ? -1 : 1) * (Number(a.number.replace('REQ-', '')) - Number(b.number.replace('REQ-', ''))) : (a, b) => a.priority.localeCompare(b.priority)).map((i) => (
                  <article key={i.id} className={'req-card' + (selected.includes(i.id) ? ' chosen' : '')}>
                    {tab === 'feature' && eligible(i) && (
                      <div className="card-selection">
                        <input type="checkbox" checked={selected.includes(i.id)} aria-label={'选择 ' + (i.title || i.number)}
                          onChange={(e) => setSelected(e.target.checked ? [...selected, i.id] : selected.filter((id) => id !== i.id))} />
                      </div>
                    )}
                    <div className="card-body">
                      <div className="meta">
                        <code>{i.number}</code>
                        <span className={'badge ' + i.type}>{labels[i.type]}</span>
                        <span className="priority">{i.priority}</span>
                        <span className={'status ' + i.status}>{labels[i.status]}</span>
                        <span className="revision">v{i.version}</span>{i.scheduledDate && <span className="revision">计划 {i.scheduledDate}</span>}{pendingCommitItems(p!).some((x) => x.id === i.id) && <span className="badge improvement">待 Git 提交</span>}
                      </div>
                      {i.title && <button className="item-title" onClick={() => { setEditing(i); setModal('detail'); }}>{i.title}</button>}
                      <p className="body-copy">{i.body || '暂无详细说明'}</p>{!!i.attachments?.length && <button className="btn sm" onClick={() => { setEditing(i); setModal('detail'); }}>参考图片 · {i.attachments.map((a) => a.label).join('、')}</button>}
                      {unresolvedFailures(i).length > 0 && (
                        <div className="failure-content">
                          <strong>未通过的问题</strong>
                          {unresolvedFailures(i).map((f, n) => (
                            <p key={n}>
                              {unresolvedFailures(i).length > 1 ? (f.current ? '【新问题】' : '【仍未修复】') : ''}{f.note}
                            </p>
                          ))}
                          <p>重新生成 Prompt 时会自动带上以上内容。</p>
                        </div>
                      )}
                      <div className="criteria">
                        {i.criteria.length ? i.criteria.map((c, n) => <p key={n}><Check size={13} />{c}</p>)
                          : <p>按需求说明确认结果即可。</p>}
                      </div>
                      <div className="requirement-settings-summary">
                        AI 测试验证：{requirementSettings(p!, i).aiValidation ? '需要' : '不需要'}
                      </div>
                      <div className="next-step">
                        {i.status === 'ready' ? '点击排期转入待开发，或勾选后批量排期。'
                          : i.status === 'in_progress' ? '开发完成后提交验证；需修改时退回待执行重新编辑。'
                          : i.status === 'pending_verification' ? '验证完成后，直接记录通过或未通过。'
                          : '已归档，历史记录仍可查看。'}
                      </div>
                      <div className="card-actions">
                        {i.status === 'in_progress' && <button className="btn" onClick={() => copyPrompt([i])}>复制 Prompt</button>}
                        {i.status === 'ready' && <button className="btn accent" disabled={busy} onClick={() => generate([i.id])}>排期</button>}
                        {i.status === 'ready' && <button className="btn" disabled={busy} onClick={() => edit(i)}>编辑</button>}
                        {i.status === 'ready' && <button className="btn" disabled={busy} onClick={() => {
                          setEditing(i); setTargetProject(data.projects.find((pr) => pr.id !== p?.id)?.id || ''); setModal('moveItem');
                        }}>迁移到其他项目</button>}
                        {i.status === 'ready' && <button className="btn" disabled={busy} onClick={() => {
                          setEditing(i); setModal('deleteItem');
                        }}><Trash size={14} />删除</button>}
                        {i.status === 'in_progress' && <button className="btn primary" disabled={busy} onClick={() => submitItem(i)}>提交验证</button>}
                        {i.status === 'in_progress' && <button className="btn" disabled={busy} onClick={() => revertItem(i)}>退回待执行</button>}
                        {i.status === 'pending_verification' && (
                          <>
                            <button className="btn accent" disabled={busy} onClick={() => recordPass(i)}>通过并归档</button>
                            <button className="btn" disabled={busy} onClick={() => { setEditing(i); setNote(''); setFixedIdx([]); setModal('verify'); }}>未通过，退回</button>
                          </>
                        )}
                        {i.status === 'archived' && <button className="btn" disabled={busy} onClick={() => { setEditing(i); setNote(''); setModal('regress'); }}>重新打开</button>}
                        <button className="btn" onClick={() => { setEditing(i); setModal('detail'); }}>查看历史</button>
                      </div>
                    </div>
                  </article>
                ))}
                <footer className="list-foot">
                  <span>{visible.length} 条需求</span>
                  <span>{tab === 'archived' ? '归档时间倒序' : '优先级排序'}{tab === 'feature' ? ` · 已选择 ${picked.length} 条` : ''}</span>
                </footer>
              </>
              )}
            </div>
          </section>


        </div>

        <footer className="page-foot">
          ReqFlow · 需求流 <span>让需求、执行与验收保持连贯。</span>
        </footer>
      </main>

      {aiOpen && p && <AIRequirements key={p.id} project={p} onClose={() => setAiOpen(false)} insert={async (items) => { const r = await act({op: 'aiItems', items: items.map((i) => ({...i, criteria: i.criteria.join('\n')}))}); if (r) { setTab('feature'); notify('AI 需求已加入待执行'); } return !!r; }} />}
      {modsOpen && <ModsOverlay onClose={() => setModsOpen(false)} />}
      {settingsOpen && <SettingsOverlay onClose={() => setSettingsOpen(false)} notify={notify} />}
      {modal && (
        <div className="overlay" role="dialog" onClick={(e) => { if (e.target === e.currentTarget) void closeModal(); }}>
          <div className={'dialog' + (modal === 'item' ? ' requirement-dialog' : '')}>
            <div className="dialog-head">
              <div>
                <h3>{({ item: editing ? '编辑需求' : '记录新需求', project: '创建项目', guide: '项目与交付设置', detail: editing ? (editing.title ? editing.number + ' · ' + editing.title : editing.number) : '', verify: editing ? '未通过退回 · ' + (editing.title ? editing.number + ' · ' + editing.title : editing.number) : '记录未通过的问题', regress: editing ? '重新打开 · ' + (editing.title ? editing.number + ' · ' + editing.title : editing.number) : '重新打开归档需求', deleteProject: '删除项目', moveItem: '迁移需求', deleteItem: '删除需求' } as any)[modal]}</h3>
                <p>{modal === 'item' ? '标题与验收条件选填；已有需求编辑后自动保存。'
                  : modal === 'verify' ? '未通过的内容会显示在需求卡片中，并带入下一轮 Prompt。'
                  : modal === 'deleteProject' ? '删除会一并移除该项目全部需求、批次与历史，且不可恢复。'
                  : modal === 'moveItem' ? '保留需求内容、设置与历史，在目标项目中分配新编号。'
                  : modal === 'deleteItem' ? '删除后无法恢复该需求；已有批次中的历史快照仍会保留。'
                  : '修改与操作记录会保留在工作区。'}</p>
              </div>
              <button className="icon-btn" disabled={busy} aria-label="关闭" onClick={() => void closeModal()}><X size={18} /></button>
            </div>

            {(modal === 'moveItem' || modal === 'deleteItem') && editing && (
              <form onSubmit={async (e) => {
                e.preventDefault();
                const moving = modal === 'moveItem';
                const r = await act({ op: moving ? 'moveItem' : 'deleteItem', id: editing.id, targetProject }, true);
                if (r) {
                  setSelected((ids) => ids.filter((id) => id !== editing.id));
                  setModal(''); setEditing(null);
                  notify(moving ? '需求已迁移到目标项目' : '需求已删除');
                }
              }}>
                <p>{editing.number}{editing.title ? ' · ' + editing.title : ''}</p>
                {modal === 'moveItem' && (
                  data.projects.length > 1 ? <label className="field">目标项目
                    <select required value={targetProject} onChange={(e) => setTargetProject(e.target.value)}>
                      {data.projects.filter((pr) => pr.id !== p?.id).map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
                    </select>
                  </label> : <p>还没有其他项目，请先在侧边栏新建项目。</p>
                )}
                <div className="card-actions">
                  <button type="button" className="btn" disabled={busy} onClick={() => setModal('')}>取消</button>
                  <button className={'btn ' + (modal === 'deleteItem' ? 'danger' : 'primary')} disabled={busy || (modal === 'moveItem' && !targetProject)}>
                    {modal === 'moveItem' ? '确认迁移' : '确认删除'}
                  </button>
                </div>
              </form>
            )}

            {modal === 'project' && (
              <ProjectCreate disabled={busy} folders={data.folders || [{ id: 'default', name: 'default' }]} submit={async (input) => {
                const r = await act({ op: 'project', ...input });
                if (!r) return false;
                setPid(r.createdProjectId || r.projects[r.projects.length - 1].id); setSelected([]); setBatchId(''); setModal('');
                return true;
              }} />
            )}

            {modal === 'item' && (
              <form onSubmit={async (e) => {
                e.preventDefault();
                clearTimeout(autoRef.current);
                const r = await act({ op: 'item', ...form, id: editing?.id });
                if (r) {
                  setModal(''); setTab('feature');
                  const pr = r.projects.find((x) => x.id === p?.id)!;
                  const item = editing ? pr.items.find((i) => i.id === editing.id) : pr.items[pr.items.length - 1];
                  if (item) setSelected((ids) => [...new Set([...ids, item.id])]);
                  notify('需求已待执行，可直接排期');
                }
              }}>
                <div className="choice-row">
                  <div className="field inline"><span>类型</span>
                    <div className="segmented" role="group" aria-label="需求类型">
                      {[['feature', '新需求'], ['improvement', '优化'], ['bug', '修复']].map(([v, l]) => (
                        <button type="button" key={v} aria-pressed={form.type === v} className={form.type === v ? 'on' : ''} onClick={() => change({ ...form, type: v })}>{l}</button>
                      ))}
                    </div>
                  </div>
                  <div className="field inline"><span>优先级</span>
                    <div className="segmented" role="group" aria-label="优先级">
                      {[['P0', 'P0 紧急'], ['P1', 'P1 重要'], ['P2', 'P2 常规']].map(([v, l]) => (
                        <button type="button" key={v} aria-pressed={form.priority === v} className={form.priority === v ? 'on' : ''} onClick={() => change({ ...form, priority: v })}>{l}</button>
                      ))}
                    </div>
                  </div>
                  <label className="field requirement-date"><span>日期</span><input type="date" aria-label="需求计划日期" value={form.scheduledDate || ''} onChange={e => change({ ...form, scheduledDate: e.target.value })} /></label>
                </div>
                <label className="field">需求说明 · Ctrl+V 可粘贴截图
                  <textarea rows={4} value={form.body} onChange={(e) => change({ ...form, body: e.target.value })}
                    onPaste={(e) => {
                      const images = Array.from(e.clipboardData.items).filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => !!file);
                      if (!images.length) return;
                      e.preventDefault(); setAdvanced(true); void uploadImages(images);
                    }}
                    placeholder={form.type === 'bug' ? '复现步骤、实际表现与预期行为' : '描述要实现的行为、约束或目标指标'} />
                </label>
                <button type="button" className="btn secondary advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><ChevronDown size={16} />{advanced ? '收起更多设置' : '展开更多设置 · 图片、标题、验收与交付'}</button>
                {advanced && <div className="requirement-advanced">
                <div className="image-settings"><input className="visually-hidden" ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple disabled={uploading} onChange={(e) => { uploadImages(e.target.files); e.target.value = ''; }} /><button type="button" className="btn sm" disabled={uploading} onClick={() => imageInput.current?.click()}><ImageIcon />{uploading ? '读取中…' : '选择参考图片'}</button>
                <p>最多 12 张，每张 10MB；正文可引用“图片1”等标识。</p>
                <div className="attachment-grid">{(form.attachments || []).map((a: any) => <figure key={a.id}><img src={a.dataUrl} alt={a.label + ' ' + a.name} /><figcaption>{a.label} · {a.name}</figcaption><button type="button" className="btn sm" onClick={() => change({ ...form, attachments: form.attachments.filter((x: any) => x.id !== a.id) })}>移除 {a.label}</button></figure>)}</div>
                </div>
                <label className="field">标题（选填）<input value={form.title} onChange={(e) => change({ ...form, title: e.target.value })} /></label>
                <label className="field">验收条件（选填）· 每行一项
                  <textarea rows={3} value={form.criteria} onChange={(e) => change({ ...form, criteria: e.target.value })} />
                </label>
                <div className="validation-setting">
                  <div>
                    <label htmlFor="item-ai-validation">需要 AI 测试验证</label>
                    <p>只对本条需求生效。关闭后，Prompt 不添加 AI 测试要求。</p>
                  </div>
                  <label className="switch">
                    <input id="item-ai-validation" type="checkbox" checked={!!form.aiValidation}
                      onChange={(e) => {
                        const v = e.target.checked;
                        change({
                          ...form, aiValidation: v,
                          deliveryGuidance:
                            !v && form.deliveryGuidance === DEFAULT_DELIVERY ? '说明改动、未解决的问题。'
                              : v && form.deliveryGuidance === '说明改动、未解决的问题。' ? DEFAULT_DELIVERY
                              : form.deliveryGuidance
                        });
                      }} />
                    <span className="slider" /><span className="switch-state">{form.aiValidation ? '已开启' : '已关闭'}</span>
                  </label>
                </div>
                <label className="field">交付引导
                  <textarea required rows={2} value={form.deliveryGuidance || ''} onChange={(e) => change({ ...form, deliveryGuidance: e.target.value })}
                    placeholder="填写这条需求完成后希望 AI 交付的内容" />
                </label>
                </div>}
                <div className="editor-footer">
                  <span>{saved}</span>
                  <button className="btn primary" disabled={busy || uploading}>保存需求</button>
                </div>
              </form>
            )}

            {modal === 'guide' && (
              <>
                <label className="field">项目引导词<textarea className="guide-edit" rows={4} value={guide} onChange={(e) => setGuide(e.target.value)} /></label>
                <div className="validation-setting">
                  <div>
                    <label htmlFor="ai-validation">新需求默认需要 AI 验证</label>
                    <p>新需求会使用这里的默认值；每条需求仍可在编辑页单独修改。</p>
                  </div>
                  <label className="switch">
                    <input id="ai-validation" type="checkbox" checked={aiValidation} onChange={(e) => setAiValidation(e.target.checked)} />
                    <span className="slider" /><span className="switch-state">{aiValidation ? '已开启' : '已关闭'}</span>
                  </label>
                </div>
                <label className="field">默认交付引导<textarea rows={3} value={delivery} onChange={(e) => setDelivery(e.target.value)} placeholder="填写希望 AI 交付时提供的内容" /></label>
                <button className="btn primary" disabled={busy || !guide.trim() || !delivery.trim()}
                  onClick={async () => { if (await act({ op: 'guidance', text: guide, deliveryGuidance: delivery, aiValidation })) setModal(''); }}>
                  保存设置
                </button>
                <h4 className="modal-section">版本历史</h4>
                {p!.guideHistory.map((g: any) => (
                  <details key={g.version} className="guide-version">
                    <summary>v{g.version} · {new Date(g.time).toLocaleString('zh-CN')}</summary>
                    <pre>{g.text + (g.deliveryGuidance ? '\n\n交付引导：\n' + g.deliveryGuidance : '')}</pre>
                    <button className="btn" onClick={() => {
                      setGuide(g.text);
                      if (g.deliveryGuidance !== undefined) setDelivery(g.deliveryGuidance);
                      if (g.aiValidation !== undefined) setAiValidation(g.aiValidation);
                    }}>载入此版本</button>
                  </details>
                ))}
              </>
            )}

            {modal === 'detail' && editing && (
              <>
                <p className="detail-body">{editing.body}</p><div className="attachment-grid">{editing.attachments?.map((a) => <figure key={a.id}><img src={a.dataUrl} alt={a.label} /><figcaption>{a.label} · {a.name}</figcaption></figure>)}</div>
                <p className="detail-meta">状态：{labels[editing.status]} · 版本 v{editing.version}</p>
                {editing.link && <p className="detail-meta">实现关联：<a href={editing.link} target="_blank" rel="noreferrer">{editing.link}</a></p>}
                <h4 className="modal-section">操作与验证历史</h4>
                <div className="history-list">
                  {editing.history.map((h: any, n: number) => (
                    <div className="history-entry" key={n}>
                      <strong>{h.event}</strong>
                      <small>{new Date(h.time).toLocaleString('zh-CN')}</small>
                      <p>{[h.note, h.link, h.reason].filter(Boolean).join(' · ')}</p>
                      {h.snapshot && (
                        <details><summary>历史内容</summary>
                          <pre>{h.snapshot.title + '\n' + h.snapshot.body + '\n' + (h.snapshot.criteria || []).join('\n')}</pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
                {!editing.archived && editing.status !== 'in_progress' && (
                  <button className="btn secondary" disabled={busy}
                    onClick={async () => { if (await act({ op: 'archive', id: editing.id })) setModal(''); }}>
                    归档需求（保留历史快照）
                  </button>
                )}
              </>
            )}

            {modal === 'verify' && editing && (
              <>
                {unresolvedFailures(editing).length > 0 && (
                  <div className="prior-failures">
                    <div className="prior-failures-head">
                      <strong>之前的未解决问题</strong>
                      <span>请确认修复状态：确认已修复的问题不再带入下一轮 Prompt，仍未修复的会标注「此前问题未修复」</span>
                    </div>
                    {unresolvedFailures(editing).map((f, n) => (
                      <div className="prior-failure" key={n}>
                        <p>{f.note}<small>{new Date(f.time).toLocaleString('zh-CN')}</small></p>
                        <div className="prior-failure-choice">
                          <label><input type="radio" name={'fixed-' + n} checked={!fixedIdx.includes(n)}
                            onChange={() => setFixedIdx(fixedIdx.filter((x) => x !== n))} />仍未修复</label>
                          <label><input type="radio" name={'fixed-' + n} checked={fixedIdx.includes(n)}
                            onChange={() => setFixedIdx([...fixedIdx, n])} />已修复</label>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <label className="field">{unresolvedFailures(editing).length ? '新增问题（选填）' : '未通过的内容（选填）'}
                  <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder={unresolvedFailures(editing).length
                      ? '描述本次新出现的问题；之前的问题用上方选项确认状态'
                      : '描述哪里未通过，会自动带入下一轮 Prompt；也可以留空'} />
                </label>
                <button className="btn primary" disabled={busy}
                  onClick={async () => {
                    // 退回后停留在待验证列表继续处理其余需求；去向用 toast 说明
                    if (await act({ op: 'verify', id: editing.id, pass: false, note, fixed: fixedIdx })) {
                      setModal('');
                      notify('已退回待执行，可稍后编辑重新生成 Prompt');
                    }
                  }}>记录未通过，退回待执行</button>
              </>
            )}

            {modal === 'regress' && (
              <>
                <label className="field">回归问题（选填）<textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></label>
                <button className="btn primary" disabled={busy}
                  onClick={async () => {
                    if (await act({ op: 'regress', id: editing!.id, note })) {
                      setModal(''); setSelected([]);
                      notify('已重新打开，需求回到待执行');
                    }
                  }}>退回待执行</button>
              </>
            )}

            {modal === 'deleteProject' && deleting && (
              <>
                <p className="detail-body">
                  即将删除项目「<strong>{deleting.name}</strong>」，包含 {deleting.items.length} 条需求（含已归档与验证历史）
                  和 {deleting.batches.length} 个 Prompt 批次。
                </p>
                <p className="delete-warning">删除后无法恢复。如需保留备份，请先在左下角「导出全部数据」。</p>
                <div className="editor-footer">
                  <button className="btn" disabled={busy} onClick={() => { setDeleting(null); setModal(''); }}>取消</button>
                  <button className="btn danger" disabled={busy}
                    onClick={async () => {
                      const r = await act({ op: 'deleteProject', project: deleting.id });
                      if (r) {
                        setDeleting(null); setModal('');
                        // 删除的是当前项目时，切换到剩余的第一个项目
                        if (!r.projects.some((x) => x.id === pid)) switchProject(r.projects[0]?.id || '');
                        notify('项目已删除');
                      }
                    }}>
                    <Trash size={14} />确认删除
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      {browserOpen && p && (
        <ProjectBrowser
          project={p}
          onClose={() => setBrowserOpen(false)}
          onDirChange={async (dir) => { await act({ op: 'projectDir', dir }, true); }}
          notify={notify}
          onCommitted={load}
          saveRemote={async (remote) => !!await act({ op: 'projectRemote', remote }, true)}
        />
      )}
    </div>
  );
}
