import { versionComponents, type Item } from '../core/domain';

export function VerificationVersions({ item }: { item: Pick<Item, 'verificationVersion' | 'verificationComponents'> }) {
  const components = Object.entries(versionComponents(item.verificationComponents)).sort(([a], [b]) => a.localeCompare(b));
  return <div className="verification-version">
    {item.verificationVersion
      ? <p>在版本：{item.verificationVersion} 及以上验证</p>
      : !components.length && <p>在版本：项目版本未提供</p>}
    {components.length > 0 && <><p>组件版本（及以上验证）</p><div className="verification-components">
      {components.map(([name, version]) => <span key={name}>{name}：<strong>{version}</strong></span>)}
    </div></>}
  </div>;
}
