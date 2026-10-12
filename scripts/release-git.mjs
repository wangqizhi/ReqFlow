import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { traceStep } from './release-trace.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw Error(`git ${args[0]} 失败：${result.error?.message || result.stderr.trim()}`);
  return result.stdout.trim();
}

export function releaseRepository() {
  const remote = git(['remote', 'get-url', 'origin']);
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote);
  if (!match) throw Error('origin 必须指向 GitHub 仓库');
  return match[1];
}

export function prepareReleaseGit(version) {
  const branch = git(['branch', '--show-current']);
  if (!branch) throw Error('当前为 detached HEAD，请先切换到要发布的分支');
  const tag = `v${version}`;
  const existingTag = git(['tag', '--list', tag]);
  const changes = git(['status', '--porcelain']);
  if (existingTag && (changes || git(['rev-parse', `${tag}^{commit}`]) !== git(['rev-parse', 'HEAD']))) {
    throw Error(`${tag} 已存在但与当前发布内容不一致；不会覆盖标签`);
  }
  if (changes) {
    console.log(`提交当前工作区变更：chore: release ${tag}`);
    git(['add', '--all']);
    traceStep('提交发布版本', () => git(['commit', '-m', `chore: release ${tag}`]));
  }
  console.log(`推送分支：${branch}`);
  traceStep('推送发布分支', () => git(['push', 'origin', `HEAD:refs/heads/${branch}`]));
  if (!existingTag) git(['tag', '-a', tag, '-m', `ReqFlow ${version}`]);
  console.log(`推送标签：${tag}`);
  traceStep('推送版本标签', () => git(['push', 'origin', `refs/tags/${tag}`]));
}
