import type { AppData, Expense } from '../types';
import { addDaysDate, addMonthsDate, monthKey } from './dates';
export function searchExpenses(data: AppData, query: string, today: string): Expense[] {
  let text = query.slice(0,300).normalize('NFKC').toLowerCase().trim();
  let from = '', month = '', min = 0;
  if (text.includes('先月')) { month = monthKey(addMonthsDate(today,-1)); text = text.replace('先月',''); }
  else if (text.includes('今月')) { month = monthKey(today); text = text.replace('今月',''); }
  if (text.includes('最近')) { from = addDaysDate(today,-28); text = text.replace('最近',''); }
  if (/一番(?:よく)?(?:使っている|利用する|利用した)店/.test(text)) {
    const rows=data.expenses.filter(e=>e.date<=today&&(!from||e.date>=from)&&(!month||e.date.startsWith(month)));
    const uses=new Map<string,number>();
    for(const e of rows)if(e.merchant&&e.merchant!=='支出')uses.set(e.merchant,(uses.get(e.merchant)??0)+1);
    let highest=0;for(const count of uses.values())highest=Math.max(highest,count);
    return rows.filter(e=>highest>0&&uses.get(e.merchant)===highest);
  }
  const amount = text.match(/(\d[\d,]*)\s*円以上/);
  if (amount) { min = Number(amount[1].replaceAll(',','')); text = text.replace(amount[0],''); }
  text = text.replace(/で使ったもの|で使った|支払ったもの|の支出|の履歴|の外食/g, x => x === 'の外食' ? '外食' : '').replace(/^の/,'').trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  return data.expenses.filter(e => {
    if (e.date > today || e.amount < min || (from && e.date < from) || (month && !e.date.startsWith(month))) return false;
    const category = data.categories.find(c => c.id === e.categoryId);
    const corpus = [e.merchant,e.description,e.memo,e.amount,category?.name,category?.subcategories.find(s=>s.id===e.subcategoryId)?.name,
      data.accounts?.find(a=>a.id===e.sourceAccountId)?.name, data.cards.find(c=>c.id===e.creditCardId)?.name,
      e.paymentMethod === 'cash' ? '現金' : '', e.paymentChannel === 'applePay' ? 'Apple Pay' : ''].join(' ').normalize('NFKC').toLowerCase();
    return tokens.every(t => corpus.includes(t));
  });
}
