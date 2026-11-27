// REQ-338/339/343：通用偏好（配色、默认项目目录）。
// 持久化在数据目录 preferences.json，同时缓存到 localStorage，启动时在首屏渲染前应用配色避免闪烁。
import { useEffect, useSyncExternalStore } from 'react';
import { bridge } from './api';

export type ThemeId = 'classic' | 'cream' | 'dark';
export type Preferences = { theme: ThemeId; defaultProjectDir: string };

export const THEMES: { id: ThemeId; label: string; description: string }[] = [
  { id: 'classic', label: '经典', description: '默认的暖白底与橙色主操作' },
  { id: 'cream', label: '奶油', description: '米黄纸面底色，长时间阅读更柔和' },
  { id: 'dark', label: '暗色', description: '参考 VS Code Dark 的深灰配色' },
];

export const DEFAULT_PREFERENCES: Preferences = { theme: 'classic', defaultProjectDir: '' };

const STORAGE_KEY = 'reqflow-preferences';
const CHANGE_EVENT = 'reqflow-preferences-changed';

export function normalizePreferences(raw: unknown): Preferences {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const theme = THEMES.some(t => t.id === record.theme) ? record.theme as ThemeId : DEFAULT_PREFERENCES.theme;
  const defaultProjectDir = typeof record.defaultProjectDir === 'string' ? record.defaultProjectDir.trim() : '';
  return { theme, defaultProjectDir };
}

let cachedRaw: string | null = null;
let cached: Preferences = DEFAULT_PREFERENCES;

function readCached(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || '';
    if (raw === cachedRaw) return cached;
    cachedRaw = raw;
    cached = raw ? normalizePreferences(JSON.parse(raw)) : DEFAULT_PREFERENCES;
  } catch {
    cached = DEFAULT_PREFERENCES;
  }
  return cached;
}

export function applyTheme(theme: ThemeId) {
  const root = document.documentElement;
  if (theme === 'classic') delete root.dataset.theme;
  else root.dataset.theme = theme;
  root.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
}

/** 首屏渲染前调用：按本地缓存恢复配色。 */
export function applyCachedTheme() {
  applyTheme(readCached().theme);
}

export function publishPreferences(next: Preferences) {
  const normalized = normalizePreferences(next);
  const raw = JSON.stringify(normalized);
  cachedRaw = raw;
  cached = normalized;
  try { localStorage.setItem(STORAGE_KEY, raw); } catch { /* ignore */ }
  applyTheme(normalized.theme);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(listener: () => void) {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

export async function loadPreferencesFromBridge(): Promise<Preferences> {
  if (!bridge.getPreferences) return readCached();
  const r = await bridge.getPreferences();
  if (!r.ok) throw Error(r.error || '读取偏好设置失败');
  const resolved = r.settings ? normalizePreferences(r.settings) : readCached();
  publishPreferences(resolved);
  return resolved;
}

export async function savePreferences(next: Preferences) {
  const normalized = normalizePreferences(next);
  const r = bridge.savePreferences ? await bridge.savePreferences(normalized) : { ok: true };
  if (r.ok) publishPreferences(normalized);
  return r;
}

let loaded = false;
export function usePreferences(): Preferences {
  useEffect(() => {
    if (loaded || !bridge.getPreferences) return;
    loaded = true;
    void loadPreferencesFromBridge().catch(() => { loaded = false; });
  }, []);
  return useSyncExternalStore(subscribe, readCached);
}

/** 按默认项目目录与项目名称拼出项目目录；未配置默认目录或名称为空时返回空。 */
export function defaultProjectPath(base: string, name: string): string {
  const root = base.trim().replace(/[\\/]+$/, '');
  const leaf = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '');
  if (!root || !leaf) return '';
  const sep = root.includes('\\') || /^[A-Za-z]:/.test(root) ? '\\' : '/';
  return root + sep + leaf;
}
