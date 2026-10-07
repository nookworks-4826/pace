import { useEffect, useRef } from "react";
import type { AppData } from "../types";
import { dueReminders, isQuiet, notificationConfig, privateNotificationMessage } from "../domain/notificationCenter";
import { db } from "../db";
import { updateSettings } from "../db";
import { APP_NAME } from "../types";
import { todayJST } from "../domain/dates";
export function useFinancialReminder(data: AppData | null) {
  const latest = useRef(data), running=useRef(false); latest.current=data;
  useEffect(() => {
    const r = data?.settings.reminder;
    if (!r?.enabled || r.delivery !== "foreground") return;
    const evaluate = async () => {
      const data=latest.current;
      const date = todayJST();
      const clock = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Tokyo",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date());
      if (data && isQuiet(clock,notificationConfig(data))) return;
      if(data?.settings.notificationCenter && document.visibilityState==='visible' && 'Notification' in window && Notification.permission==='granted'){
        const due=dueReminders(data,date,clock).filter(n=>data.settings.notificationCenter!.rules[n.kind].lastDelivered!==n.key);
        for(const n of due){
          const registration=await navigator.serviceWorker?.getRegistration();
          const options={tag:'pace-'+n.kind,icon:import.meta.env.BASE_URL+'icon-sunny-192.png'};
          if(registration)await registration.showNotification(privateNotificationMessage(n.kind),options);
          else new Notification(privateNotificationMessage(n.kind),options);
          await db.transaction('rw',db.settings,async()=>{const s=await db.settings.get('main');if(!s?.notificationCenter)return;const c=s.notificationCenter;await db.settings.put({...s,notificationCenter:{...c,rules:{...c.rules,[n.kind]:{...c.rules[n.kind],lastDelivered:n.key}}}});});
        }
        return;
      }
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
    const check=async()=>{if(running.current)return;running.current=true;try{await evaluate();}finally{running.current=false;}};
    void check().catch(() => {});
    const timer = setInterval(() => void check().catch(() => {}), 60_000);
    return () => clearInterval(timer);
  }, [data?.settings.reminder,data?.settings.notificationCenter]);
}
