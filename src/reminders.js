import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDeviceStore } from './secure-store.js';

// Maximum setTimeout delay in 32-bit signed int milliseconds (~24.8 days)
const MAX_TIMEOUT_MS = 2_147_483_647;

export function newReminderId() {
  return `rem_${crypto.randomBytes(3).toString('hex')}`;
}

export function formatReminderRemaining(ms) {
  const totalSeconds = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

export function formatClockTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Parses user input for time and text.
 * Examples:
 *   "10s check logs" -> delay: 10000, text: "check logs"
 *   "5m check oven" -> delay: 300000, text: "check oven"
 *   "1h30m call Bob" -> delay: 5400000, text: "call Bob"
 *   "через 15 минут проверить сервер" -> delay: 900000, text: "проверить сервер"
 *   "18:30 dinner" -> dueTs: today/tomorrow at 18:30, text: "dinner"
 *   "tomorrow 10:00 meeting" -> dueTs: tomorrow at 10:00, text: "meeting"
 *   "завтра в 14:00 созвон" -> dueTs: tomorrow at 14:00, text: "созвон"
 */
export function parseReminderTime(rawInput, now = Date.now()) {
  const input = String(rawInput ?? '').trim();
  if (input === '') return null;

  // 1. Natural relative Russian / English prefixes:
  // "через 10 минут ...", "через 1 час 30 минут ...", "in 15 minutes ...", "in 2 hours ..."
  const naturalPrefix = /^(?:через|in)\s+/i;
  let working = input;
  if (naturalPrefix.test(working)) {
    working = working.replace(naturalPrefix, '').trim();
  }

  // 2. Relative time units: (1d 2h 30m 15s) or (1 день 2 часа 30 минут 15 сек)
  // Let's parse tokens at the beginning of `working`
  let remainingText = working;
  let totalMs = 0;
  let matchedAnyRelative = false;

  const unitRegex = /^(\d+(?:\.\d+)?)\s*(days?|d|дней|дня|день|д|hours?|hrs?|h|часов|часа|час|ч|minutes?|mins?|m|минут|минуты|минута|мин|м|seconds?|secs?|s|секунд|секунды|секунда|сек|с)(?:\s+и\s+|\s+and\s+|\s+|,|$)/i;

  while (remainingText.length > 0) {
    const m = remainingText.match(unitRegex);
    if (!m) break;
    matchedAnyRelative = true;
    const num = parseFloat(m[1]);
    const unit = m[2].toLowerCase();

    if (/^(days?|d|дней|дня|день|д)$/.test(unit)) {
      totalMs += num * 24 * 60 * 60 * 1000;
    } else if (/^(hours?|hrs?|h|часов|часа|час|ч)$/.test(unit)) {
      totalMs += num * 60 * 60 * 1000;
    } else if (/^(minutes?|mins?|m|минут|минуты|минута|мин|м)$/.test(unit)) {
      totalMs += num * 60 * 1000;
    } else if (/^(seconds?|secs?|s|секунд|секунды|секунда|сек|с)$/.test(unit)) {
      totalMs += num * 1000;
    }
    remainingText = remainingText.slice(m[0].length).trim();
  }

  // Also check compact relative like "1h30m", "5m", "10s", "2d4h" without spaces
  if (!matchedAnyRelative) {
    const compactMatch = remainingText.match(/^((?:\d+(?:\.\d+)?[dhms])+)(?:\s+(.*))?$/i);
    if (compactMatch) {
      const spec = compactMatch[1];
      const rest = compactMatch[2] ?? '';
      let specMs = 0;
      let valid = false;
      const subUnits = [...spec.matchAll(/(\d+(?:\.\d+)?)([dhms])/gi)];
      if (subUnits.length > 0) {
        for (const [, nStr, u] of subUnits) {
          const n = parseFloat(nStr);
          const uLower = u.toLowerCase();
          if (uLower === 'd') specMs += n * 24 * 60 * 60 * 1000;
          else if (uLower === 'h') specMs += n * 60 * 60 * 1000;
          else if (uLower === 'm') specMs += n * 60 * 1000;
          else if (uLower === 's') specMs += n * 1000;
        }
        valid = specMs > 0;
      }
      if (valid) {
        matchedAnyRelative = true;
        totalMs = specMs;
        remainingText = rest.trim();
      }
    }
  }

  if (matchedAnyRelative && totalMs > 0) {
    const dueTs = now + totalMs;
    return {
      dueTs,
      delayMs: totalMs,
      text: remainingText.trim() || 'Reminder',
      timeLabel: formatReminderRemaining(totalMs),
    };
  }

  // 3. Absolute time:
  // "tomorrow 15:30", "завтра в 15:30", "18:00", "9:45"
  const tomorrowMatch = working.match(/^(?:tomorrow|завтра)(?:\s+в|\s+at)?\s+(\d{1,2}):(\d{2})(?:\s+(.*))?$/i);
  if (tomorrowMatch) {
    const hh = parseInt(tomorrowMatch[1], 10);
    const mm = parseInt(tomorrowMatch[2], 10);
    const rest = tomorrowMatch[3] ?? '';
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(hh, mm, 0, 0);
      const dueTs = d.getTime();
      return {
        dueTs,
        delayMs: Math.max(0, dueTs - now),
        text: rest.trim() || 'Reminder',
        timeLabel: `${formatClockTime(dueTs)} (tomorrow)`,
      };
    }
  }

  const clockMatch = working.match(/^(\d{1,2}):(\d{2})(?:\s+(.*))?$/);
  if (clockMatch) {
    const hh = parseInt(clockMatch[1], 10);
    const mm = parseInt(clockMatch[2], 10);
    const rest = clockMatch[3] ?? '';
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      const d = new Date(now);
      d.setHours(hh, mm, 0, 0);
      if (d.getTime() <= now) {
        // If time already passed today, schedule for tomorrow
        d.setDate(d.getDate() + 1);
      }
      const dueTs = d.getTime();
      return {
        dueTs,
        delayMs: Math.max(0, dueTs - now),
        text: rest.trim() || 'Reminder',
        timeLabel: formatClockTime(dueTs),
      };
    }
  }

  return null;
}

