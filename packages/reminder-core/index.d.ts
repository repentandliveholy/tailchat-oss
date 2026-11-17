export type ReminderLocale = 'ru' | 'en' | 'fr';

export interface ParseReminderOptions {
  timezone?: string;
  now?: number;
  locale?: ReminderLocale;
  /** Час (0–23) для дат без указанного времени. Без параметра час определяет chrono (12:00 или текущее время). */
  defaultHour?: number;
}

export interface ParsedReminder {
  text: string;
  dueAt: number;
  matched: string;
}

export interface ReminderAction {
  id: string;
  label: string;
  value: string;
}

export interface ReminderRecord {
  id: string;
  ownerId: string;
  text: string;
  dueAt: number;
  status: 'scheduled';
  createdAt: number;
  [key: string]: unknown;
}

export function parseReminder(input: string, options?: ParseReminderOptions): ParsedReminder | null;
export function presetDue(code: string, options?: Omit<ParseReminderOptions, 'locale'>): number | null;
export function formatWhen(timestamp: number, options?: ParseReminderOptions): {
  day: 'today' | 'tomorrow' | 'other';
  label: string;
  time: string;
  relative: string;
} | null;
export function createReminder(input: {
  id: string;
  ownerId: string;
  text: string;
  dueAt: number;
  now?: number;
  [key: string]: unknown;
}): ReminderRecord;
export function normalizeActions(actions: unknown): ReminderAction[];
export function getReminderActions(locale?: ReminderLocale): {
  idle: readonly ReminderAction[];
  fired: readonly ReminderAction[];
};
export const REMINDER_ACTIONS: Readonly<{
  idle: readonly ReminderAction[];
  fired: readonly ReminderAction[];
}>;
