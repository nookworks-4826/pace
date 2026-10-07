import { db } from '../db';
import type { NotificationCenterConfig, ReminderKind } from '../types';
import { mergeReminderPreferences } from './notificationCenter';
export async function saveReminderPreferences(preferences:NotificationCenterConfig) {
  await db.transaction('rw',db.settings,async()=>{
    const settings=await db.settings.get('main');if(!settings)throw new Error('設定を開き直してください。');
    await db.settings.put({...settings,notificationCenter:mergeReminderPreferences(preferences,settings.notificationCenter)});
  });
}
export async function settleReminder(kind:ReminderKind,key:string,config:NotificationCenterConfig,snooze=false) {
  await db.transaction('rw',db.settings,async()=>{
    const s=await db.settings.get('main');if(!s)return;
    const c=s.notificationCenter??config,r=c.rules[kind];
    await db.settings.put({...s,notificationCenter:{...c,rules:{...c.rules,[kind]:{...r,
      ...(snooze?{snoozedUntil:new Date(Date.now()+r.snoozeMinutes*60000).toISOString()}:{lastAcknowledged:key,snoozedUntil:undefined})}}}});
  });
}
