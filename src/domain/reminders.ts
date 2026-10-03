import { APP_NAME } from "../types";

export function buildDailyReminder(time: string, today: string) {
  if (
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(today)
  )
    throw new Error("通知時刻を確認してください。");
  const date = today.replaceAll("-", ""),
    clock = time.replace(":", "") + "00";
  // No balances, transactions, names, provider tokens or keys leave the app.
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Pace//Private Reminder//JA",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:pace-reminder-${date}-${clock}@local`,
    `DTSTAMP:${date}T000000Z`,
    `DTSTART;TZID=Asia/Tokyo:${date}T${clock}`,
    "DURATION:PT5M",
    "RRULE:FREQ=DAILY",
    `SUMMARY:今日の${APP_NAME}を確認してください`,
    "BEGIN:VALARM",
    "TRIGGER:PT0M",
    "ACTION:DISPLAY",
    `DESCRIPTION:今日の${APP_NAME}を確認してください`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
export async function enableForegroundNotifications() {
  if (!("Notification" in window))
    throw new Error(
      "このブラウザでは通知を利用できません。カレンダーのリマインダーを使えます。",
    );
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error("通知は許可されていません。設定は保存していません。");
}
