import type {
  AppData,
  Account,
  Expense,
  ExternalTransaction,
  Income,
  RecurringOccurrence,
} from "../types";
import { dateOnDay } from "./dates";
import { suggestCategory, normalizeMerchant } from "./categorization";
import type { ProviderTransaction } from "../providers/types";

export function externalKey(
  provider: string,
  connection: string,
  account: string,
  transaction: string,
) {
  return JSON.stringify([provider, connection, account, transaction]);
}
const transferWords =
  /振替|振込|送金|チャージ|ATM|引出|引き出し|口座移動|TRANSFER|TOP.?UP|WITHDRAW/i;
const cardSettlementName =
  /カード(?:利用代金|ご利用代金|引落|引き落とし|支払)|^(?:credit)?card(?:payment|settlement)|三井住友カード|ミツイスミトモカード|smbccard|三菱ufj(?:ニコス|カード)|ミツビシufj(?:ニコス|カード)|mufg(?:nicos|card|カード)|ニコス|nicos|楽天カード|paypayカード|イオンカード|エポスカード|セゾンカード|jcbカード/i;
const walletRefillName =
  /^(?:モバイルスイカ|モバイルsuica|mobilesuica)|^suica(?:\d|$)|^(?:paypay|ペイペイ)(?:\d|$)/i;
