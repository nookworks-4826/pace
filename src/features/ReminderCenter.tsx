import { useReminderClock } from '../hooks/useReminderClock';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Check, Clock } from 'lucide-react';
import { usePace } from '../app/context';
import { dueReminders, notificationConfig } from '../domain/notificationCenter';
import { settleReminder } from '../domain/reminderActions';
import type { ReminderKind } from '../types';
const destinations:Record<ReminderKind,string>={daily:'/',evening:'/history',balance:'/money?verify=1',payday:'/manage/incomes',card:'/manage/cards',recurring:'/manage/recurring',budget:'/analytics',low:'/money',backup:'/settings?panel=data'};
export function ReminderCenter({compact=false}:{compact?:boolean}) {
  const {data,today,run}=usePace();const [expanded,setExpanded]=useState(!compact);
  const clock=useReminderClock();
  const due=dueReminders(data,today,clock),config=notificationConfig(data);
  if(!due.length)return compact?null:<p className="hint">今の時間に確認するリマインダーはありません。</p>;
  return <section className="surface reminder-center"><button className="text-button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><Bell size={18}/> 確認すること · {due.filter(r=>r.badge).length}件</button>
    {expanded && due.map(r=><div className="reminder-item" key={r.key}><Link to={destinations[r.kind]}><b>{r.title}</b><small>{r.message}</small></Link><div className="button-row"><button type="button" className="chip" onClick={()=>void run(()=>settleReminder(r.kind,r.key,config))}><Check size={14}/>確認済み</button><button type="button" className="chip" onClick={()=>void run(()=>settleReminder(r.kind,r.key,config,true))}><Clock size={14}/>{config.rules[r.kind].snoozeMinutes}分後</button></div></div>)}
  </section>;
}