export function createReminderEngine({
  stateDir,
  onTrigger,
  now = () => Date.now(),
  store = stateDir ? openDeviceStore() : null,
} = {}) {
  const filePath = stateDir ? path.join(stateDir, 'reminders.json') : null;
  const activeTimers = new Map(); // id -> timer handle
  let reminders = [];

  function load() {
    if (!filePath) return;
    let raw;
    try { raw = store.read(filePath); }
    catch (error) {
      if (error.code === 'ENOENT' && !fs.existsSync(filePath)) return;
      throw error;
    }
    let parsed;
    try { parsed = JSON.parse(raw.toString('utf8')); }
    catch { throw new Error(`Corrupted encrypted reminders: ${filePath}`); }
    if (!Array.isArray(parsed) || parsed.some((r) => !r || typeof r.id !== 'string'
      || typeof r.text !== 'string' || !Number.isFinite(r.dueTs))) {
      throw new Error(`Invalid encrypted reminders: ${filePath}`);
    }
    reminders = parsed;
  }

  function save() {
    if (!filePath) return;
    store.write(filePath, Buffer.from(JSON.stringify(reminders)));
  }

  function schedule(reminder) {
    if (activeTimers.has(reminder.id)) {
      clearTimeout(activeTimers.get(reminder.id));
      activeTimers.delete(reminder.id);
    }
    const currentNow = now();
    const delay = Math.max(0, reminder.dueTs - currentNow);

    if (delay <= 0) {
      // Due immediately
      trigger(reminder.id);
      return;
    }

    if (delay > MAX_TIMEOUT_MS) {
      // Re-arm when max timeout passes
      const timer = setTimeout(() => {
        schedule(reminder);
      }, MAX_TIMEOUT_MS);
      activeTimers.set(reminder.id, timer);
      return;
    }

    const timer = setTimeout(() => {
      trigger(reminder.id);
    }, delay);
    activeTimers.set(reminder.id, timer);
  }

  function trigger(id) {
    const idx = reminders.findIndex((r) => r.id === id);
    if (idx === -1) return;
    const reminder = reminders[idx];
    reminders.splice(idx, 1);
    activeTimers.delete(id);
    save();

    if (typeof onTrigger === 'function') {
      try {
        onTrigger(reminder);
      } catch {}
    }
  }

  // Initialize
  load();
  for (const r of reminders) {
    schedule(r);
  }

  return {
    add({ text, dueTs, targetUser = null }) {
      const id = newReminderId();
      const currentNow = now();
      const reminder = {
        id,
        text: String(text ?? '').trim() || 'Reminder',
        targetUser: targetUser ? String(targetUser) : null,
        dueTs: Number(dueTs),
        createdTs: currentNow,
      };
      reminders.push(reminder);
      save();
      schedule(reminder);
      return reminder;
    },

    list({ targetUser = null } = {}) {
      const currentNow = now();
      const filtered = targetUser
        ? reminders.filter((r) => !r.targetUser || r.targetUser === targetUser)
        : [...reminders];
      return filtered
        .map((r) => ({
          ...r,
          remainingMs: Math.max(0, r.dueTs - currentNow),
          remainingLabel: formatReminderRemaining(Math.max(0, r.dueTs - currentNow)),
          dueClock: formatClockTime(r.dueTs),
        }))
        .sort((a, b) => a.dueTs - b.dueTs);
    },

    cancel(id) {
      const idx = reminders.findIndex((r) => r.id === id);
      if (idx === -1) return false;
      if (activeTimers.has(id)) {
        clearTimeout(activeTimers.get(id));
        activeTimers.delete(id);
      }
      reminders.splice(idx, 1);
      save();
      return true;
    },

    clear({ targetUser = null } = {}) {
      let count = 0;
      if (!targetUser) {
        count = reminders.length;
        for (const timer of activeTimers.values()) clearTimeout(timer);
        activeTimers.clear();
        reminders = [];
      } else {
        const remaining = [];
        for (const r of reminders) {
          if (r.targetUser === targetUser) {
            count++;
            if (activeTimers.has(r.id)) {
              clearTimeout(activeTimers.get(r.id));
              activeTimers.delete(r.id);
            }
          } else {
            remaining.push(r);
          }
        }
        reminders = remaining;
      }
      save();
      return count;
    },

    destroy() {
      for (const timer of activeTimers.values()) {
        clearTimeout(timer);
      }
      activeTimers.clear();
    },
  };
}
