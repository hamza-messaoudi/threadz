import type { Schedule } from '../config/types.ts';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parse(schedule: Schedule): { day: number | null; h: number; m: number } {
  if ('daily' in schedule) {
    const [h, m] = schedule.daily.split(':').map(Number);
    return { day: null, h, m };
  }
  const [d, t] = schedule.weekly.split(' ');
  const [h, m] = t.split(':').map(Number);
  return { day: DAYS.indexOf(d.toLowerCase()), h, m };
}

/** Local date `offsetDays` from `now`'s date, at h:m. Date first, then hours, so DST shifts stay correct. */
function at(now: number, offsetDays: number, h: number, m: number): Date {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0); // midday avoids DST edge cases while stepping days
  d.setDate(d.getDate() + offsetDays);
  d.setHours(h, m, 0, 0);
  return d;
}

/** The most recent scheduled time at or before `now` (system local time zone). */
export function lastSlot(schedule: Schedule, now: number): number {
  const { day, h, m } = parse(schedule);
  if (day === null) {
    const today = at(now, 0, h, m);
    return today.getTime() <= now ? today.getTime() : at(now, -1, h, m).getTime();
  }
  const back = (new Date(now).getDay() - day + 7) % 7;
  let d = at(now, -back, h, m);
  let offset = -back;
  while (d.getTime() > now) {
    offset -= 7;
    d = at(now, offset, h, m);
  }
  return d.getTime();
}

/** The first scheduled time strictly after `now`. */
export function nextSlot(schedule: Schedule, now: number): number {
  const { day, h, m } = parse(schedule);
  for (let i = 0; i <= 8; i++) {
    const d = at(now, i, h, m);
    if (d.getTime() > now && (day === null || d.getDay() === day)) return d.getTime();
  }
  throw new Error('unreachable');
}

export function isDue(state: { last_success_slot: number | null } | undefined, schedule: Schedule, now: number): boolean {
  const slot = lastSlot(schedule, now);
  return !state || state.last_success_slot === null || state.last_success_slot < slot;
}
