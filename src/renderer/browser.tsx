// 「浏览项目」浮层 —— 关联本地目录后查看/编辑项目文件。
// 左侧懒加载目录树，右侧查看器：Markdown 预览/编辑切换、多格式图片预览、
// 普通文本编辑保存。所有文件访问经 IPC 在主进程做「关联目录内」校验。

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { pendingCommitItems, buildCommitMessage, type Project } from '../core/domain';
import { bridge, type FileEntry, type GitChange, type GitStatusInfo } from './api';
import { renderMarkdown } from './markdown';
import { ProjectRemoteOverlay } from './project-remote';
import type { RemoteSettings } from '../core/remote';
import { highlightCode } from './highlight';
import {
  ChevronRight, Copy, Eye, ExternalLink, FileText, Folder, FolderOpen, GitBranch,
  ImageIcon, ListNumbers, Minus, Pencil, Plus, RefreshCw, Save, X, Wand, Settings
} from './icons';

const MD_EXTS = new Set(['md', 'markdown', 'mdx']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);
// 明确的二进制格式黑名单：其余（含未知扩展名、点文件、无后缀文件）一律按文本尝试打开，
// 由主进程做内容嗅探（出现 NUL 字节即视为二进制并拒绝），避免白名单枚举遗漏
const BINARY_EXTS = new Set([
  'exe', 'dll', 'sys', 'msi', 'so', 'dylib', 'a', 'lib', 'bin', 'dat', 'o', 'obj', 'class', 'jar', 'war',
  'zip', '7z', 'rar', 'gz', 'bz2', 'xz', 'zst', 'br', 'tar', 'cab', 'iso', 'apk', 'ipa', 'deb', 'rpm', 'dmg', 'pkg',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'mdb', 'accdb', 'psd', 'ai', 'eps', 'indd',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'mid',
  'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp',
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'fon', 'icns', 'pyc', 'pyo', 'wasm', 'node', 'sqlite', 'db', 'lnk'
]);

// 点文件的「扩展名」从去掉前导点后的名字取（.gitignore / .env.local 都能正确识别）
const extOf = (name: string) => {
  const base = name.replace(/^\.+/, '');
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
};
const kindOf = (name: string): 'md' | 'image' | 'text' | 'other' => {
  const ext = extOf(name);
  if (MD_EXTS.has(ext)) return 'md';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext && BINARY_EXTS.has(ext)) return 'other';
  return 'text';
};
const humanSize = (n: number) =>
  n < 1024 ? n + ' B' : n < 1024 * 1024 ? (n / 1024).toFixed(1) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';

/** 文件的绝对路径（跟随关联目录的分隔符风格：Windows 用 \，其余用 /）。 */
const absPath = (root: string, rel: string) => {
  if (!rel) return root;
  const sep = root.includes('\\') ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + rel.replace(/\//g, sep);
};

/** 编辑器语法高亮的语言族映射（未知返回 ''，高亮层退化为纯文本）。 */
const LANG_OF: Record<string, string> = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', json: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup',
  py: 'py', rb: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', bat: 'bat', cmd: 'bat', ps1: 'ps1', sql: 'sql',
  java: 'clike', kt: 'clike', c: 'clike', h: 'clike', cpp: 'clike', hpp: 'clike', cc: 'clike',
  cs: 'clike', go: 'clike', rs: 'clike', php: 'clike', swift: 'clike', dart: 'clike', scala: 'clike', gradle: 'clike',
  yml: 'conf', yaml: 'conf', toml: 'conf', ini: 'conf', cfg: 'conf', conf: 'conf', env: 'conf', properties: 'conf',
  md: 'md', markdown: 'md', mdx: 'md'
};
// 语法高亮分档：小于此规模每次输入同步重算；超过则防抖；再超过直接纯文本
const HL_SYNC_LIMIT = 50000;
const HL_PLAIN_LIMIT = 300000;

/** Markdown 里相对路径的图片/资源：相对 md 文件所在目录解析（/ 开头视为相对项目根）。 */
function resolveRel(mdRel: string, src: string): string {
  const parts = (src.startsWith('/') ? [] : mdRel.split('/').slice(0, -1)).concat(
    src.replace(/^\//, '').split('/')
  );
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') { out.pop(); continue; }
    out.push(p);
  }
  return out.join('/');
}

type Props = {
  project: Project;
  onClose: () => void;
  onCommitted: () => Promise<void>;
  onDirChange: (dir: string) => Promise<unknown>;
  saveRemote: (remote: RemoteSettings) => Promise<boolean>;
  notify: (text: string, kind?: 'ok' | 'err') => void;
};

