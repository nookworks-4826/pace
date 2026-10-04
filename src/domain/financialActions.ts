import { db, updateSettings, readAppData } from "../db";
import { calculateLiquidBalance } from "./finance";
import { calculateAccountBalance, validateTransfer } from "./accounts";
import { isVaultUnlocked } from "./vault";
import { todayJST } from "./dates";
import type { Account, Transfer } from "../types";
const stamp = () => ({
  id: crypto.randomUUID(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

export async function enableAccountManagement() {
  if (!isVaultUnlocked()) throw new Error("先に保管庫を開いてください。");
  const data = await readAppData();
  if (data.settings.financialAutomationEnabled) return;
  const now = new Date().toISOString(),
    today = todayJST();
  const legacy = calculateLiquidBalance(data, today);
  await db.transaction("rw", db.accounts, db.settings, async () => {
    if (!data.accounts?.length && legacy !== null)
      await db.accounts.add({
        ...stamp(),
        id: "legacy-liquid",
        name: "既存の銀行・現金",
        kind: "BANK",
        institutionName: "",
        currency: "JPY",
        snapshotBalance: legacy,
        balanceAsOf: today,
        snapshotRecordedAt: now,
        balanceSource: "manual",
        isSpendable: true,
        isActive: true,
        automationLevel: "manual",
      });
    await updateSettings({
      financialAutomationEnabled: true,
      budgetCycle: data.settings.budgetCycle ?? {
        mode: "calendar",
        startDay: 1,
      },
    });
  });
}
export async function saveTransfer(row: Transfer) {
  const data = await readAppData();
  validateTransfer(row, data.accounts ?? []);
  if (row.date > todayJST())
    throw new Error("振替の実績は今日以前の日付にしてください。");
  await db.transaction("rw", db.transfers, db.financialAudits, async () => {
    await db.transfers.put(row);
    await db.financialAudits.add({
      ...stamp(),
      action: "transfer-confirmed",
      recordId: row.id,
      detail: "振替として処理。支出・収入には含めません。",
    });
  });
}
export async function reverseTransfer(id: string) {
  await db.transaction(
    "rw",
    db.transfers,
    db.externalTransactions,
    db.financialAudits,
    async () => {
      await db.transfers.update(id, {
        status: "reversed",
        updatedAt: new Date().toISOString(),
      });
      const external = await db.externalTransactions.toArray();
      for (const row of external.filter((r) => r.linkedRecordId === id))
        await db.externalTransactions.update(row.id, {
          kind: "unclassified",
          linkedRecordId: undefined,
        });
      await db.financialAudits.add({
        ...stamp(),
        action: "transfer-reversed",
        recordId: id,
        detail: "振替処理を取り消しました。外部明細は確認待ちへ戻します。",
      });
    },
  );
}
export async function reconcileAccount(
  account: Account,
  newBalance: number,
  date: string,
  memo: string,
) {
  if (
    !Number.isSafeInteger(newBalance) ||
    newBalance < 0 ||
    newBalance > 999_999_999_999
  )
    throw new Error("0円以上の残高を入力してください。");
  if (date !== todayJST())
    throw new Error("残高の確認日は今日にしてください。");
  const data = await readAppData(),
    previous = calculateAccountBalance(data, account, date);
  const now = new Date().toISOString();
  await db.transaction("rw", db.accounts, db.accountAdjustments, async () => {
    await db.accounts.update(account.id, {
      snapshotBalance: newBalance,
      balanceAsOf: date,
      snapshotRecordedAt: now,
      updatedAt: now,
    });
    await db.accountAdjustments.add({
      ...stamp(),
      accountId: account.id,
      previousBalance: previous ?? newBalance,
      newBalance,
      date,
      memo,
    });
  });
}
export const accountPresets: { name: string; kind: Account["kind"] }[] = [
  { name: "横浜銀行", kind: "BANK" },
  { name: "三菱UFJ銀行", kind: "BANK" },
  { name: "現金", kind: "CASH" },
  { name: "Suica", kind: "EWALLET" },
  { name: "PayPay", kind: "EWALLET" },
  { name: "三井住友カード", kind: "CREDIT_CARD" },
  { name: "三菱UFJ系カード", kind: "CREDIT_CARD" },
];
export const fixedCostCandidates = [
  { name: "UNICEF", amount: 1000 },
  { name: "ChatGPT Plus", amount: 3000 },
  { name: "Gmail Plus", amount: 290 },
  { name: "Spotify", amount: 1000 },
  { name: "ジム", amount: 4378 },
];

/** Explicit account mapping avoids adding an already managed bank balance a second time. */
export async function mergeFinancialAccount(
  importedId: string,
  existingId: string,
) {
  await db.transaction("rw", db.tables, async () => {
    const imported = await db.accounts.get(importedId),
      existing = await db.accounts.get(existingId);
    if (
      !imported?.connectionId ||
      !existing ||
      imported.id === existing.id ||
      existing.connectionId ||
      existing.kind !== imported.kind
    )
      throw new Error("同じ種類の手動口座を選んでください。");
    await db.accounts.put({
      ...existing,
      ...imported,
      id: existing.id,
      name: existing.name,
      createdAt: existing.createdAt,
      creditCardId: existing.creditCardId ?? imported.creditCardId,
    });
    for (const table of [
      db.expenses,
      db.incomes,
      db.cardPayments,
      db.repayments,
      db.savingsContributions,
      db.recurringExpenses,
      db.favorites,
    ]) {
      for (const row of await table.toArray())
        if (row.sourceAccountId === importedId)
          await table.update(row.id, { sourceAccountId: existingId });
    }
    for (const table of [
      db.externalTransactions,
      db.salaryRules,
      db.accountAdjustments,
    ])
      for (const row of await table.toArray())
        if (row.accountId === importedId)
          await table.update(row.id, { accountId: existingId });
    for (const row of await db.transfers.toArray())
      if (row.fromAccountId === importedId || row.toAccountId === importedId)
        await db.transfers.update(row.id, {
          fromAccountId:
            row.fromAccountId === importedId ? existingId : row.fromAccountId,
          toAccountId:
            row.toAccountId === importedId ? existingId : row.toAccountId,
        });
    await db.accounts.delete(importedId);
    await db.financialAudits.add({
      ...stamp(),
      action: "account-mapped",
      recordId: existingId,
      detail: "利用者が既存の口座と取得口座を同じ口座として確認",
    });
  });
}
