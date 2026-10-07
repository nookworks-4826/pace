import type {
  Account,
  AppData,
  Expense,
  Favorite,
  ReviewReason,
  VerificationDays,
} from "../types";
import { normalizeMerchant } from "./categorization";
import { addDaysDate } from "./dates";

export const verificationChoices: VerificationDays[] = [1, 3, 7, 14, 30, 0];
export function verificationDays(account: Account): VerificationDays {
  return (
    account.verificationDays ??
    (account.kind === "CASH" || account.kind === "EWALLET" ? 3 : 7)
  );
}
/** Missing optional details never change the financial amount or source. */
export function reviewReasons(expense: Expense): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  if (!expense.merchant.trim() || expense.merchant === "支出")
    reasons.push("merchant");
  if (expense.categoryId === "uncategorized") reasons.push("category");
  if (expense.ocrNeedsReview) reasons.push("ocr");
  if (expense.paymentNeedsReview) reasons.push("payment");
  return expense.reviewed ? [] : reasons;
}
export function previousExpense(data: AppData): Expense | undefined {
  return data.expenses.reduce<Expense | undefined>(
    (latest, row) =>
      !latest || row.createdAt > latest.createdAt ? row : latest,
    undefined,
  );
}
/** Copy only input fields: no IDs, receipts, recurring links or imported metadata. */
export function expenseInput(row: Favorite | Expense): Partial<Expense> {
  return {
    amount: row.amount || undefined,
    merchant: row.merchant,
    categoryId: row.categoryId,
    subcategoryId: row.subcategoryId,
    paymentMethod: row.paymentMethod,
    creditCardId: row.creditCardId,
    sourceAccountId: row.sourceAccountId,
    paymentChannel: row.paymentChannel ?? "direct",
    memo: row.memo ?? "",
  };
}
export function recentAmountSuggestions(
  data: AppData,
  merchant: string,
  accountId: string,
  today: string,
): number[] {
  const name = normalizeMerchant(merchant),
    cutoff = addDaysDate(today, -90);
  const rows = data.expenses.filter(
    (row) =>
      row.date >= cutoff &&
      row.date <= today &&
      (name
        ? normalizeMerchant(row.merchant) === name
        : accountId
          ? row.sourceAccountId === accountId
          : true),
  );
  return [
    ...new Set(
      rows
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((row) => row.amount),
    ),
  ].slice(0, 4);
}
export function balanceDrift(previous: number | null, current: number) {
  if (!Number.isSafeInteger(current) || current < 0)
    throw new Error("残高を確認してください。");
  return previous === null ? null : current - previous;
}
export function privacyFacts(data: AppData) {
  return {
    financialData: "端末内・暗号化",
    externalAI: "未使用",
    externalOCR: "未使用",
    analytics: "未使用",
    advertising: "なし",
    financialAPI: "未接続",
    receipts: data.receipts?.length ?? 0,
    backup: data.settings.practical?.backupHealth ?? null,
  };
}
