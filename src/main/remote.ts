import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WorkspaceStore } from '../core/storage';
import { emptyBackup, validateRemote, type BackupSettings, type BackupStatus, type RemoteSettings } from '../core/remote';

export async function runRemoteGit(args: string[], cwd: string, settings: RemoteSettings) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  // Git 使用 SSH 命令字符串，身份路径只允许普通文件路径并严格引用。
  let ssh = 'ssh -o BatchMode=yes -o ConnectTimeout=15';
  if (settings.sshKeyPath) {
    if (/["`$\r\n]/.test(settings.sshKeyPath) || !path.isAbsolute(settings.sshKeyPath)) throw Error('SSH Key 须为有效的绝对文件路径');
    if (!(await fs.stat(settings.sshKeyPath)).isFile()) throw Error('SSH Key 文件不存在');
    ssh += ' -o IdentitiesOnly=yes -i "' + settings.sshKeyPath.replace(/\\/g, '/') + '"';
  }
  Object.assign(env, { GIT_SSH_COMMAND: ssh });
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('Git 连接超时，请检查仓库地址与认证')); }, 60000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(Error(err.trim() || 'Git 操作失败')); });
  });
}

export class BackupManager {
  status: BackupStatus = { running: false };
  private settings: BackupSettings = { ...emptyBackup };
  private timer?: ReturnType<typeof setInterval>;
  private file: string;
  constructor(private dataDir: string) { this.file = path.join(dataDir, 'backup-settings.json'); }
  async load() {
    try { this.settings = this.validate(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
    catch (e: any) { if (e.code !== 'ENOENT') this.status.error = '备份配置读取失败：' + e.message; }
    this.schedule();
    return { ...this.settings };
  }
  getSettings() { return { ...this.settings }; }
  private validate(value: BackupSettings): BackupSettings {
    if (typeof value?.autoSync !== 'boolean') throw Error('自动同步设置无效');
    return { ...validateRemote(value), autoSync: value.autoSync };
  }
  async save(value: BackupSettings) {
    if (this.status.running) throw Error('备份正在同步，请完成后再修改配置');
    const next = this.validate(value);
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.file + '.tmp', JSON.stringify(next), { mode: 0o600 });
    await fs.rename(this.file + '.tmp', this.file);
    this.settings = next;
    this.status = { running: false };
    this.schedule();
  }
  private schedule() {
    if (this.timer) clearInterval(this.timer);
    if (this.settings.url && this.settings.autoSync) {
      this.timer = setInterval(() => { void this.sync().catch(() => {}); }, 60000);
      this.timer.unref();
    }
  }
  async sync() {
    if (this.status.running) throw Error('正在同步，请稍候');
    if (!this.settings.url) throw Error('请先配置备份仓库');
    this.status.running = true;
    try {
      const settings = { ...this.settings };
      // 每个地址/分支独立检出，避免切换仓库时复用旧远程。
      const repo = path.join(this.dataDir, 'backup-repos', createHash('sha256').update(settings.url + '\n' + settings.branch).digest('hex').slice(0, 24));
      const git = (args: string[]) => runRemoteGit(args, repo, settings);
      await fs.mkdir(repo, { recursive: true });
      try { await fs.access(path.join(repo, '.git')); }
      catch {
        await git(['init']);
        await git(['remote', 'add', 'origin', settings.url]);
      }
      const refs = await git(['ls-remote', '--heads', 'origin', settings.branch]);
      if (refs.trim()) {
        await git(['fetch', 'origin', settings.branch]);
        const local = await git(['rev-parse', '--verify', 'HEAD']).catch(() => '');
        if (!local) await git(['checkout', '-B', settings.branch, 'FETCH_HEAD']);
        else await git(['merge', '--ff-only', 'FETCH_HEAD']);
      } else {
        const heads = await git(['ls-remote', '--heads', 'origin']);
        if (heads.trim()) throw Error('远程分支不存在，请填写已有分支或使用空仓库');
        await git(['symbolic-ref', 'HEAD', 'refs/heads/' + settings.branch]);
      }
      const workspace = await new WorkspaceStore(path.join(this.dataDir, 'workspace.json')).read();
      if (!workspace) throw Error('工作区尚未初始化');
      // 工作区包含图片 dataUrl，可完整导入；不上传私钥或 API Key。
      const backup = { format: 'reqflow-backup-v1', workspace: workspace.data, settings: { backup: settings } };
      const destination = path.join(repo, 'reqflow-backup.json');
      try { if ((await fs.lstat(destination)).isSymbolicLink()) throw Error('备份目标不能为符号链接'); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      await fs.writeFile(destination, JSON.stringify(backup, null, 2), 'utf8');
      await git(['add', '--', 'reqflow-backup.json']);
      if ((await git(['diff', '--cached', '--name-only', '--', 'reqflow-backup.json'])).trim())
        await git(['-c', 'user.name=ReqFlow Backup', '-c', 'user.email=backup@reqflow.local', 'commit', '-m', 'backup: sync ReqFlow workspace and settings', '--', 'reqflow-backup.json']);
      // 即使上次 push 失败且本次数据未变，也重试推送。
      await git(['push', 'origin', 'HEAD:refs/heads/' + settings.branch]);
      this.status = { running: false, lastSuccess: new Date().toISOString() };
      return { ...this.status };
    } catch (e: any) { this.status = { ...this.status, running: false, error: e.message }; throw e; }
  }
}
