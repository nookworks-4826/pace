import { useEffect, useState } from 'react';
export function useReminderClock(){
  const clock=()=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
  const [value,setValue]=useState(clock);
  useEffect(()=>{const refresh=()=>setValue(clock());const id=setInterval(refresh,30000);window.addEventListener('focus',refresh);return()=>{clearInterval(id);window.removeEventListener('focus',refresh);};},[]);
  return value;
}