/** Candidates need confirmation: neither names nor a matching amount prove a transfer. */
export function needsTransferReview(
  account: Account,
  transaction: ProviderTransaction,
  knownCounterparts: readonly ProviderTransaction[] = [],
): boolean {
  if (transaction.amount < 0) {
    if (transferWords.test(transaction.description)) return true;
    const name = normalizeMerchant(transaction.description);
    if (account.kind === "BANK" && cardSettlementName.test(name)) return true;
    if (
      ["BANK", "CREDIT_CARD"].includes(account.kind) &&
      walletRefillName.test(name)
    )
      return true;
  }
  return (
    transaction.amount !== 0 &&
    knownCounterparts.some(
      (other) =>
        other.externalAccountId !== transaction.externalAccountId &&
        other.currency === "JPY" &&
        Number.isSafeInteger(other.amount) &&
        other.amount === -transaction.amount &&
        Math.abs(Date.parse(other.date) - Date.parse(transaction.date)) <=
          86_400_000,
    )
  );
}
export function manualDuplicate(
  data: AppData,
  transaction: ExternalTransaction,
) {
  const account = data.accounts?.find((a) => a.id === transaction.accountId);
  return transaction.amount < 0
    ? data.expenses.find(
        (e) =>
          !e.externalTransactionId &&
          e.amount === Math.abs(transaction.amount) &&
          Math.abs(Date.parse(e.date) - Date.parse(transaction.date)) <=
            86_400_000 &&
          (e.sourceAccountId === transaction.accountId ||
            (account?.creditCardId === e.creditCardId && !!e.creditCardId) ||
            (!e.sourceAccountId &&
              account?.kind === "BANK" &&
              ["bank", "debit"].includes(e.paymentMethod))) &&
          normalizeMerchant(e.merchant) ===
            normalizeMerchant(transaction.description),
      )
    : undefined;
}
export function transferCandidates(rows: ExternalTransaction[]) {
  return rows
    .filter((r) => r.kind === "unclassified" && r.amount < 0)
    .flatMap((from) => {
      const to = rows.find(
        (r) =>
          r.kind === "unclassified" &&
          r.accountId !== from.accountId &&
          r.amount === -from.amount &&
          r.currency === from.currency &&
          Math.abs(Date.parse(r.date) - Date.parse(from.date)) <= 86_400_000,
      );
      return to ? [{ from, to }] : [];
    });
}
/** Pure import plan. Snapshots own balances; these rows own spending analysis only. */
export function planFinancialImport(
  data: AppData,
  account: Account,
  transactions: ProviderTransaction[],
  connectionId: string,
  now: string,
) {
  const external: ExternalTransaction[] = [];
  const expenses: Expense[] = [];
  const incomes: Income[] = [];
  const occurrences: RecurringOccurrence[] = [];
  const knownAccountIds = new Set(
    [
      account.externalAccountId,
      ...(data.accounts ?? [])
        .filter(
          (other) =>
            other.providerId === account.providerId &&
            other.connectionId === connectionId,
        )
        .map((other) => other.externalAccountId),
    ].filter((id): id is string => !!id),
  );
  const counterpartAmounts = new Map<number, ProviderTransaction[]>();
  const knownRows = new Map<string, ProviderTransaction>();
  for (const row of data.externalTransactions ?? []) {
    if (
      row.providerId === (account.providerId ?? "moneytree") &&
      row.connectionId === connectionId
    )
      knownRows.set(
        JSON.stringify([row.externalAccountId, row.externalTransactionId]),
        row,
      );
  }
  // The current provider version replaces a prior pending amount in the counterpart index too.
  for (const row of transactions)
    knownRows.set(
      JSON.stringify([row.externalAccountId, row.externalTransactionId]),
      row,
    );
  for (const row of knownRows.values()) {
    if (
      !knownAccountIds.has(row.externalAccountId) ||
      row.currency !== "JPY" ||
      !Number.isSafeInteger(row.amount)
    )
      continue;
    const matching = counterpartAmounts.get(row.amount) ?? [];
    matching.push(row);
    counterpartAmounts.set(row.amount, matching);
  }
  for (const t of transactions) {
    if (
      t.externalAccountId !== account.externalAccountId ||
      t.currency !== "JPY" ||
      !Number.isSafeInteger(t.amount) ||
      Math.abs(t.amount) > 999_999_999_999 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(t.date)
    )
      continue;
    const id = externalKey(
      account.providerId ?? "moneytree",
      connectionId,
      t.externalAccountId,
      t.externalTransactionId,
    );
    const previous = data.externalTransactions?.find((r) => r.id === id);
    const transferReview = needsTransferReview(
      account,
      t,
      counterpartAmounts.get(-t.amount),
    );
    const row: ExternalTransaction = {
      ...previous,
      id,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      providerId: account.providerId ?? "moneytree",
      connectionId,
      externalTransactionId: t.externalTransactionId,
      externalAccountId: t.externalAccountId,
      accountId: account.id,
      date: t.date,
      amount: t.amount,
      description: t.description,
      currency: t.currency,
      pendingStatus: t.pendingStatus,
      externalUpdatedAt: t.externalUpdatedAt,
      kind: previous?.kind ?? "unclassified",
      originalCurrency: t.originalCurrency,
      originalAmount: t.originalAmount,
      finalJPYAmount: t.finalJPYAmount,
      balanceEffect: "snapshot",
    };
    const linked = data.expenses.find((e) => e.id === row.linkedRecordId);
    // A pending purchase can become a posted refund/cancellation. Keep it for review instead of adding income.
    if (linked && t.amount >= 0 && row.kind === "expense") {
      row.kind = "unclassified";
    } else if (linked && t.amount < 0 && row.kind === "expense") {
      expenses.push({
        ...linked,
        amount: -t.amount,
        date: t.date,
        pendingStatus: t.pendingStatus,
        updatedAt: now,
        finalJPYAmount: t.finalJPYAmount,
        originalAmount: t.originalAmount,
        originalCurrency: t.originalCurrency,
      });
    } else if (
      row.kind === "unclassified" &&
      t.amount < 0 &&
      !transferReview &&
      !manualDuplicate(data, row) &&
      (account.kind !== "CREDIT_CARD" || !!account.creditCardId)
    ) {
      const category = suggestCategory(
        t.description,
        data.merchantRules,
        data.categories,
      );
      const expenseId = `external:${id}`;
      expenses.push({
        id: expenseId,
        createdAt: now,
        updatedAt: now,
        amount: -t.amount,
        date: t.date,
        merchant: t.description,
        description: "",
        memo: "",
        isFixedCost: false,
        categoryId: category.categoryId,
        subcategoryId: category.subcategoryId,
        sourceAccountId: account.id,
        paymentMethod:
          account.kind === "CREDIT_CARD"
            ? "creditCard"
            : account.kind === "CASH"
              ? "cash"
              : account.kind === "BANK"
                ? "bank"
                : "other",
        creditCardId:
          account.kind === "CREDIT_CARD" ? account.creditCardId : undefined,
        paymentChannel: "direct",
        providerId: row.providerId,
        connectionId,
        externalTransactionId: row.externalTransactionId,
        externalAccountId: row.externalAccountId,
        pendingStatus: row.pendingStatus,
        balanceEffect: "snapshot",
        originalCurrency: row.originalCurrency,
        originalAmount: row.originalAmount,
        finalJPYAmount: row.finalJPYAmount,
      });
      row.kind = "expense";
      row.linkedRecordId = expenseId;
    } else if (
      row.kind === "unclassified" &&
      t.amount > 0 &&
      account.kind !== "CREDIT_CARD" &&
      !transferReview &&
      data.salaryRules?.some(
        (r) =>
          r.enabled &&
          r.accountId === account.id &&
          r.normalizedDescription === normalizeMerchant(t.description),
      )
    ) {
      const incomeId = `external:${id}`;
      incomes.push({
        id: incomeId,
        createdAt: now,
        updatedAt: now,
        amount: t.amount,
        date: t.date,
        source: t.description,
        memo: "",
        type: "salary",
        sourceAccountId: account.id,
        providerId: row.providerId,
        connectionId,
        externalTransactionId: row.externalTransactionId,
        externalAccountId: row.externalAccountId,
        balanceEffect: "snapshot",
      });
      row.kind = "income";
      row.linkedRecordId = incomeId;
    } else if (row.kind === "income") {
      const income = data.incomes.find((i) => i.id === row.linkedRecordId);
      if (income && t.amount > 0)
        incomes.push({
          ...income,
          date: t.date,
          amount: t.amount,
          updatedAt: now,
        });
    }
    external.push(row);
  }
  for (const expense of expenses) {
    const recurring = data.recurringExpenses.find(
      (r) =>
        r.isActive &&
        r.amount === expense.amount &&
        r.sourceAccountId === expense.sourceAccountId &&
        normalizeMerchant(r.name) === normalizeMerchant(expense.merchant) &&
        r.startDate <= expense.date &&
        (!r.endDate || r.endDate >= expense.date),
    );
    if (!recurring) continue;
    const id = `${recurring.id}:${expense.date.slice(0, 7)}`;
    const prior = data.recurringOccurrences.find((o) => o.id === id);
    if (prior && prior.expenseId !== expense.id) continue;
    expense.isFixedCost = true;
    expense.recurringOccurrenceId = id;
    occurrences.push({
      id,
      recurringExpenseId: recurring.id,
      dueDate: dateOnDay(expense.date.slice(0, 7), recurring.dueDay),
      status: "paid",
      expenseId: expense.id,
    });
  }
  return { external, expenses, incomes, occurrences };
}
