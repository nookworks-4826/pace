import type { AppData } from '../types';
import { normalizeMerchant, suggestCategory, type CategorySuggestion } from './categorization';
/** Progressive support currently stops at rules/history. No model, GPU or cloud is required. */
export function suggestLocalCategory(merchant:string,data:AppData):CategorySuggestion {
  const rule=suggestCategory(merchant,data.merchantRules,data.categories);
  if(rule.source!=='none')return rule;
  const key=normalizeMerchant(merchant);if(!key)return rule;
  const history=data.expenses.filter(e=>normalizeMerchant(e.merchant)===key&&e.categoryId!=='uncategorized').sort((a,b)=>b.date.localeCompare(a.date));
  if(history.length<2)return rule;
  const first=history[0],c=data.categories.find(c=>c.id===first.categoryId&&!c.archived);
  if(!c||history.some(e=>e.categoryId!==first.categoryId))return rule;
  const sub=c.subcategories.find(s=>s.id===first.subcategoryId);
  return {categoryId:c.id,subcategoryId:sub?.id??'',confidence:'medium',source:'pattern',label:sub?.name??c.name};
}
