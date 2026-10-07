import type {
  AppData,
  NotificationCenterConfig,
  ReminderKind,
  ReminderRule,
} from "../types";
import { computeFinance, getCardSummary } from "./finance";
import { verificationDays } from "./practical";
import { daysBetween, dateOnDay, monthKey } from "./dates";
export const reminderLabels: Record<ReminderKind, string> = {
  daily: "今日のPace",
  evening: "夜の記録確認",
  balance: "残高確認",
  payday: "給料の入金確認",
  card: "カード支払確認",
  recurring: "固定費・サブスク",
  budget: "今期の支出ペース",
  low: "使える金額の確認",
  backup: "バックアップ",
};
export const reminderGroups: { name: string; kinds: ReminderKind[] }[] = [
  { name: "毎日の通知", kinds: ["daily", "evening"] },
  { name: "お金関連", kinds: ["payday", "card", "budget", "low"] },
  { name: "残高", kinds: ["balance"] },
  { name: "固定費", kinds: ["recurring"] },
  { name: "セキュリティ", kinds: ["backup"] },
];
const rule = (
  time: string,
  frequency: ReminderRule["frequency"] = "daily",
): ReminderRule => ({
  enabled: false,
  time,
  days: [0, 1, 2, 3, 4, 5, 6],
  frequency,
  monthDay: 10,
  snoozeMinutes: 60,
  showAmount: false,
  badge: true,
});
export function notificationConfig(data: AppData): NotificationCenterConfig {
  if (data.settings.notificationCenter) return data.settings.notificationCenter;
  return {
    quietEnabled: true,
    quietStart: "23:00",
    quietEnd: "07:00",
    rules: {
      daily: {
        ...rule("08:00"),
        enabled: data.settings.reminder?.enabled ?? false,
        time: data.settings.reminder?.time ?? "08:00",
      },
      evening: rule("20:00"),
      balance: rule("18:00", "weekly"),
      payday: rule("10:00", "monthly"),
      card: rule("10:00", "monthly"),
      recurring: rule("09:00"),
      budget: rule("18:00", "weekly"),
      low: rule("18:00"),
      backup: rule("18:00", "weekly"),
    },
  };
}
export function isQuiet(clock: string, c: NotificationCenterConfig): boolean {
  if (!c.quietEnabled || c.quietStart === c.quietEnd) return false;
  return c.quietStart < c.quietEnd
    ? clock >= c.quietStart && clock < c.quietEnd
    : clock >= c.quietStart || clock < c.quietEnd;
}
export function applyNotificationIntensity(
  config: NotificationCenterConfig,
  intensity: NonNullable<NotificationCenterConfig["intensity"]>,
): NotificationCenterConfig {
  const rules = { ...config.rules };
  for (const kind of Object.keys(rules) as ReminderKind[]) {
    const r = rules[kind];
    if (r.explicitlyConfigured) continue;
    const standard =
      kind === "balance" || kind === "budget" || kind === "backup"
        ? "weekly"
        : kind === "payday" || kind === "card"
          ? "monthly"
          : "daily";
    rules[kind] = {
      ...r,
      frequency:
        intensity === "active" && ["balance", "budget", "backup"].includes(kind)
          ? "daily"
          : standard,
    };
  }
  return { ...config, intensity, rules };
}
export interface DueReminder {
  kind: ReminderKind;
  key: string;
  title: string;
  message: string;
  badge: boolean;
}
export function dueReminders(
  data: AppData,
  today: string,
  clock: string,
  now = Date.now(),
): DueReminder[] {
  const c = notificationConfig(data);
  if (isQuiet(clock, c)) return [];
  const f = computeFinance(data, today),
    weekday = new Date(`${today}T12:00:00+09:00`).getUTCDay();
  const conditions: Record<ReminderKind, boolean> = {
    daily: true,
    evening: !data.dailyCheckIns.some(
      (x) => x.date === today && x.noSpendingConfirmed,
    ),
    balance: f.accountBalances.some(
      (b) =>
        b.account.isActive &&
        !b.account.archivedAt &&
        verificationDays(b.account) !== 0 &&
        (b.isStale || b.balance === null),
    ),
    payday:
      !!data.settings.salarySchedule &&
      today === dateOnDay(monthKey(today), data.settings.salarySchedule.payday),
    card: data.cards.some(
      (card) =>
        getCardSummary(data, card, today).nextPaymentDate === today &&
        getCardSummary(data, card, today).outstanding > 0,
    ),
    recurring: f.recurringDue.some((r) => r.dueDate <= today),
    budget: f.pace.ratio !== null && f.pace.ratio > 1.1,
    low:
      f.safeToSpend !== null &&
      f.safeToSpend <= Math.max(1000, (f.dailyAllowance ?? 0) * 2),
    backup:
      !data.settings.lastBackupAt ||
      daysBetween(data.settings.lastBackupAt.slice(0, 10), today) >= 30,
  };
  return (Object.keys(c.rules) as ReminderKind[]).flatMap((kind) => {
    const r = c.rules[kind],
      key = `${kind}:${today}`;
    if (
      !r.explicitlyConfigured &&
      c.intensity === "quiet" &&
      ["daily", "evening", "budget"].includes(kind)
    )
      return [];
    if (!r.enabled || !conditions[kind] || r.lastAcknowledged === key)
      return [];
    const snoozing = r.snoozedUntil ? Date.parse(r.snoozedUntil) : 0;
    if (snoozing > now) return [];
    if (!r.days.includes(weekday) || clock < r.time) return [];
    if (
      r.frequency === "weekly" &&
      weekday !== [...r.days].sort((a, b) => a - b)[0]
    )
      return [];
    // Payday/card use their configured actual schedules, not an assumed fixed tenth.
    if (
      r.frequency === "monthly" &&
      kind !== "payday" &&
      kind !== "card" &&
      today !== dateOnDay(monthKey(today), r.monthDay)
    )
      return [];
    const amount =
      kind === "low" || kind === "daily"
        ? f.safeToSpend
        : kind === "budget"
          ? f.periodExpenseTotal
          : null;
    const generic =
      kind === "evening"
        ? "今日の記録を確認してください"
        : "Paceを確認してください";
    return [
      {
        kind,
        key,
        title: reminderLabels[kind],
        message:
          r.showAmount && amount !== null
            ? `${generic} · ¥${amount.toLocaleString("ja-JP")}`
            : generic,
        badge: r.badge,
      },
    ];
  });
}
/** All OS notifications stay generic, regardless of the in-app amount preference. */
export function privateNotificationMessage(kind: ReminderKind): string {
  return kind === "evening"
    ? "今日の記録を確認してください"
    : "Paceを確認してください";
}
export function mergeReminderPreferences(
  preferences: NotificationCenterConfig,
  current?: NotificationCenterConfig,
): NotificationCenterConfig {
  const rules = { ...preferences.rules };
  for (const kind of Object.keys(rules) as ReminderKind[]) {
    const state = current?.rules[kind];
    rules[kind] = {
      ...rules[kind],
      lastAcknowledged: state?.lastAcknowledged,
      lastDelivered: state?.lastDelivered,
      snoozedUntil: state?.snoozedUntil,
    };
  }
  return { ...preferences, rules };
}
