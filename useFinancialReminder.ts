import { useEffect } from "react";
import type { AppData } from "../types";
import { updateSettings } from "../db";
import { APP_NAME } from "../types";
import { todayJST } from "../domain/dates";
export function useFinancialReminder(data: AppData | null) {
  useEffect(() => {
    const r = data?.settings.reminder;
    if (!r?.enabled || r.delivery !== "foreground") return;
    const check = async () => {
      const date = todayJST();
      const clock = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Tokyo",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date());
      if (
        document.visibilityState !== "visible" ||
        clock < r.time ||
        r.lastNotifiedDate === date ||
        !("Notification" in window) ||
        Notification.permission !== "granted"
      )
        return;
      const registration = await navigator.serviceWorker?.getRegistration();
      if (registration)
        await registration.showNotification(
          `今日の${APP_NAME}を確認してください`,
          {
            tag: "pace-daily",
            icon: `${import.meta.env.BASE_URL}icon-sunny-192.png`,
          },
        );
      else
        new Notification(`今日の${APP_NAME}を確認してください`, {
          tag: "pace-daily",
        });
      await updateSettings({ reminder: { ...r, lastNotifiedDate: date } });
    };
    void check().catch(() => {});
    const timer = setInterval(() => void check().catch(() => {}), 60_000);
    return () => clearInterval(timer);
  }, [data?.settings.reminder]);
}
