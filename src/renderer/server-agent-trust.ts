import type { ReqFlowBridge, ServerAgentDraft } from './api';

type TrustBridge = Pick<ReqFlowBridge, 'saveServerAgent' | 'trustServerAgent'>;

// A tested draft has no persisted ID yet. Save that exact snapshot before trust,
// and retain the returned ID even if the subsequent certificate check fails.
export async function trustServerAgentDraft(
  api: TrustBridge,
  id: string | undefined,
  draft: ServerAgentDraft | undefined,
  fingerprint: string | undefined,
  onSaved: (id: string) => void,
): Promise<string> {
  if (!fingerprint) throw Error('缺少待确认的证书指纹，请重新测试连接');
  if (draft) {
    const saved = await api.saveServerAgent?.({ ...draft, id });
    if (!saved?.ok || !saved.id) throw Error(saved?.error || '保存服务端配置失败');
    id = saved.id;
    onSaved(id);
  }
  if (!id) throw Error('请先保存服务端配置');
  const trusted = await api.trustServerAgent?.(id, fingerprint);
  if (!trusted?.ok) throw Error(trusted?.error || '确认信任失败');
  return id;
}
