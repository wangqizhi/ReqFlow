export function localDate(date = new Date()): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function validateDate(value: unknown): string | undefined {
  if (value === '' || value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('需求日期须为 YYYY-MM-DD');
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(0); date.setFullYear(y, m - 1, d); date.setHours(0, 0, 0, 0);
  if (y < 1 || localDate(date) !== value) throw Error('需求日期无效');
  return value;
}
export function matchesSchedule(date: string | undefined, mode: string, selected: string): boolean {
  if (mode === 'all') return true;
  if (mode === 'exact') return date === selected;
  // Older undated requirements remain visible rather than disappearing during migration.
  return !date || date <= selected;
}
