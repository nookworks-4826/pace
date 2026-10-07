import type { Account, AppData, Expense } from "../types";
import type { HomeCardId, PersonalizationSettings } from "../types/experience";
import { normalizeMerchant } from "./categorization";
import { addDaysDate } from "./dates";

export const defaultPersonalization: PersonalizationSettings = {
  enabled: true,
  pinnedCards: [],
  featureUses: {},
};
export function payableAccounts(
  data: AppData,
  editingSource?: string,
): Account[] {
  const order: Record<Account["kind"], number> = {
    CASH: 0,
    BANK: 1,
    EWALLET: 2,
    CREDIT_CARD: 3,
    OTHER: 4,
    SAVINGS: 5,
  };
  // Encrypted IndexedDB indexes are blinded, so their iteration order is not a UI order.
  return (data.accounts ?? [])
    .filter(
      (a) =>
        (a.isActive && !a.archivedAt && a.kind !== "SAVINGS") ||
        a.id === editingSource,
    )
    .sort(
      (a, b) =>
        order[a.kind] - order[b.kind] ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.name.localeCompare(b.name, "ja") ||
        a.id.localeCompare(b.id),
    );
}
/** Suggestions never select a source or alter accounting. 28-day buckets avoid daily layout churn. */
export function rankPaymentSources(
  data: AppData,
  today: string,
  editingSource?: string,
  merchant = "",
): Account[] {
  const accounts = payableAccounts(data, editingSource);
  if (data.settings.personalization?.enabled === false) return accounts;
  const cutoff = addDaysDate(today, -28);
  const scores = new Map<string, number>();
  for (const row of data.expenses) {
    if (row.date < cutoff || row.date > today || !row.sourceAccountId) continue;
    scores.set(row.sourceAccountId, (scores.get(row.sourceAccountId) ?? 0) + 1);
  }
  const name = normalizeMerchant(merchant);
  const merchantRows = name
    ? data.expenses.filter(
        (row) =>
          row.date >= cutoff &&
          row.date <= today &&
          normalizeMerchant(row.merchant) === name &&
          row.sourceAccountId,
      )
    : [];
  if (merchantRows.length >= 3)
    for (const row of merchantRows)
      scores.set(
        row.sourceAccountId!,
        (scores.get(row.sourceAccountId!) ?? 0) + 10,
      );
  return accounts
    .map((account, index) => ({
      account,
      index,
      score: scores.get(account.id) ?? 0,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.account);
}
export function orderHomeCards(data: AppData, today: string): HomeCardId[] {
  const p = data.settings.personalization ?? defaultPersonalization;
  const original: HomeCardId[] = p.homeCardOrder ?? [
    "balances",
    "insight",
    "recent",
  ];
  if (!p.enabled) return original;
  const scores: Record<HomeCardId, number> = {
    balances: p.featureUses.balance ?? 0,
    insight: p.featureUses.insight ?? 0,
    recent: p.featureUses.history ?? 0,
  };
  const recent = data.expenses.filter(
    (e) => e.date >= addDaysDate(today, -28) && e.date <= today,
  );
  if (
    recent.length >= 5 &&
    recent.filter((e) => e.paymentMethod === "cash").length / recent.length >=
      0.5
  )
    scores.balances += 10;
  const movable = original
    .filter((id) => !p.pinnedCards.includes(id))
    .sort((a, b) => scores[b] - scores[a]);
  return original.map((id) =>
    p.pinnedCards.includes(id) ? id : movable.shift()!,
  );
}
export function spendingInsight(data: AppData, today: string): string {
  const rows = data.expenses.filter(
    (e) => e.date >= addDaysDate(today, -28) && e.date <= today,
  );
  if (!rows.length) return "記録が増えると、直近4週間の傾向を表示します。";
  const cash = rows.filter((e) => e.paymentMethod === "cash").length;
  return `直近4週間の記録${rows.length}件のうち、現金払いは${Math.round((cash / rows.length) * 100)}%です。`;
}
export function unusualAmount(
  expenses: Expense[],
  merchant: string,
  amount: number,
): boolean {
  const normalized = normalizeMerchant(merchant);
  if (!normalized) return false;
  const values = expenses
    .filter((e) => normalizeMerchant(e.merchant) === normalized)
    .map((e) => e.amount)
    .sort((a, b) => a - b);
  if (values.length < 5) return false;
  const median = values[Math.floor(values.length / 2)];
  return amount >= 3000 && amount > median * 5;
}
