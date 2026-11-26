import { useEffect, useSyncExternalStore } from 'react';
import { bridge } from './api';

export type ShortcutActionId = 'newRequirement';
export type ShortcutSettings = Record<ShortcutActionId, string>;

export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  newRequirement: 'Ctrl+N',
};

export const SHORTCUT_DEFINITIONS: {
  id: ShortcutActionId;
  label: string;
  description: string;
  defaultKey: string;
}[] = [
  {
    id: 'newRequirement',
    label: '新建需求',
    description: '在项目工作台快速打开「记录新需求」窗口',
    defaultKey: DEFAULT_SHORTCUTS.newRequirement,
  },
];

const STORAGE_KEY = 'reqflow-shortcuts';
const CHANGE_EVENT = 'reqflow-shortcuts-changed';

const MODIFIER_ALIASES: Record<string, 'Ctrl' | 'Alt' | 'Shift' | 'Meta'> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  win: 'Meta',
  super: 'Meta',
};

const SPECIAL_KEY_MAP: Record<string, string> = {
  ' ': 'Space',
  space: 'Space',
  spacebar: 'Space',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  up: 'ArrowUp',
  arrowdown: 'ArrowDown',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  left: 'ArrowLeft',
  arrowright: 'ArrowRight',
  right: 'ArrowRight',
  plus: '+',
  minus: '-',
  comma: ',',
  period: '.',
  slash: '/',
  backslash: '\\',
  semicolon: ';',
  quote: "'",
  bracketleft: '[',
  bracketright: ']',
  backquote: '`',
  equal: '=',
};

const CODE_KEY_MAP: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph']);

function normalizeMainKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === 'escape' || lower === 'esc') return null;
  if (SPECIAL_KEY_MAP[lower]) return SPECIAL_KEY_MAP[lower];
  if (/^f([1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^[a-z]$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^[0-9]$/.test(trimmed)) return trimmed;
  if (trimmed.length === 1 && !/\s/.test(trimmed)) return trimmed;
  return null;
}

export function validateShortcut(raw: string): { valid: boolean; normalized: string; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { valid: true, normalized: '' };
  const parts = trimmed.split('+').map(p => p.trim()).filter(Boolean);
  // 兼容末尾为 "+" 的写法（如 "Ctrl++"）
  if (trimmed.endsWith('++')) parts.push('+');
  if (!parts.length) return { valid: true, normalized: '' };
  const mods = new Set<'Ctrl' | 'Alt' | 'Shift' | 'Meta'>();
  let mainKey: string | null = null;
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()];
    if (mod) {
      mods.add(mod);
      continue;
    }
    if (mainKey !== null) {
      return { valid: false, normalized: trimmed, error: '只能包含一个主键，如 Ctrl+N 或 Ctrl+Shift+N' };
    }
    const normalizedKey = normalizeMainKey(part);
    if (!normalizedKey) {
      return { valid: false, normalized: trimmed, error: `不支持的按键「${part}」` };
    }
    mainKey = normalizedKey;
  }
  if (!mainKey) {
    return { valid: false, normalized: trimmed, error: '请配合非修饰键使用，例如 Ctrl+N' };
  }
  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(mainKey);
  if (!isFunctionKey && !mods.has('Ctrl') && !mods.has('Alt') && !mods.has('Meta')) {
    return { valid: false, normalized: trimmed, error: '请配合 Ctrl / Alt 修饰键，或使用 F1–F12 功能键' };
  }
  const ordered = (['Ctrl', 'Alt', 'Shift', 'Meta'] as const).filter(m => mods.has(m));
  return { valid: true, normalized: [...ordered, mainKey].join('+') };
}

export function normalizeShortcut(raw: string): string {
  const result = validateShortcut(raw);
  return result.valid ? result.normalized : raw.trim();
}

export function eventMainKey(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  if (e.code) {
    if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
    if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
    if (/^F([1-9]|1[0-2])$/.test(e.code)) return e.code;
    if (CODE_KEY_MAP[e.code]) return CODE_KEY_MAP[e.code];
  }
  return normalizeMainKey(e.key);
}

/** 从按键事件提取标准化快捷键字符串；仅按修饰键时返回 null。 */
export function shortcutFromKeyboardEvent(e: KeyboardEvent): { shortcut: string | null; error?: string } {
  if (MODIFIER_KEYS.has(e.key)) return { shortcut: null };
  const mainKey = eventMainKey(e);
  if (!mainKey) return { shortcut: null, error: '该按键暂不支持作为快捷键' };
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(mainKey);
  const checked = validateShortcut(parts.join('+'));
  if (!checked.valid) return { shortcut: null, error: checked.error };
  return { shortcut: checked.normalized };
}

export function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
  const checked = validateShortcut(shortcut);
  if (!checked.valid || !checked.normalized) return false;
  const parts = checked.normalized.split('+');
  const expectedKey = parts[parts.length - 1];
  const expectedMods = new Set(parts.slice(0, -1));
  if (e.ctrlKey !== expectedMods.has('Ctrl')) return false;
  if (e.altKey !== expectedMods.has('Alt')) return false;
  if (e.shiftKey !== expectedMods.has('Shift')) return false;
  if (e.metaKey !== expectedMods.has('Meta')) return false;
  return eventMainKey(e) === expectedKey;
}

export function normalizeShortcutSettings(raw: unknown): ShortcutSettings {
  const next: ShortcutSettings = { ...DEFAULT_SHORTCUTS };
  if (!raw || typeof raw !== 'object') return next;
  const record = raw as Record<string, unknown>;
  for (const def of SHORTCUT_DEFINITIONS) {
    if (typeof record[def.id] === 'string') {
      const checked = validateShortcut(record[def.id] as string);
      if (checked.valid) next[def.id] = checked.normalized;
    }
  }
  return next;
}

let cachedRaw = '';
let cachedSettings: ShortcutSettings = DEFAULT_SHORTCUTS;

function readCachedShortcuts(): ShortcutSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || '';
    if (raw === cachedRaw) return cachedSettings;
    cachedRaw = raw;
    cachedSettings = raw ? normalizeShortcutSettings(JSON.parse(raw)) : DEFAULT_SHORTCUTS;
    return cachedSettings;
  } catch {
    return DEFAULT_SHORTCUTS;
  }
}

export function publishShortcutSettings(settings: ShortcutSettings) {
  const normalized = normalizeShortcutSettings(settings);
  const raw = JSON.stringify(normalized);
  cachedRaw = raw;
  cachedSettings = normalized;
  try { localStorage.setItem(STORAGE_KEY, raw); } catch { /* ignore */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribeShortcuts(listener: () => void) {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

let shortcutsLoaded = false;

export async function loadShortcutSettingsFromBridge(): Promise<ShortcutSettings> {
  if (!bridge.getShortcutSettings) return readCachedShortcuts();
  const r = await bridge.getShortcutSettings();
  if (!r.ok) throw Error(r.error || '读取快捷键设置失败');
  const resolved = r.settings ? normalizeShortcutSettings(r.settings) : readCachedShortcuts();
  publishShortcutSettings(resolved);
  return resolved;
}

export function useShortcutSettings(): ShortcutSettings {
  useEffect(() => {
    if (shortcutsLoaded || !bridge.getShortcutSettings) return;
    shortcutsLoaded = true;
    void loadShortcutSettingsFromBridge().catch(() => { shortcutsLoaded = false; });
  }, []);
  return useSyncExternalStore(subscribeShortcuts, readCachedShortcuts);
}