export function ProjectBrowser({ project, onClose, onDirChange, notify, onCommitted, saveRemote }: Props) {
  const [remoteOpen, setRemoteOpen] = useState(false);
  const root = project.dir || '';

  const [tree, setTree] = useState<Record<string, FileEntry[] | 'loading' | 'error'>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [file, setFile] = useState<FileEntry | null>(null);
  const [kind, setKind] = useState<'md' | 'image' | 'text' | 'other'>('other');
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileError, setFileError] = useState('');
  const [content, setContent] = useState('');        // 文本内容（编辑态）
  const [savedContent, setSavedContent] = useState(''); // 最近一次磁盘上的内容
  const [mdMode, setMdMode] = useState<'preview' | 'edit'>('preview');
  const [image, setImage] = useState<{ dataUrl: string; mime: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [lineNumbers, setLineNumbers] = useState(false); // 行号显示：默认不启用
  // Git 面板：gitSupported=null 检测中；false（无 git / 浏览器预览）时整个 Git 区不渲染
  const [gitSupported, setGitSupported] = useState<boolean | null>(null);
  const [git, setGit] = useState<GitStatusInfo | null>(null);
  const [gitOpen, setGitOpen] = useState(true);
  const [commitEditor, setCommitEditor] = useState(false);
  const [gitBusy, setGitBusy] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const aiSequence = useRef(0);
  useEffect(() => { aiSequence.current++; setAiBusy(false); setAiError(''); return () => { aiSequence.current++; }; }, [root, project.id]);
  async function generateCommitMessage() {
    if (aiBusy || gitBusy) return;
    if (!stagedChanges.length) { setAiError('请先 Add 暂存变动，再生成提交文案'); return; }
    const sequence = ++aiSequence.current;
    setAiBusy(true);
    setAiError('');
    try {
      const result = await bridge.optimizeCommitMessage?.(project.id, commitMsg);
      if (sequence !== aiSequence.current) return;
      if (!result?.ok || !result.message) throw Error(result?.error || 'AI 提交文案仅桌面版可用');
      setCommitMsg(result.message); notify('AI 提交文案已生成');
    } catch (e: any) { if (sequence === aiSequence.current) { setAiError(e.message); notify(e.message, 'err'); } }
    finally { if (sequence === aiSequence.current) setAiBusy(false); }
  }
  const [newBranch, setNewBranch] = useState<string | null>(null); // null=不显示新建输入
  // 文件及文件夹右键菜单（REQ-030）：菜单项点击/点击其他位置/Esc 关闭
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const mdRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const hlRef = useRef<HTMLPreElement>(null);
  const [hlHtml, setHlHtml] = useState(''); // 编辑器底层高亮层
  const openSeq = useRef(0); // 竞态防护：仅采纳最新一次打开文件的结果

  const pendingItems = pendingCommitItems(project);
  const suggestedMessage = buildCommitMessage(pendingItems);
  const dirty = content !== savedContent;

  async function loadDir(rel: string) {
    setTree((t) => ({ ...t, [rel]: 'loading' }));
    const r = await bridge.listDir?.(root, rel);
    setTree((t) => ({ ...t, [rel]: !r || !r.ok ? 'error' : r.entries }));
  }

  // 关联目录变化（含首次打开）时重置并加载根目录
  useEffect(() => {
    if (!root) { setTree({}); setFile(null); return; }
    setTree({});
    setFile(null); setImage(null); setFileError(''); setContent('');
    setExpanded(new Set(['']));
    loadDir('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // Git 状态：目录变化时检测本机 git 并读取仓库状态
  useEffect(() => {
    setGit(null); setGitOpen(true); setCommitMsg(''); setNewBranch(null);
    if (!root) { setGitSupported(null); return; }
    let cancelled = false;
    (async () => {
      const a = await bridge.gitAvailable?.();
      if (cancelled) return;
      const supported = !!a?.ok && !!a?.available;
      setGitSupported(supported);
      if (!supported) return;
      const s = await bridge.gitStatus?.(root);
      if (!cancelled) { setGit(s && s.ok ? s : null); setGitOpen(!!s?.ok && (!s.repo || s.changes.some((c) => c.worktree !== ' ' || c.index === '?'))); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, project.id]);

  async function refreshGit() {
    if (!root) return;
    const r = await bridge.gitStatus?.(root);
    setGit(r && r.ok ? r : null);
  }

  /** 执行一次 git 操作：成功后刷新状态（after='tree' 时连带刷新文件树）。 */
  async function gitOp(fn: () => Promise<{ ok: boolean; error?: string; summary?: string } | undefined> | undefined, opts?: { tree?: boolean }) {
    if (gitBusy || aiBusy) return false;
    setGitBusy(true);
    try {
      const r = await fn();
      if (!r || !r.ok) {
        notify((r && !r.ok ? r.error : '') || 'Git 操作失败', 'err');
        return false;
      }
      await refreshGit();
      if (opts?.tree) { setTree({}); loadDir(''); }
      if (r.summary) notify(r.summary);
      return true;
    } finally {
      setGitBusy(false);
    }
  }

  function doInit() {
    gitOp(async () => {
      const ok = await bridge.gitInit?.(root);
      if (ok?.ok) notify('已初始化 Git 仓库');
      return ok;
    }, { tree: true });
  }
  function stage(paths: string[]) {
    gitOp(() => bridge.gitStage?.(root, 'stage', paths));
  }
  function unstage(paths: string[]) {
    gitOp(() => bridge.gitStage?.(root, 'unstage', paths));
  }
  function doCommit() {
    gitOp(async () => {
      const r = await bridge.gitCommit?.(root, commitMsg, project.id, pendingItems.map((i) => ({ id: i.id, version: i.version })));
      if (r?.ok) { setCommitMsg(''); await onCommitted(); notify(r.warning || '提交成功', r.warning ? 'err' : 'ok'); }
      return r;
    });
  }
  function switchBranch(name: string) {
    gitOp(async () => {
      const r = await bridge.gitBranchSwitch?.(root, name);
      if (r?.ok) notify('已切换到分支 ' + name);
      return r;
    }, { tree: true });
  }
  function createBranch() {
    const name = (newBranch || '').trim();
    if (!name) return;
    gitOp(async () => {
      const r = await bridge.gitBranchCreate?.(root, name);
      if (r?.ok) { setNewBranch(null); notify('已创建并切换到分支 ' + name); }
      return r;
    }, { tree: true });
  }

  function openGitFile(c: GitChange) {
    const name = c.path.split('/').pop() || c.path;
    openFile({ name, rel: c.path, dir: false, size: 0 });
  }

  const gitLabel = (x: string) =>
    x === '?' ? '未跟踪' : (({ M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制' } as any)[x] || '变动');
  const stagedChanges = (git?.changes || []).filter((c) => c.index !== ' ' && c.index !== '?');
  const unstagedChanges = [
    ...(git?.changes || []).filter((c) => c.worktree !== ' ' && c.worktree !== '?'),
    ...(git?.changes || []).filter((c) => c.index === '?')
  ];

  // Esc 关闭（右键菜单 → 提交信息编辑 → 整个浮层，逐层退）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (remoteOpen) return; if (fileMenu) setFileMenu(null); else if (commitEditor) setCommitEditor(false); else onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, commitEditor, fileMenu, remoteOpen]);

  // 右键菜单：点击任意位置或窗口尺寸变化时关闭（菜单项自身的点击先于 window 监听触发）
  useEffect(() => {
    if (!fileMenu) return;
    const close = () => setFileMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('resize', close); };
  }, [fileMenu]);

  async function copyText(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); notify('已复制' + label); }
    catch { notify('复制失败，请检查剪贴板权限', 'err'); }
  }

  async function openFile(entry: FileEntry) {
    if (!entry.dir) setFile(entry);
    else return;
    const k = kindOf(entry.name);
    setKind(k);
    setFileError('');
    const seq = ++openSeq.current;
    if (k === 'other') { setImage(null); setContent(''); return; }
    setLoadingFile(true);
    try {
      if (k === 'image') {
        setContent(''); setSavedContent('');
        const r = await bridge.readImage?.(root, entry.rel);
        if (seq !== openSeq.current) return;
        if (!r || !r.ok) { setFileError(r && !r.ok ? r.error : '读取图片失败'); setImage(null); }
        else setImage({ dataUrl: r.dataUrl, mime: r.mime });
      } else {
        setImage(null);
        const r = await bridge.readFile?.(root, entry.rel);
        if (seq !== openSeq.current) return;
        if (!r || !r.ok) { setFileError(r && !r.ok ? r.error : '读取文件失败'); setContent(''); setSavedContent(''); }
        else { setContent(r.content); setSavedContent(r.content); setMdMode('preview'); }
      }
    } finally {
      if (seq === openSeq.current) setLoadingFile(false);
    }
  }

  async function reloadFile() {
    if (file) {
      const keep = file;
      await openFile(keep);
      if (kindOf(keep.name) !== 'other') notify('已重新加载');
    }
  }

  async function saveFile() {
    if (!file || saving || !dirty) return;
    setSaving(true);
    try {
      const r = await bridge.writeFile?.(root, file.rel, content);
      if (!r || !r.ok) notify((r && !r.ok ? r.error : '保存失败') || '保存失败', 'err');
      else { setSavedContent(content); notify('已保存 ' + file.name); }
    } finally {
      setSaving(false);
    }
  }

  async function pickDir() {
    if (picking) return;
    setPicking(true);
    try {
      const r = await bridge.pickDir?.();
      if (r?.ok && r.dir) await onDirChange(r.dir);
    } finally {
      setPicking(false);
    }
  }

  // Markdown 预览：渲染后把相对路径图片解析为 data URL（网络图片直接可显示）
  useEffect(() => {
    const el = mdRef.current;
    if (!el || kind !== 'md' || mdMode !== 'preview') return;
    let cancelled = false;
    el.querySelectorAll<HTMLImageElement>('img[data-src]').forEach(async (img) => {
      const src = img.getAttribute('data-src') || '';
      const rel = resolveRel(file?.rel || '', src.replace(/%20/g, ' '));
      const r = rel ? await bridge.readImage?.(root, rel) : undefined;
      if (cancelled) return;
      if (r?.ok) img.src = r.dataUrl;
      else {
        img.removeAttribute('data-src');
        img.alt = '图片加载失败：' + src;
        img.title = src;
      }
    });
    return () => { cancelled = true; };
  }, [kind, mdMode, content, file, root]);

  function toggleDir(rel: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
    if (!(rel in tree)) loadDir(rel);
  }

  function renderDir(rel: string, depth: number): ReactNode {
    const state = tree[rel];
    const isOpen = expanded.has(rel);
    const entry: FileEntry = { name: (rel || root).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root, rel, dir: true, size: 0 };
    return (
      <div key={rel || 'root'} className="fb-branch">
        <button className={'fb-row dir' + (isOpen ? ' open' : '')} style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => toggleDir(rel)} title={rel || '项目根目录'}
          onContextMenu={(ev) => { ev.preventDefault(); setFileMenu({ x: ev.clientX, y: ev.clientY, entry }); }}>
          <span className="fb-chev"><ChevronRight size={13} /></span>
          {isOpen ? <FolderOpen size={15} /> : <Folder size={15} />}
          <span className="fb-name">{rel ? rel.split('/').pop() : project.name}</span>
        </button>
        {isOpen && (
          <div className="fb-children">
            {state === undefined && <div className="fb-hint">加载中…</div>}
            {state === 'loading' && <div className="fb-hint">加载中…</div>}
            {state === 'error' && <div className="fb-hint err">读取失败</div>}
            {Array.isArray(state) && state.length === 0 && <div className="fb-hint">空目录</div>}
            {Array.isArray(state) && state.map((e) =>
              e.dir ? (e.name === '.git' ? null : renderDir(e.rel, depth + 1)) : (
                <button key={e.rel} className={'fb-row file' + (file?.rel === e.rel ? ' active' : '')}
                  style={{ paddingLeft: 6 + (depth + 1) * 14 + 15 }}
                  onClick={() => openFile(e)} title={e.rel}
                  onContextMenu={(ev) => { ev.preventDefault(); setFileMenu({ x: ev.clientX, y: ev.clientY, entry: e }); }}>
                  {kindOf(e.name) === 'image' ? <ImageIcon size={14} /> : <FileText size={14} />}
                  <span className="fb-name">{e.name}</span>
                </button>
              )
            )}
          </div>
        )}
      </div>
    );
  }

  const previewHtml = kind === 'md' && mdMode === 'preview' ? renderMarkdown(content) : '';
  // 编辑器可见（文本文件，或 Markdown 切到编辑页）时才提供行号开关与编辑区
  const editorVisible = !!file && !loadingFile && !fileError &&
    (kind === 'text' || (kind === 'md' && mdMode === 'edit'));
  const hlLang = file ? (LANG_OF[extOf(file.name)] || '') : '';

  // 语法高亮层：小文件同步计算（无闪烁）；中等文件输入防抖；超大文件退化为纯文本
  useLayoutEffect(() => {
    if (!editorVisible) return;
    if (content.length > HL_PLAIN_LIMIT) {
      setHlHtml(highlightCode(content, ''));
      return;
    }
    if (content.length > HL_SYNC_LIMIT) {
      const t = setTimeout(() => setHlHtml(highlightCode(content, hlLang)), 150);
      return () => clearTimeout(t);
    }
    setHlHtml(highlightCode(content, hlLang));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, hlLang, editorVisible]);

  return (
    <div className="fb-overlay" role="dialog" aria-label="浏览项目文件"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {remoteOpen && <ProjectRemoteOverlay project={project} save={saveRemote} onClose={() => setRemoteOpen(false)} notify={notify} />}
      {commitEditor && <div className="overlay commit-editor" onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setCommitEditor(false); }}>
        <div className="dialog" role="dialog" aria-label="编辑完整提交信息"><h3>编辑完整提交信息</h3><label className="field"><span>提交文案</span><textarea autoFocus rows={12} value={commitMsg} disabled={gitBusy || aiBusy} onChange={(e) => setCommitMsg(e.target.value)} /></label>{!stagedChanges.length && <p className="commit-status">请先 Add 暂存变动，再生成提交文案</p>}
                      {aiBusy && <p className="commit-status" role="status">AI 正在生成提交文案…</p>}{aiError && <p className="commit-status error" role="alert">{aiError}</p>}<div className="dialog-foot"><button className="btn" disabled={gitBusy || aiBusy || !pendingItems.length} onClick={() => { setCommitMsg(suggestedMessage); setAiError(''); }}>填入需求</button><button className="btn" disabled={gitBusy || aiBusy || !stagedChanges.length || !bridge.optimizeCommitMessage} onClick={generateCommitMessage}><Wand />{aiBusy ? '生成中…' : 'AI 优化'}</button><button className="btn primary" disabled={aiBusy} onClick={() => setCommitEditor(false)}>完成编辑</button></div></div>
      </div>}
      {fileMenu && (
        <div className="fb-context-menu" role="menu" aria-label={(fileMenu.entry.dir ? '文件夹操作 · ' : '文件操作 · ') + fileMenu.entry.name}
          style={{
            left: Math.min(fileMenu.x, window.innerWidth - 210),
            top: Math.min(fileMenu.y, window.innerHeight - 150)
          }}
          onClick={(e) => e.stopPropagation()}>
          <span className="fb-context-title" title={fileMenu.entry.name}>{fileMenu.entry.name}</span>
          <button role="menuitem" title={'复制名称：' + fileMenu.entry.name}
            onClick={() => { copyText(fileMenu.entry.name, fileMenu.entry.dir ? '文件夹名' : '文件名'); setFileMenu(null); }}>
            <Copy size={14} />{fileMenu.entry.dir ? '复制文件夹名' : '复制文件名'}
          </button>
          <button role="menuitem" title={'复制完整路径：' + absPath(root, fileMenu.entry.rel)}
            onClick={() => { copyText(absPath(root, fileMenu.entry.rel), fileMenu.entry.dir ? '文件夹路径' : '文件路径'); setFileMenu(null); }}>
            <Copy size={14} />{fileMenu.entry.dir ? '复制文件夹路径' : '复制文件路径'}
          </button>
          <button role="menuitem" title="在系统资源管理器中显示"
            onClick={() => { bridge.revealFile?.(root, fileMenu.entry.rel); setFileMenu(null); }}>
            <ExternalLink size={14} />从资源管理器查看
          </button>
        </div>
      )}
      <div className="fb">
        <button className="fb-close" title="关闭（Esc）" aria-label="关闭浏览项目" onClick={onClose}>
          <X size={19} />
        </button>
        <aside className="fb-tree">
          <div className="fb-tree-head">
            <div className="fb-tree-title">
              <FolderOpen size={15} />
              <strong>项目文件</strong>
              <button className="icon-btn" aria-label="刷新目录" title="刷新目录"
                onClick={() => { setTree({}); loadDir(''); setExpanded(new Set([''])); }}>
                <RefreshCw size={14} />
              </button>
            </div>
            {root ? (
              <span className="fb-root-path" title={root}>{root}</span>
            ) : (
              <span className="fb-root-path">未关联目录</span>
            )}
            <div className="fb-tree-actions">
              <button className="btn plain" disabled={picking} onClick={pickDir}>
                <FolderOpen size={14} />{root ? '更换目录' : '选择项目目录'}
              </button>
              {root && (
                <button className="btn plain" disabled={picking}
                  onClick={async () => { await onDirChange(''); notify('已取消关联目录'); }}>
                  <X size={13} />取消关联
                </button>
              )}
              <button className="btn plain" title="GitHub / GitLab 配置与连接测试" onClick={() => setRemoteOpen(true)}>
                <Settings size={13} />远程仓库设置
              </button>
            </div>
          </div>
          <div className="fb-tree-body">
            {!root ? (
              <div className="fb-picker">
                <Folder size={30} />
                <p>关联本地项目目录后，可直接查看与编辑项目文件。</p>
                <button className="btn primary" disabled={picking} onClick={pickDir}>
                  <FolderOpen size={15} />选择项目目录
                </button>
              </div>
            ) : (
              renderDir('', 0)
            )}
          </div>


          {gitSupported && root && (
            <div className={'fb-git' + (gitOpen ? ' open' : '')}>
              <div className="fb-git-head">
                <button className="fb-git-toggle" aria-expanded={gitOpen} onClick={() => { setGitOpen(!gitOpen); if (!gitOpen) refreshGit(); }}>
                  <GitBranch size={14} />
                  <strong>Git</strong>
                  {pendingItems.length > 0 && <span className="fb-git-count" title="已完成但尚未提交到 Git 的需求">{pendingItems.length} 条待提交</span>}
                  {git?.repo
                    ? <span className="fb-git-badge" title={git.branch + (git.ahead || git.behind ? `（ahead ${git.ahead} / behind ${git.behind}）` : '')}>
                        {git.branch}{git.ahead ? ` ↑${git.ahead}` : ''}{git.behind ? ` ↓${git.behind}` : ''}
                      </span>
                    : git ? <span className="fb-git-norepo">未初始化</span> : null}
                  {git?.repo && git.changes.length > 0 && (
                    <span className="fb-git-count">{git.changes.length} 项变动</span>
                  )}
                  <span className="fb-git-chev"><ChevronRight size={13} /></span>
                </button>
                <button className="icon-btn fb-git-refresh" aria-label="刷新 Git 状态" title="刷新 Git 状态"
                  onClick={refreshGit}><RefreshCw size={13} /></button>
              </div>
              {gitOpen && (
                <div className="fb-git-body">
                  {!git?.repo ? (
                    <div className="fb-git-noinit">
                      <p>当前目录还不是 Git 仓库，初始化后可跟踪文件变动并提交。</p>
                      <button className="btn sm primary" disabled={gitBusy} onClick={doInit}>
                        <Plus size={13} />初始化仓库（git init）
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="fb-git-requirements"><span>待 Git 提交需求 {pendingItems.length} 条</span>{pendingItems.length > 0 && <details><summary>查看需求</summary>{pendingItems.map((i) => <small key={i.id} title={i.number + ' · ' + (i.title || i.body)}>{i.number} · {i.title || i.body.slice(0, 36)}</small>)}</details>}</div>
                      <div className="fb-git-changes">
                      <div className="fb-git-group">
                        <span>变动 {unstagedChanges.length}</span>
                        {unstagedChanges.length > 0 && (
                          <button className="fb-git-linklike" disabled={gitBusy} title="git add -A：暂存全部变动" onClick={() => stage([])}>Add</button>
                        )}
                      </div>
                      {unstagedChanges.length === 0 && <p className="fb-git-empty">没有未暂存的变动</p>}
                      {unstagedChanges.map((c) => (
                        <div key={'u-' + c.path} className="fb-git-file" title={c.path} onClick={() => openGitFile(c)}>
                          <span className="fb-git-status st-w">{gitLabel(c.worktree !== ' ' && c.worktree !== '?' ? c.worktree : '?')}</span>
                          <span className="fb-git-path">{c.path}</span>
                          <button className="fb-git-act" disabled={gitBusy} title="Add（暂存文件）"
                            onClick={(e) => { e.stopPropagation(); stage([c.path]); }}><Plus size={12} /></button>
                        </div>
                      ))}

                      {stagedChanges.length > 0 && (
                        <>
                          <div className="fb-git-group">
                            <span>已暂存 {stagedChanges.length}</span>
                            <button className="fb-git-linklike" disabled={gitBusy} onClick={() => unstage([])}>全部取消</button>
                          </div>
                          {stagedChanges.map((c) => (
                            <div key={'s-' + c.path} className="fb-git-file staged" title={c.path} onClick={() => openGitFile(c)}>
                              <span className="fb-git-status st-i">{gitLabel(c.index)}</span>
                              <span className="fb-git-path">{c.path}</span>
                              <button className="fb-git-act" disabled={gitBusy} title="取消暂存"
                                onClick={(e) => { e.stopPropagation(); unstage([c.path]); }}><Minus size={12} /></button>
                            </div>
                          ))}
                        </>
                      )}
                      </div>
                      <p className="settings-hint">Pull → Add → AI 生成 Log → Commit → Push</p>
                      <div className="fb-git-commit">
                        <div className="commit-input field"><button type="button" className="icon-btn" aria-label="AI 生成提交文案" title={aiBusy ? 'AI 正在生成…' : !stagedChanges.length ? '请先 Add 暂存变动' : '根据暂存 diff 与需求生成提交文案'} disabled={gitBusy || aiBusy || !stagedChanges.length || !bridge.optimizeCommitMessage} onClick={generateCommitMessage}><Wand size={18} /></button><textarea rows={1} aria-label="Git 提交信息" value={commitMsg} placeholder={aiBusy ? 'AI 正在生成…' : '点击左侧魔术棒生成提交文案'} disabled={gitBusy || aiBusy}
                          onChange={(e) => setCommitMsg(e.target.value)}
                          onKeyDown={(e) => { if (e.ctrlKey && e.key === 'Enter' && commitMsg.trim() && stagedChanges.length) doCommit(); }} /></div>
                        <div className="commit-actions"><button className="btn sm" disabled={gitBusy || aiBusy} title="展开完整提交信息" onClick={() => setCommitEditor(true)}>展开</button>
                        <button className="btn sm primary" disabled={gitBusy || aiBusy || !commitMsg.trim() || stagedChanges.length === 0}
                          title={stagedChanges.length === 0 ? '先暂存变动再提交' : undefined}
                          onClick={doCommit}>Commit</button></div>
                      </div>
                      {aiBusy && <p className="commit-status" role="status">AI 正在生成提交文案…</p>}
                      {aiError && <p className="commit-status error" role="alert">{aiError}</p>}
                      <div className="fb-git-branch-row">
                        <select value={git.branch} disabled={gitBusy} title="切换分支"
                          onChange={(e) => { const v = e.target.value; e.target.value = git.branch; if (v !== git.branch) switchBranch(v); }}>
                          {git.branches.length ? git.branches.map((b) => <option key={b} value={b}>{b}</option>)
                            : <option value={git.branch}>{git.branch}</option>}
                        </select>
                        {newBranch === null ? (
                          <button className="icon-btn" aria-label="新建分支" title="新建并切换分支"
                            disabled={gitBusy} onClick={() => setNewBranch('')}><Plus size={14} /></button>
                        ) : (
                          <div className="fb-git-newbranch">
                            <input autoFocus value={newBranch} placeholder="分支名，如 feature/x"
                              onChange={(e) => setNewBranch(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') createBranch(); if (e.key === 'Escape') setNewBranch(null); }} />
                            <button className="btn sm primary" disabled={!newBranch.trim() || gitBusy} onClick={createBranch}>创建并切换</button>
                            <button className="btn sm" onClick={() => setNewBranch(null)}>取消</button>
                          </div>
                        )}
                      </div>

                      <div className="fb-git-group"><span>历史 Git Log · 最近 30 条</span><button className="btn sm" title="从当前分支上游快进拉取；有本地变动时拒绝操作" disabled={gitBusy || aiBusy || dirty || !bridge.gitPull} onClick={() => gitOp(() => bridge.gitPull?.(root), { tree: true })}>Pull</button><button className="btn sm" title={git.upstream ? '推送当前分支到上游' : '推送当前分支并关联 origin'} disabled={gitBusy || aiBusy || (git.ahead === 0 && git.upstream) || !bridge.gitPush} onClick={() => gitOp(() => bridge.gitPush?.(root))}>Push</button></div>
                      {!(git.log || []).length && <p className="fb-git-empty">暂无提交记录</p>}
                      <div className="fb-git-logs">{(git.log || []).map((entry) => <div key={entry.hash} className="fb-git-log" title={entry.hash + '\n' + entry.author + ' · ' + entry.date + '\n\n' + entry.message}><code>{entry.hash.slice(0, 7)}</code><span>{entry.message.split('\n')[0]}</span></div>)}</div>




                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </aside>

        <section className="fb-viewer">
          <div className="fb-viewer-head">
            {file ? (
              <>
                {kind === 'image' ? <ImageIcon size={16} /> : <FileText size={16} />}
                <div className="fb-file-meta">
                  <strong className="fb-file-name">{file.name}</strong>
                  <span className="fb-file-path" title={file.rel}>{file.rel} · {humanSize(file.size)}</span>
                </div>
                <div className="fb-viewer-actions">
                  {(kind === 'md') && (
                    <div className="fb-seg">
                      <button className={mdMode === 'preview' ? 'on' : ''} onClick={() => setMdMode('preview')}>
                        <Eye size={14} />预览
                      </button>
                      <button className={mdMode === 'edit' ? 'on' : ''} onClick={() => setMdMode('edit')}>
                        <Pencil size={13} />编辑
                      </button>
                    </div>
                  )}
                  {kind !== 'other' && kind !== 'image' && (
                    <button className="btn primary sm" disabled={!dirty || saving} onClick={saveFile} title="Ctrl+S">
                      <Save size={14} />{saving ? '保存中…' : dirty ? '保存' : '已保存'}
                    </button>
                  )}
                  {editorVisible && (
                    <button className={'icon-btn' + (lineNumbers ? ' on' : '')}
                      aria-label="显示行号" aria-pressed={lineNumbers}
                      title={lineNumbers ? '隐藏行号' : '显示行号'}
                      onClick={() => setLineNumbers((v) => !v)}>
                      <ListNumbers size={15} />
                    </button>
                  )}
                  <button className="icon-btn" aria-label="重新加载" title="重新加载" disabled={loadingFile}
                    onClick={reloadFile}><RefreshCw size={15} /></button>
                  <button className="icon-btn" aria-label="打开所在位置" title="在资源管理器中显示"
                    onClick={() => file && bridge.revealFile?.(root, file.rel)}><ExternalLink size={15} /></button>
                </div>
              </>
            ) : (
              <span className="fb-viewer-idle">选择左侧文件查看内容</span>
            )}
          </div>

          <div className="fb-body">
            {!file && (
              <div className="fb-empty">
                <FileText size={30} />
                <h3>{root ? '从左侧选择文件' : '先关联项目目录'}</h3>
                <p>{root
                  ? '支持 Markdown 预览/编辑、多格式图片预览；文本文件可直接查看编辑（未知格式自动按文本尝试，二进制自动识别）。'
                  : '点击左侧「选择项目目录」，把本地项目关联进来。'}</p>
              </div>
            )}
            {file && loadingFile && <div className="fb-empty"><h3>加载中…</h3></div>}
            {file && !loadingFile && fileError && (
              <div className="fb-empty err"><h3>无法打开文件</h3><p>{fileError}</p></div>
            )}
            {file && !loadingFile && !fileError && kind === 'other' && (
              <div className="fb-empty">
                <h3>暂不支持预览此格式</h3>
                <p>{file.name}</p>
                <p>二进制文件（可执行程序、压缩包、文档、音视频等）不支持预览；其余格式均按文本打开。</p>
              </div>
            )}
            {file && !loadingFile && !fileError && kind === 'image' && image && (
              <div className="fb-img-wrap">
                <img src={image.dataUrl} alt={file.name} />
                <span className="fb-img-info">{image.mime} · {humanSize(file.size)}</span>
              </div>
            )}
            {file && !loadingFile && !fileError && kind === 'md' && mdMode === 'preview' && (
              <div className="fb-md" ref={mdRef} dangerouslySetInnerHTML={{ __html: previewHtml }}
                onClick={(e) => {
                  const a = (e.target as HTMLElement).closest('a');
                  if (a) {
                    e.preventDefault();
                    const href = a.getAttribute('href') || '';
                    if (/^(https?:|mailto:)/i.test(href)) bridge.openExternal?.(href);
                  }
                }} />
            )}
            {editorVisible && (
              <div className="fb-editor-wrap">
                {lineNumbers && (
                  <div className="fb-gutter" ref={gutterRef} aria-hidden="true">
                    {content.split('\n').map((_l, n) => n + 1).join('\n')}
                  </div>
                )}
                <div className="fb-code">
                  <pre className="fb-hl" ref={hlRef} aria-hidden="true" dangerouslySetInnerHTML={{ __html: hlHtml + '\n' }} />
                  <textarea className="fb-editor" value={content} spellCheck={false}
                    onChange={(e) => setContent(e.target.value)}
                    onScroll={(e) => {
                      const t = e.currentTarget;
                      if (gutterRef.current) gutterRef.current.scrollTop = t.scrollTop;
                      if (hlRef.current) {
                        hlRef.current.scrollTop = t.scrollTop;
                        hlRef.current.scrollLeft = t.scrollLeft;
                      }
                    }}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
                    }} />
                </div>
              </div>
            )}
            {editorVisible && kind === 'md' && mdMode === 'edit' && dirty && (
              <div className="fb-edit-hint">内容已修改，记得保存（Ctrl+S）</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
