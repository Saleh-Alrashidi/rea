/**
 * Display formatting for dates and times. Dates from the API are either ISO
 * timestamps (`created_at`) or calendar dates ("YYYY-MM-DD", date columns),
 * which are local days and must not be shifted through UTC.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Today's local calendar date as "YYYY-MM-DD". */
export function todayString(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Adds `days` to a "YYYY-MM-DD" date (local calendar arithmetic). */
export function addDays(dateString, days) {
  const match = DATE_PATTERN.exec(dateString);
  if (!match) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  date.setDate(date.getDate() + days);
  return todayString(date);
}

/** "Oct 18" (or "Oct 18, 2027" outside the current year) for "YYYY-MM-DD". */
export function formatDay(dateString, now = new Date()) {
  const match = DATE_PATTERN.exec(dateString ?? "");
  if (!match) return "";
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

/** "just now", "5m ago", "3h ago", "2d ago", or a date for older times. */
export function timeAgo(iso, now = Date.now()) {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "";
  const elapsed = Math.max(0, now - time);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  return new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** "Good morning" / "Good afternoon" / "Good evening". */
export function greeting(now = new Date()) {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** "3 boards" / "1 board". */
export function plural(count, noun, pluralNoun = `${noun}s`) {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}
