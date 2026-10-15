import { useMemo, useState } from 'react';
import { localDate } from '../core/dates';

/** A rolling year of local calendar dates, arranged Sunday through Saturday. */
export function buildActivityCalendar(events: { day: string }[], today = new Date()) {
  const end = new Date(today); end.setHours(12, 0, 0, 0);
  const start = new Date(end); start.setDate(start.getDate() - 364);
  const first = new Date(start); first.setDate(first.getDate() - first.getDay());
  const last = new Date(end); last.setDate(last.getDate() + 6 - last.getDay());
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.day, (counts.get(event.day) || 0) + 1);
  const days: { day: string; value: number; visible: boolean; month: number; date: number }[] = [];
  for (const date = new Date(first); date <= last; date.setDate(date.getDate() + 1)) {
    const day = localDate(date);
    days.push({ day, value: counts.get(day) || 0, visible: date >= start && date <= end, month: date.getMonth() + 1, date: date.getDate() });
  }
  return days;
}

export function ActivityCalendar({ events }: { events: { day: string }[] }) {
  const today = localDate();
  const days = useMemo(() => buildActivityCalendar(events, new Date(today + 'T12:00:00')), [events, today]);
  const [focused, setFocused] = useState(today);
  const [selected, setSelected] = useState('');
  const activeDays = days.filter(day => day.visible);
  const max = Math.max(1, ...activeDays.map(day => day.value));
  const total = activeDays.reduce((sum, day) => sum + day.value, 0);
  const selectedDay = activeDays.find(day => day.day === selected);
  const level = (value: number) => value === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(value / max * 4)));
  return <div className="activity-calendar">
    <div className="activity-calendar-header"><h4>需求创建日历</h4><span>过去一年 · {total} 条新建需求</span></div>
    <div className="activity-calendar-scroll">
      <div className="activity-calendar-grid" style={{ gridTemplateColumns: `24px repeat(${days.length / 7}, 12px)` }}>
        {days.map((day, index) => day.visible && (day.date === 1 || index === days.findIndex(entry => entry.visible)) && <span className="activity-month" key={'month-' + day.day} style={{ gridColumn: Math.floor(index / 7) + 2, gridRow: 1 }}>{day.month}月</span>)}
        {['日', '一', '二', '三', '四', '五', '六'].map((day, index) => <span key={day} className="activity-weekday" style={{ gridColumn: 1, gridRow: index + 2 }}>{index % 2 ? day : ''}</span>)}
        {days.map((day, index) => day.visible ? <button type="button" key={day.day} data-date={day.day}
          className={'activity-day level-' + level(day.value) + (selected === day.day ? ' selected' : '')}
          style={{ gridColumn: Math.floor(index / 7) + 2, gridRow: index % 7 + 2 }}
          title={`${day.day}：新建 ${day.value} 条需求`} aria-label={`${day.day}，新建 ${day.value} 条需求`} aria-pressed={selected === day.day}
          tabIndex={focused === day.day ? 0 : -1} onFocus={() => setFocused(day.day)} onClick={() => setSelected(day.day)}
          onKeyDown={event => {
            const offset = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
            const next = event.key === 'Home' ? activeDays[0] : event.key === 'End' ? activeDays[activeDays.length - 1] : offset === undefined ? undefined : days[index + offset];
            if (next?.visible) { event.preventDefault(); setFocused(next.day); event.currentTarget.closest('.activity-calendar-grid')?.querySelector<HTMLButtonElement>(`[data-date="${next.day}"]`)?.focus(); }
          }} /> : <span key={day.day} style={{ gridColumn: Math.floor(index / 7) + 2, gridRow: index % 7 + 2 }} />)}
      </div>
    </div>
    <div className="activity-calendar-footer"><span aria-live="polite">{selectedDay ? `${selectedDay.day} · 新建 ${selectedDay.value} 条需求` : '颜色越深，当天新建需求越多'}</span><div className="activity-legend" aria-label="从少到多的活动强度">少{[0, 1, 2, 3, 4].map(value => <span key={value} className={'activity-day level-' + value} aria-hidden="true" />)}多</div></div>
  </div>;
}
