import type { Project } from '../core/domain';
import { pendingCommitItems } from '../core/domain';
import type { ReqFlowBridge } from './api';

export async function publishProject(project: Project, script: string, api: Pick<ReqFlowBridge, 'gitStatus' | 'gitStage' | 'optimizeCommitMessage' | 'gitCommit' | 'gitPush' | 'runPublish'>, progress: (text: string) => void, terminalRunId?: string) {
  if (!project.dir || !api.runPublish) throw Error('发布仅桌面版支持，请先关联项目目录');
  const root = project.dir;
  progress('检查 Git 状态');
  const status = await api.gitStatus?.(root);
  if (!status?.ok) throw Error(status && !status.ok ? status.error : '无法检查 Git 状态');
  if (project.remote?.url && !status.repo) throw Error('项目配置了远程仓库，但本地目录不是 Git 仓库');
  if (status.repo && status.changes.length) {
    progress('Add 暂存变动');
    const stage = await api.gitStage?.(root, 'stage', []);
    if (!stage?.ok) throw Error(stage && !stage.ok ? stage.error : 'Add 失败');
    progress('AI 优化提交文案');
    const message = await api.optimizeCommitMessage?.(project.id, '发布项目：' + project.name);
    if (!message?.ok || !message.message?.trim()) throw Error(message?.error || 'AI 提交文案生成失败，请检查 AI 设置');
    progress('Commit 提交变动');
    const commit = await api.gitCommit?.(root, message.message, project.id, pendingCommitItems(project).map(i => ({ id: i.id, version: i.version })));
    if (!commit?.ok) throw Error(commit && !commit.ok ? commit.error : 'Commit 失败');
    if (commit.warning) throw Error(commit.warning);
  }
  if (project.remote?.url) {
    progress('Push 推送到远程仓库');
    const push = await api.gitPush?.(root);
    if (!push?.ok) throw Error(push && !push.ok ? push.error : 'Push 失败');
  }
  progress('运行部署发布脚本');
  return api.runPublish(root, script, terminalRunId);
}
