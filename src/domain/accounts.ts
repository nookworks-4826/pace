import { verificationDays } from "./practical";
import type { Account, AppData, BalanceEffect, Transfer } from "../types";
import { dateKey, todayJST } from "./dates";

const MAX_ACCOUNT_MONEY = 999_999_999_999;
function moneySum(values: number[]): number {
  return values.reduce((total, amount) => {
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(total + amount))
      throw new Error("口座の合計金額が計算できる範囲を超えています。");
    return total + amount;
  }, 0);
}
function isLiability(account: Account): boolean {
  return account.kind === "CREDIT_CARD";
}
function afterSnapshot(
  account: Account,
  row: { date: string; createdAt?: string },
  today: string,
): boolean {
  const day = dateKey(row.date);
  const asOf = dateKey(account.balanceAsOf);
  if (day > dateKey(today) || day < asOf) return false;
  if (day > asOf) return true;
  if (!row.createdAt) return false;
  return Date.parse(row.createdAt) > Date.parse(account.snapshotRecordedAt);
}
function ledgerEffect(account: Account, effect?: BalanceEffect): boolean {
  return (
    (effect ??
      (account.balanceSource === "provider" ? "snapshot" : "ledger")) ===
    "ledger"
  );
}
function expenseAffectsBalance(
  account: Account,
  row: AppData["expenses"][number],
  today: string,
): boolean {
  if (!ledgerEffect(account, row.balanceEffect)) return false;
  // An explicitly uncovered pending authorization can precede a later posted balance snapshot.
  if (
    account.balanceSource === "provider" &&
    account.kind === "CREDIT_CARD" &&
    row.pendingStatus === "pending" &&
    row.balanceEffect === "ledger"
  )
    return dateKey(row.date) <= dateKey(today);
  return afterSnapshot(account, row, today);
}

/** Snapshot values already include provider history. Only explicit later ledger effects are applied. */
export function calculateAccountBalance(
  data: AppData,
  accountOrId: Account | string,
  today = todayJST(),
): number | null {
  const account =
    typeof accountOrId === "string"
      ? data.accounts?.find((row) => row.id === accountOrId)
      : accountOrId;
  if (
    !account ||
    account.snapshotBalance === null ||
    dateKey(account.balanceAsOf) > dateKey(today)
  )
    return null;
  const liability = isLiability(account);
  const deltas: number[] = [account.snapshotBalance];
  for (const row of data.expenses) {
    const linked =
      row.sourceAccountId === account.id ||
      (!row.sourceAccountId &&
        liability &&
        account.creditCardId &&
        row.creditCardId === account.creditCardId);
    if (linked && expenseAffectsBalance(account, row, today))
      deltas.push((liability ? 1 : -1) * row.amount);
  }
  for (const row of data.incomes) {
    if (
      row.sourceAccountId === account.id &&
      afterSnapshot(account, row, today) &&
      ledgerEffect(account, row.balanceEffect)
    )
      deltas.push((liability ? -1 : 1) * row.amount);
  }
  for (const row of data.transfers ?? []) {
    if (row.status !== "confirmed" || !afterSnapshot(account, row, today))
      continue;
    if (
      row.fromAccountId === account.id &&
      ledgerEffect(account, row.fromBalanceEffect)
    )
      deltas.push((liability ? 1 : -1) * row.amount);
    if (
      row.toAccountId === account.id &&
      ledgerEffect(account, row.toBalanceEffect)
    )
      deltas.push((liability ? -1 : 1) * row.amount);
  }
  for (const row of data.cardPayments) {
    // A recorded settlement must have one representation: either a Transfer or CardPayment.
    if (
      row.sourceAccountId === account.id &&
      afterSnapshot(account, row, today)
    )
      deltas.push(-row.amount);
    if (
      liability &&
      account.creditCardId === row.creditCardId &&
      afterSnapshot(account, row, today)
    )
      deltas.push(-row.amount);
  }
  for (const row of [...data.repayments, ...data.savingsContributions]) {
    if (
      row.sourceAccountId === account.id &&
      afterSnapshot(account, row, today)
    )
      deltas.push((liability ? 1 : -1) * row.amount);
  }
  for (const row of data.externalTransactions ?? []) {
    if (
      row.accountId !== account.id ||
      row.kind !== "refund" ||
      !afterSnapshot(account, row, today) ||
      !ledgerEffect(account, row.balanceEffect)
    )
      continue;
    // Provider-normalized inflows are positive, so a card refund lowers its liability.
    deltas.push(liability ? -row.amount : row.amount);
  }
  return moneySum(deltas);
}

export interface AccountBalance {
  account: Account;
  balance: number | null;
  isLiability: boolean;
  isStale: boolean;
  lastUpdatedAt: string;
}
export function getAccountBalances(
  data: AppData,
  today = todayJST(),
  now = new Date().toISOString(),
): AccountBalance[] {
  return (data.accounts ?? []).map((account) => ({
    account,
    balance: calculateAccountBalance(data, account, today),
    isLiability: isLiability(account),
    isStale:
      verificationDays(account) !== 0 &&
      !account.archivedAt &&
      (!Number.isFinite(
        Date.parse(account.lastVerifiedAt ?? account.snapshotRecordedAt),
      ) ||
        Date.parse(now) -
          Date.parse(account.lastVerifiedAt ?? account.snapshotRecordedAt) >=
          verificationDays(account) * 24 * 60 * 60_000),
    lastUpdatedAt: account.lastVerifiedAt ?? account.snapshotRecordedAt,
  }));
}

