import { assertMoney, type computeFinance } from "./finance";
import { dateKey, remainingDaysIncludingToday } from "./dates";

export type FinanceSummary = ReturnType<typeof computeFinance>;

/** Read-only arithmetic for an additional ordinary purchase. Never writes a record. */
export function previewPurchase(
  finance: FinanceSummary,
  amount: number,
  today: string,
) {
  assertMoney(amount, true);
  dateKey(today);
  if (finance.safeToSpend === null) return null;
  const safeAfter = finance.safeToSpend - amount;
  const budgetAfter =
    finance.monthlyBudgetRemaining === null
      ? null
      : finance.monthlyBudgetRemaining - amount;
  const daysAfterToday = remainingDaysIncludingToday(today) - 1;
  const available = Math.max(0, Math.min(safeAfter, budgetAfter ?? Infinity));
  return {
    safeAfter,
    shortage: Math.max(0, -safeAfter),
    budgetAfter,
    daysAfterToday,
    tomorrowAllowance:
      daysAfterToday > 0 ? Math.floor(available / daysAfterToday) : null,
  };
}

export function moneyAllocation(finance: FinanceSummary) {
  if (finance.liquidBalance === null || finance.safeToSpend === null)
    return null;
  const balance = Math.max(0, finance.liquidBalance);
  const free = Math.max(0, Math.min(balance, finance.safeToSpend));
  const reserved = Math.max(0, balance - free);
  return { free, reserved, freeRatio: balance > 0 ? free / balance : 0 };
}
