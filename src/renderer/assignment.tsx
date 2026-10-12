import { useEffect, useState } from 'react';
import { bridge } from './api';
import { X } from './icons';
export function AssignmentOverlay({ onClose, configure, assign }: { onClose(): void; configure(): void; assign(executor: string): Promise<void> }) {
  const [enabled, setEnabled] = useState<string[] | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; bridge.getLocalAgents?.().then(r => { if (!active) return; if (!r.ok) setError(r.error || '读取配置失败'); else setEnabled(r.enabled || []); }).catch(e => active && setError(e.message)); if (!bridge.getLocalAgents) setEnabled([]); return () => { active = false; }; }, []);
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [busy, onClose]);
  return <div className="overlay" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}><section className="dialog" role="dialog" aria-modal="true" aria-label="指派需求"><div className="dialog-head"><h3>指派需求</h3><button className="icon-btn" aria-label="关闭指派" disabled={busy} onClick={onClose}><X /></button></div><p className="settings-hint">保存需求的执行器；本阶段不启动 Agent，也不提交执行任务。</p>{error && <p role="alert">{error}</p>}<div className="settings-actions">{enabled?.map(id => <button className="btn" key={id} disabled={busy} onClick={async () => { setBusy(true); try { await assign('agent:' + id); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>{id === 'opencode' ? 'OpenCode' : 'pi'}</button>)}<button className="btn" disabled={busy} onClick={configure}>+配置Agent/插件/MOD</button></div></section></div>;
}
