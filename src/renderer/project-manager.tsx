import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../core/domain';
import { Eye, EyeOff, X } from './icons';
import { projectDragType, projectDrop, projectDragOver, projectDragLeave, projectDragEnd } from './project-drag';

export function ProjectManager({ data, busy, act, onClose }: {
  data: Workspace; busy: boolean; act(action: any): Promise<unknown>; onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    search.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); if (!busy) close.current(); } };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [busy]);
  const folders = data.folders || [{ id: 'default', name: 'default' }];
  return <div className="overlay" role="dialog" aria-modal="true" aria-label="管理项目" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="dialog project-manager">
      <div className="dialog-head"><div><h3>管理项目</h3><p>拖拽调整组内顺序，或置顶；修改后自动保存。</p></div><button className="icon-btn" aria-label="关闭项目管理" disabled={busy} onClick={onClose}><X /></button></div>
      <div className="project-manager-search"><label className="field">搜索项目<input ref={search} value={query} onChange={event => setQuery(event.target.value)} placeholder="包含隐藏的项目" /></label></div>
      <div className="project-manager-list">
        {folders.map(folder => {
          const peers = data.projects.filter(project => (project.folderId || 'default') === folder.id);
          return <section className="project-manager-group" key={folder.id}><h4>{folder.name}</h4>
            {peers.filter(project => project.name.toLowerCase().includes(query.trim().toLowerCase())).map(project => <div className="project-manager-row" key={project.id} data-project-id={project.id} draggable={!busy} onDragEnd={projectDragEnd} onDragStart={e => { e.dataTransfer.setData(projectDragType, project.id); e.dataTransfer.effectAllowed = 'move'; }} onDragOver={busy ? undefined : projectDragOver} onDragLeave={projectDragLeave} onDrop={e => { if (!busy) projectDrop(e, project.id, act); }}>
              <div className="project-manager-title"><strong title={project.name}>{project.name}</strong><span>{project.hidden ? '已隐藏' : '显示中'}</span></div>
              <div className="project-manager-actions">
                <button className="btn" aria-label={'置顶 ' + project.name} disabled={busy || data.projects.find(pr => (!!project.dir?.startsWith('ssh://') || pr.folderId === project.folderId) && !!pr.dir?.startsWith('ssh://') === !!project.dir?.startsWith('ssh://')) === project} onClick={() => void act({ op: 'projectReorder', project: project.id, position: 'top' })}>置顶</button>
                <button className="btn" disabled={busy} onClick={() => void act({ op: 'projectVisibility', project: project.id, hidden: !project.hidden })}>{project.hidden ? <Eye /> : <EyeOff />}{project.hidden ? '取消隐藏' : '隐藏'}</button>
              </div>
              <div className="project-manager-folders" aria-label={project.name + ' 的分组'}>{folders.map(target => <button key={target.id} className={'tag-btn' + (target.id === folder.id ? ' on' : '')} aria-pressed={target.id === folder.id} disabled={busy || target.id === folder.id} onClick={() => void act({ op: 'projectFolder', project: project.id, folderId: target.id })}>{target.name}</button>)}</div>
            </div>)}
            {!peers.some(project => project.name.toLowerCase().includes(query.trim().toLowerCase())) && <p className="muted">{query ? '无匹配项目' : '暂无项目'}</p>}
          </section>;
        })}
      </div>
      <div className="dialog-foot"><span className="muted">隐藏仅影响侧栏，项目数据与 AI 执行保持正常。</span><button className="btn" disabled={busy} onClick={onClose}>关闭</button></div>
    </div>
  </div>;
}
