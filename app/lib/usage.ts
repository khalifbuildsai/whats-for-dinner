export const FREE_DAILY_LIMIT = 3;

const STORAGE_KEY = "fridge-scan-usage";

type UsageRecord = { date: string; count: number };

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function read(): UsageRecord {
  if (typeof window === "undefined") return { date: todayKey(), count: 0 };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { date: todayKey(), count: 0 };
    const parsed = JSON.parse(raw) as UsageRecord;
    if (parsed.date !== todayKey()) return { date: todayKey(), count: 0 };
    return parsed;
  } catch {
    return { date: todayKey(), count: 0 };
  }
}

function write(record: UsageRecord) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
}

export function getTodayCount(): number {
  return read().count;
}

export function incrementToday(): number {
  const current = read();
  const next = { date: todayKey(), count: current.count + 1 };
  write(next);
  return next.count;
}

export function isAtLimit(isPaid: boolean): boolean {
  if (isPaid) return false;
  return getTodayCount() >= FREE_DAILY_LIMIT;
}

export function remainingToday(isPaid: boolean): number {
  if (isPaid) return Infinity;
  return Math.max(0, FREE_DAILY_LIMIT - getTodayCount());
}
