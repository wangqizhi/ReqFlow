import { promises as fs } from 'node:fs';
import path from 'node:path';
import { emptyRemote, type RemoteSettings } from '../core/remote';
import { runRemoteGit } from './remote';

const running = new Set<string>();
async function locked<T>(root: string, operation: (dir: string) => Promise<T>) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw Error('请提供本地项目目录的绝对路径');
  const dir = await fs.realpath(root);
  const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
  if (running.has(key)) throw Error('此目录正在拉取，请稍后再试');
  running.add(key);
  try { return await operation(dir); } finally { running.delete(key); }
}
async function repositoryRoot(dir: string, settings: RemoteSettings) {
  const top = (await runRemoteGit(['rev-parse', '--show-toplevel'], dir, settings)).trim();
  const real = await fs.realpath(top);
  if ((process.platform === 'win32' ? real.toLowerCase() : real) !== (process.platform === 'win32' ? dir.toLowerCase() : dir)) {
    throw Error('所选目录不是 Git 仓库根目录；不会操作其父目录的仓库');
  }
}
async function clean(dir: string, settings: RemoteSettings) {
  const changes = await runRemoteGit(['status', '--porcelain=v1', '--untracked-files=all'], dir, settings);
  if (changes.trim()) throw Error('本地有未提交或未跟踪文件，请先提交或自行处理后再 Pull；不会自动 stash 或覆盖');
}

export async function pullProject(root: string, settings: RemoteSettings = emptyRemote) {
  return locked(root, async dir => {
    await repositoryRoot(dir, settings);
    await clean(dir, settings);
    // Respect the current branch's upstream, and never create merge commits or rewrite history.
    return (await runRemoteGit(['pull', '--ff-only', '--no-rebase'], dir, settings)).trim() || 'Pull 完成';
  });
}

export async function checkoutNewProject(root: string, settings: RemoteSettings) {
  return locked(root, async dir => {
    const entries = await fs.readdir(dir);
    if (!entries.length) {
      // git clone itself refuses non-empty targets; no destructive cleanup on failure.
      await runRemoteGit(['clone', '--single-branch', '--branch', settings.branch, '--', settings.url, dir], path.dirname(dir), settings);
      return '项目已创建，远程仓库文件已拉取';
    }
    await repositoryRoot(dir, settings).catch(() => { throw Error('目录非空且不是独立 Git 仓库，请选择空目录；不会覆盖已有文件'); });
    await clean(dir, settings);
    const origin = (await runRemoteGit(['config', '--get', 'remote.origin.url'], dir, settings)).trim();
    if (origin !== settings.url) throw Error('现有仓库 origin 与填写地址不一致，请核对后手动拉取；不会改写 origin');
    const branch = (await runRemoteGit(['symbolic-ref', '--short', 'HEAD'], dir, settings)).trim();
    if (branch !== settings.branch) throw Error('当前分支与项目配置分支不一致，请自行切换后拉取');
    await runRemoteGit(['pull', '--ff-only', '--no-rebase', 'origin', settings.branch], dir, settings);
    return '项目已创建，现有仓库已快进拉取';
  });
}
