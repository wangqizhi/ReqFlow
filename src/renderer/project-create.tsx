import { useRef, useState } from 'react';
import { bridge } from './api';
import { RemoteFields } from './settings';
import { emptyRemote, validateRemote, type RemoteSettings } from '../core/remote';
import { FolderOpen, Plus } from './icons';
import { SSHDirectory, isSSH } from './ssh-directory';

type ProjectInput = { name: string; description: string; dir: string; createDirectory: boolean; remote?: RemoteSettings; folderId?: string; newFolderName?: string };
export function ProjectCreate({ submit, disabled, folders }: { submit(input: ProjectInput): Promise<boolean>; disabled: boolean; folders: { id: string; name: string }[] }) {
  const [mode, setMode] = useState<'choose' | 'local' | 'import'>('choose');
  const [importRemote, setImportRemote] = useState<RemoteSettings>({ ...emptyRemote });
  const [importDir, setImportDir] = useState('');
  const [confirmImport, setConfirmImport] = useState(false);
  const [folderId, setFolderId] = useState(folders[0]?.id || 'default');
  const [newFolder, setNewFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dir, setDir] = useState('');
  const [sshOpen, setSSHOpen] = useState(false);
  const [createDirectory, setCreateDirectory] = useState(true);
  const [bindRemote, setBindRemote] = useState(false);
  const [remote, setRemote] = useState<RemoteSettings>({ ...emptyRemote });
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const lock = useRef(false);
  const busy = disabled || working;
  function changeRemote(value: RemoteSettings) { setRemote(value); setMessage(''); }
  async function perform(operation: () => Promise<void>) {
    if (busy || lock.current) return;
    lock.current = true; setWorking(true); setMessage(''); setError(false);
    try { await operation(); }
    catch (e: any) { setMessage(e.message || '操作失败'); setError(true); }
    finally { lock.current = false; setWorking(false); }
  }
  if (mode === 'choose') return <div className="settings-actions"><button className="btn primary" onClick={() => setMode('import')}>导入项目</button><button className="btn" onClick={() => setMode('local')}>从本地创建</button></div>;
  if (mode === 'import') return <div className="project-create">
    <p className="settings-hint">填写 GitHub / GitLab 地址并选择空文件夹，或选择已有仓库根目录自动识别。使用本机 Git 凭据检查 clone 与 push 权限，不会实际推送。</p>
    <RemoteFields value={importRemote} change={value => { setImportRemote(value); setConfirmImport(false); }} disabled={busy} />
    <label className="field">本地文件夹<input value={importDir} readOnly /></label>
    <div className="settings-actions"><button className="btn" disabled={busy || !bridge.pickDir} onClick={() => perform(async () => { const r = await bridge.pickDir!(); if (!r.ok) throw Error(r.error); if (r.dir) { setImportDir(r.dir); setConfirmImport(false); } })}><FolderOpen />选择本地文件夹</button>
    <button className="btn primary" disabled={busy || !importDir || !bridge.importProject} onClick={() => perform(async () => {
      const r = await bridge.importProject!(importDir, importRemote.url.trim() ? validateRemote(importRemote) : undefined, confirmImport);
      if (r.needsConfirmation) { setConfirmImport(true); setMessage('所选文件夹内已有内容，覆盖可能丢失数据。继续后已有内容会保留为同级备份；匹配的仓库直接关联。确认继续？'); return; }
      if (!r.ok || !r.remote || !r.dir) throw Error(r.error || '导入失败');
      if (!await submit({ name: r.name || '导入项目', description: '', dir: r.dir, createDirectory: false, remote: r.remote, folderId })) throw Error('仓库已准备好，但项目保存失败，请重试');
    })}>{working ? '检查权限并导入中…' : confirmImport ? '确认继续导入' : '导入并创建项目'}</button><button className="btn" disabled={busy} onClick={() => { setMode('local'); setMessage(''); }}>从本地创建</button></div>
    {message && <p className="settings-message project-create-error" role="alert">{message}</p>}
  </div>;
  return <form className="project-create" onSubmit={(e) => { e.preventDefault(); void perform(async () => {
    const settings = bindRemote ? validateRemote(remote) : undefined;
    if (settings && !settings.url) throw Error('请填写仓库地址，或关闭仓库绑定');
    if (newFolder && !folderName.trim()) throw Error('请填写新文件夹名称');
    if (!await submit({ name: name.trim(), description, dir: dir.trim(), createDirectory, remote: settings, ...(newFolder ? { newFolderName: folderName.trim() } : { folderId }) })) throw Error('项目未保存，请检查提示后重试；输入已保留');
  }); }}>
    <fieldset disabled={busy} className="project-create-fields">
      <label className="field">项目名称<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="field"><span>项目分组文件夹</span><div className="segmented project-folder-options" role="group" aria-label="项目分组文件夹">{folders.map((folder) => <button key={folder.id} type="button" title={folder.name} aria-pressed={!newFolder && folderId === folder.id} className={!newFolder && folderId === folder.id ? 'on' : ''} onClick={() => { setFolderId(folder.id); setNewFolder(false); }}>{folder.name}</button>)}<button type="button" className={newFolder ? 'on' : ''} aria-pressed={newFolder} onClick={() => setNewFolder(true)}><Plus />新建文件夹</button></div></div>
      {newFolder && <label className="field">新文件夹名称<input required value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="ReqFlow 内的项目分组，不会创建系统目录" /></label>}
      <label className="field">项目背景<textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="技术栈、目标、代码仓库与运行方式" /></label>
      <label className="field">项目目录 · 可选<input value={dir} readOnly={isSSH(dir)} onChange={(e) => { setDir(e.target.value); setMessage(''); }} placeholder="选择本地文件夹或连接远程服务器" /></label>
      <div className="settings-actions">
        <button type="button" className="btn" disabled={busy || !bridge.pickDir} onClick={() => perform(async () => {
          const r = await bridge.pickDir!(); if (!r.ok) throw Error(r.error || '选择目录失败'); if (r.dir) { setDir(r.dir); setName(current => current.trim() ? current : r.dir!.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || ''); }
        })}><FolderOpen />选择系统文件夹</button>
        <button type="button" className="btn" disabled={busy} onClick={() => setSSHOpen(true)}><FolderOpen />连接远程服务器</button>
        {isSSH(dir) && <button type="button" className="btn" onClick={() => setDir('')}>取消远程绑定</button>}
        <button type="button" className="btn" disabled={busy || isSSH(dir) || !dir.trim() || !bridge.prepareDir} onClick={() => perform(async () => {
          const settings = bindRemote ? validateRemote(remote) : undefined;
          if (settings && !settings.url) throw Error('请填写仓库地址，或关闭仓库绑定');
          const r = await bridge.prepareDir!(dir.trim(), settings); if (!r.ok) throw Error(r.error || '创建目录失败'); setDir(r.dir!); setError(!!r.warning); setMessage(r.warning || r.summary || '目录已准备好；现有文件不会被覆盖');
        })}><Plus />创建此目录</button>
      </div>
      {!isSSH(dir) && <div className="validation-setting"><div><label htmlFor="create-project-directory">目录不存在时创建</label><p>保存项目时创建缺失目录（含父目录）；已有目录不会被清空。不填写目录也可先建项目。</p></div><label className="switch"><input id="create-project-directory" type="checkbox" checked={createDirectory} onChange={(e) => setCreateDirectory(e.target.checked)} /><span className="slider" /><span className="switch-state">{createDirectory ? '已开启' : '已关闭'}</span></label></div>}
      {!bridge.pickDir && <p className="settings-hint">系统目录选择和创建仅桌面版可用；浏览器预览不会创建真实目录。</p>}
      {!isSSH(dir) && <div className="validation-setting"><div><label htmlFor="create-project-remote">绑定 GitHub / GitLab 仓库</label><p>创建时尝试拉取到本地目录：空目录克隆，匹配的干净仓库仅快进更新；不覆盖现有文件。</p></div><label className="switch"><input id="create-project-remote" type="checkbox" checked={bindRemote} onChange={(e) => { setBindRemote(e.target.checked); setMessage(''); }} /><span className="slider" /><span className="switch-state">{bindRemote ? '已开启' : '已关闭'}</span></label></div>}
      {bindRemote && <>
        <RemoteFields value={remote} change={changeRemote} disabled={busy} />
        <div className="settings-actions"><button type="button" className="btn" disabled={busy || !remote.url.trim() || !bridge.testRemote} onClick={() => perform(async () => {
          const settings = validateRemote(remote); const r = await bridge.testRemote!(settings); if (!r.ok) throw Error(r.error || '仓库连接失败'); setMessage('仓库连接成功（只读测试，不会推送或修改仓库）');
        })}>测试连接</button></div>
        <p className="settings-hint">拉取失败仍保留已创建项目并显示原因；未选本地目录时会提示先关联目录。支持 GitLab 自建站。SSH 使用本机密钥与 known_hosts；HTTPS 使用系统 Git 凭据，不要在地址中填写密码或 Token。</p>
      </>}
    </fieldset>
    {message && <p className={'settings-message' + (error ? ' project-create-error' : '')} role={error ? 'alert' : 'status'}>{message}</p>}
    <div className="settings-actions"><button className="btn primary" disabled={busy || !name.trim()}>{working ? (bindRemote ? '创建并拉取中…' : '处理中…') : '创建项目'}</button></div>
    {sshOpen && <SSHDirectory initial={dir} onClose={() => setSSHOpen(false)} onSelect={value => { setDir(value); setName(current => current.trim() ? current : value.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || ""); setBindRemote(false); setSSHOpen(false); }} />}
  </form>;
}
