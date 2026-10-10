export type RemoteSettings = {
  provider: 'github' | 'gitlab';
  url: string;
  branch: string;
  sshKeyPath: string;
};
export type BackupSettings = RemoteSettings & { autoSync: boolean };
export type BackupStatus = { running: boolean; lastSuccess?: string; error?: string };
export const emptyRemote: RemoteSettings = { provider: 'github', url: '', branch: 'main', sshKeyPath: '' };
export const emptyBackup: BackupSettings = { ...emptyRemote, autoSync: true };

export function validateRemote(value: RemoteSettings): RemoteSettings {
  if (!value || !['github', 'gitlab'].includes(value.provider)) throw Error('请选择 GitHub 或 GitLab');
  const url = String(value.url || '').trim();
  // 禁止 Git 外部 helper、本地路径与 URL 中的密码/token。支持 GitLab 自建站。
  if (url && !/^(?:https:\/\/[^\s/@?#]+\/[^\s?#]+|ssh:\/\/(?:[\w.-]+@)?[\w.-]+(?::\d+)?\/[^\s?#]+|[\w.-]+@[\w.-]+:[^\s?#]+)$/.test(url))
    throw Error('仓库地址须为 HTTPS 或 SSH 地址，不能包含密码或 Token');
  const branch = String(value.branch || 'main').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.includes('@{') || branch.endsWith('/') || branch.endsWith('.') || branch.split('/').some((x) => x.endsWith('.lock')))
    throw Error('分支名称无效');
  return { provider: value.provider, url, branch, sshKeyPath: String(value.sshKeyPath || '').trim() };
}
