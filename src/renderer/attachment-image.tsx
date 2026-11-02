import { useEffect, useState } from 'react';
import { bridge } from './api';
import type { Attachment } from '../core/domain';

// 需求图片保存后外置到数据目录，工作区只保留 path；显示时按需读取并缓存。
const loaded = new Map<string, Promise<string>>();
const LIMIT = 60;

function load(path: string): Promise<string> {
  let task = loaded.get(path);
  if (!task) {
    task = (bridge.readAttachment ? bridge.readAttachment(path) : Promise.resolve<{ ok: boolean; dataUrl?: string; error?: string }>({ ok: false, error: '当前环境不支持读取图片' }))
      .then(r => { if (!r.ok || !r.dataUrl) throw Error(r.error || '图片读取失败'); return r.dataUrl; });
    task.catch(() => loaded.delete(path));
    loaded.set(path, task);
    if (loaded.size > LIMIT) loaded.delete(loaded.keys().next().value!);
  }
  return task;
}

export function AttachmentImage({ attachment, alt }: { attachment: Attachment; alt: string }) {
  const [src, setSrc] = useState(attachment.dataUrl || '');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (attachment.dataUrl) { setSrc(attachment.dataUrl); return; }
    setSrc('');
    if (!attachment.path) { setFailed(true); return; }
    let live = true;
    load(attachment.path).then(v => { if (live) setSrc(v); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [attachment.dataUrl, attachment.path]);
  if (src) return <img src={src} alt={alt} />;
  return <span className="attachment-placeholder">{failed ? '图片不可用' : '加载中…'}</span>;
}