/** New records without a source cannot silently disappear when account mode replaces the legacy total. */
export function getUnallocatedRecordIds(
  data: AppData,
  today = todayJST(),
): string[] {
  const accounts = data.accounts ?? [];
  const spendable = accounts.filter(
    (row) => row.kind !== "CREDIT_CARD" && row.isSpendable && row.isActive,
  );
  if (!spendable.length) return [];
  const earliest = [...spendable].sort(
    (a, b) =>
      a.balanceAsOf.localeCompare(b.balanceAsOf) ||
      a.snapshotRecordedAt.localeCompare(b.snapshotRecordedAt),
  )[0];
  const validIds = new Set(accounts.map((row) => row.id));
  const records = [
    ...data.expenses.filter((row) => row.paymentMethod !== "creditCard"),
    ...data.incomes,
    ...data.cardPayments,
    ...data.repayments,
    ...data.savingsContributions,
  ];
  return records
    .filter(
      (row) =>
        afterSnapshot(earliest, row, today) &&
        (!row.sourceAccountId || !validIds.has(row.sourceAccountId)),
    )
    .map((row) => row.id);
}

export function getAccountTotals(data: AppData, today = todayJST()) {
  const balances = getAccountBalances(data, today);
  const assets = balances.filter(
    (row) => !row.isLiability && row.account.isActive,
  );
  const spendable = assets.filter((row) => row.account.isSpendable);
  // Closed cards remain liabilities until settled; hiding a card cannot restore spendable money.
  const liabilities = balances.filter((row) => row.isLiability);
  const hasUndistributedLegacyBalance =
    spendable.some((row) => row.account.id === "legacy-liquid") &&
    assets.some((row) => row.account.id !== "legacy-liquid");
  const unknownAccountIds = [...spendable, ...liabilities]
    .filter((row) => row.balance === null)
    .map((row) => row.account.id);
  const unallocatedRecordIds = getUnallocatedRecordIds(data, today);
  return {
    balances,
    totalAssets: assets.some((row) => row.balance === null)
      ? null
      : moneySum(assets.map((row) => row.balance!)),
    spendableAssets:
      spendable.length === 0 ||
      spendable.some((row) => row.balance === null) ||
      unallocatedRecordIds.length > 0 ||
      hasUndistributedLegacyBalance
        ? null
        : moneySum(spendable.map((row) => row.balance!)),
    cardLiabilities: liabilities.some((row) => row.balance === null)
      ? null
      : moneySum(liabilities.map((row) => Math.max(0, row.balance!))),
    unknownAccountIds,
    unallocatedRecordIds,
    hasUndistributedLegacyBalance,
    lastUpdatedAt:
      balances
        .filter((row) => row.account.balanceSource === "provider")
        .map((row) => row.lastUpdatedAt)
        .sort()[0] ?? null,
    hasStaleData: balances.some((row) => row.isStale),
  };
}

export function validateTransfer(
  transfer: Transfer,
  accounts: Account[],
): void {
  if (
    !Number.isSafeInteger(transfer.amount) ||
    transfer.amount <= 0 ||
    transfer.amount > MAX_ACCOUNT_MONEY
  )
    throw new Error("振替金額は1円以上の整数で入力してください。");
  dateKey(transfer.date);
  const from = accounts.find((row) => row.id === transfer.fromAccountId);
  const to = accounts.find((row) => row.id === transfer.toAccountId);
  if (!from || !to || from.id === to.id)
    throw new Error("異なる振替元・振替先を選んでください。");
  if (from.currency !== "JPY" || to.currency !== "JPY")
    throw new Error("振替は円の口座で登録してください。");
}

export function transferBalanceDeltas(
  from: Account,
  to: Account,
  amount: number,
) {
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    amount > MAX_ACCOUNT_MONEY
  )
    throw new Error("振替金額を確認してください。");
  return {
    from: isLiability(from) ? amount : -amount,
    to: isLiability(to) ? -amount : amount,
  };
}

export function previewTransfer(
  data: AppData,
  transfer: Transfer,
  today = todayJST(),
) {
  const accounts = data.accounts ?? [];
  validateTransfer(transfer, accounts);
  const from = accounts.find((row) => row.id === transfer.fromAccountId)!;
  const to = accounts.find((row) => row.id === transfer.toAccountId)!;
  const beforeFrom = calculateAccountBalance(data, from, today);
  const beforeTo = calculateAccountBalance(data, to, today);
  const delta = transferBalanceDeltas(from, to, transfer.amount);
  const appliesFrom =
    transfer.status === "confirmed" &&
    ledgerEffect(from, transfer.fromBalanceEffect) &&
    afterSnapshot(from, transfer, today);
  const appliesTo =
    transfer.status === "confirmed" &&
    ledgerEffect(to, transfer.toBalanceEffect) &&
    afterSnapshot(to, transfer, today);
  return {
    fromBefore: beforeFrom,
    toBefore: beforeTo,
    fromAfter:
      beforeFrom === null
        ? null
        : moneySum([beforeFrom, appliesFrom ? delta.from : 0]),
    toAfter:
      beforeTo === null ? null : moneySum([beforeTo, appliesTo ? delta.to : 0]),
  };
}
