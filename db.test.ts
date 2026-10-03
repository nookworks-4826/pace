import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllData,
  db,
  defaultCategories,
  deleteExpense,
  findDuplicateExpenses,
  initializeDb,
  readAppData,
  reconcileLiquidBalance,
  restoreAppData,
  saveExpense,
  updateSettings,
} from "../db";
import type { Expense } from "../types";
import { computeFinance } from "../domain/finance";
import { validateData } from "../domain/backup/schema";
import {
  getVaultStatus,
  initializeVault,
  lockVault,
  unlockVault,
} from "../domain/vault";

const stamped = {
  createdAt: "2026-09-24T12:00:00+09:00",
  updatedAt: "2026-09-24T12:00:00+09:00",
};
function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    ...stamped,
    id: "expense",
    amount: 1280,
    date: "2026-09-24",
    merchant: "サイゼリヤ",
    description: "",
    categoryId: "food",
    subcategoryId: "food-0",
    paymentMethod: "cash",
    memo: "",
    isFixedCost: false,
    ...overrides,
  };
}
beforeEach(async () => {
  await initializeDb();
  await clearAllData();
});
afterAll(() => db.close());

describe("IndexedDB persistence and atomic mutation", () => {
  it("keeps unfinished financial drafts in IndexedDB and clears them on restore", async () => {
    await db.drafts.put({
      id: "expense",
      value: JSON.stringify({ amount: "680", merchant: "カフェ" }),
    });
    expect((await db.drafts.get("expense"))?.value).toContain("680");
    const snapshot = await readAppData();
    expect("drafts" in snapshot).toBe(false);
    await restoreAppData(snapshot);
    expect(await db.drafts.count()).toBe(0);
  });
  it("starts without fabricated money and seeds all categories once", async () => {
    await initializeDb();
    const data = await readAppData();
    expect(data.settings.openingLiquidBalance).toBeNull();
    expect(data.categories).toHaveLength(defaultCategories.length);
    expect(data.expenses).toHaveLength(0);
  });
  it("saves the expense and learning together, then edits without duplicating it", async () => {
    await saveExpense(expense());
    expect(await db.expenses.count()).toBe(1);
    expect(await db.merchantRules.get("サイゼリヤ")).toMatchObject({
      categoryId: "food",
      subcategoryId: "food-0",
    });
    await saveExpense(
      expense({
        categoryId: "social",
        subcategoryId: "social-0",
        amount: 1400,
      }),
    );
    expect(await db.expenses.count()).toBe(1);
    expect(await db.merchantRules.get("サイゼリヤ")).toMatchObject({
      categoryId: "social",
      subcategoryId: "social-0",
      usageCount: 2,
    });
    const snapshot = await readAppData();
    expect(validateData(snapshot)).toEqual(snapshot);
  });
  it("fails invalid card references without partially saving learning", async () => {
    await expect(
      saveExpense(
        expense({ paymentMethod: "creditCard", creditCardId: "missing" }),
      ),
    ).rejects.toThrow("カード");
    expect(await db.expenses.count()).toBe(0);
    expect(await db.merchantRules.count()).toBe(0);
  });
  it("confirms a fresh fixed occurrence atomically and prevents a second expense for it", async () => {
    await db.recurringExpenses.add({
      id: "fixed",
      name: "通信",
      amount: 1280,
      categoryId: "fixed",
      subcategoryId: "fixed-0",
      paymentMethod: "bank",
      frequency: "monthly",
      dueDay: 27,
      startDate: "2026-09-01",
      isActive: true,
      note: "",
    });
    const row = expense({
      isFixedCost: true,
      recurringOccurrenceId: "fixed:2026-09",
    });
    await saveExpense(row);
    expect(await db.recurringOccurrences.get("fixed:2026-09")).toMatchObject({
      status: "paid",
      dueDate: "2026-09-27",
      expenseId: row.id,
    });
    await expect(saveExpense({ ...row, id: "second" })).rejects.toThrow(
      "すでに記録",
    );
    expect(await db.expenses.count()).toBe(1);
    expect(
      computeFinance(await readAppData(), "2026-09-24").upcomingFixedCosts,
    ).toBe(0);
    const removed = await deleteExpense(row.id);
    expect(await db.recurringOccurrences.count()).toBe(0);
    expect(
      computeFinance(await readAppData(), "2026-09-24").upcomingFixedCosts,
    ).toBe(1280);
    validateData(await readAppData());
    await saveExpense(removed!); // The same API provides a full Undo.
    expect(await db.recurringOccurrences.count()).toBe(1);
    validateData(await readAppData());
  });
  it("duplicate warnings use normalized merchants and the five-minute window", () => {
    expect(
      findDuplicateExpenses(
        expense({
          id: "new",
          merchant: "株式会社 サイゼリヤ",
          createdAt: "2026-09-24T12:03:00+09:00",
        }),
        [expense()],
      ),
    ).toHaveLength(1);
    expect(
      findDuplicateExpenses(
        expense({ id: "new", createdAt: "2026-09-24T12:06:00+09:00" }),
        [expense()],
      ),
    ).toHaveLength(0);
  });
  it("backup snapshot survives clear and restore with identical accounting", async () => {
    await updateSettings({ openingLiquidBalance: 30000 });
    await saveExpense(expense());
    const snapshot = await readAppData();
    const before = computeFinance(snapshot, "2026-09-24");
    await clearAllData();
    expect((await readAppData()).expenses).toHaveLength(0);
    await restoreAppData(snapshot);
    expect(await readAppData()).toEqual(snapshot);
    expect(computeFinance(await readAppData(), "2026-09-24")).toEqual(before);
  });
  it("rolls back the entire restore if a row fails validation", async () => {
    await updateSettings({ openingLiquidBalance: 30000 });
    await saveExpense(expense());
    const original = await readAppData();
    const invalid = structuredClone(original);
    invalid.expenses.push(expense({ id: "invalid", amount: -20 }));
    await expect(restoreAppData(invalid)).rejects.toThrow();
    expect(await readAppData()).toEqual(original);
  });
  it("database hooks reject negative, zero and fractional actual amounts", async () => {
    for (const amount of [-1, 0, 0.1])
      await expect(db.expenses.add(expense({ amount }))).rejects.toThrow();
    expect(await db.expenses.count()).toBe(0);
  });
  it("allows a deliberate zero monthly budget", async () => {
    await db.budgets.add({
      ...stamped,
      id: "zero",
      year: 2026,
      month: 9,
      totalBudget: 0,
      categoryBudgets: {},
    });
    await updateSettings({ openingLiquidBalance: 30000 });
    expect(computeFinance(await readAppData(), "2026-09-24")).toMatchObject({
      monthlyBudget: 0,
      dailyAllowance: 0,
    });
    validateData(await readAppData());
  });
  it("card-to-cash edits and deletion leave a snapshot that can still be backed up", async () => {
    await db.cards.add({
      ...stamped,
      id: "card",
      name: "Visa",
      last4: "1234",
      closingDay: 15,
      paymentDay: 27,
      paymentMonthOffset: 1,
      openingOutstanding: 0,
      isActive: true,
    });
    await saveExpense(
      expense({ paymentMethod: "creditCard", creditCardId: "card" }),
    );
    await db.cardPayments.add({
      ...stamped,
      id: "payment",
      creditCardId: "card",
      amount: 1280,
      date: "2026-09-24",
      memo: "",
    });
    await saveExpense(expense({ paymentMethod: "cash" }));
    validateData(await readAppData());
    await deleteExpense("expense");
    validateData(await readAppData());
  });
  it("reconciles current money correctly after initial balance was skipped and expenses already exist", async () => {
    await saveExpense(expense());
    expect(
      computeFinance(await readAppData(), "2026-09-24").liquidBalance,
    ).toBeNull();
    await reconcileLiquidBalance(30000, "2026-09-24", "初めて残高を確認");
    const data = await readAppData();
    expect(computeFinance(data, "2026-09-24").liquidBalance).toBe(30000);
    expect(data.balanceAdjustments).toHaveLength(1);
    expect(data.balanceAdjustments[0]).toMatchObject({
      previousBalance: -1280,
      newBalance: 30000,
      difference: 31280,
    });
    await reconcileLiquidBalance(28000, "2026-09-24");
    expect(
      computeFinance(await readAppData(), "2026-09-24").liquidBalance,
    ).toBe(28000);
  });
  it("reconciles a lower real balance after income was entered without initial balance", async () => {
    await db.incomes.add({
      ...stamped,
      id: "salary",
      amount: 50000,
      date: "2026-09-24",
      source: "給与",
      memo: "",
      type: "salary",
    });
    await reconcileLiquidBalance(30000, "2026-09-24");
    expect(
      computeFinance(await readAppData(), "2026-09-24").liquidBalance,
    ).toBe(30000);
    expect((await db.settings.get("main"))?.openingLiquidBalance).toBe(0);
    expect((await db.balanceAdjustments.toArray())[0].difference).toBe(-20000);
  });
  it("restores expanded records with provider authorization disabled and no credentials", async () => {
    const data = await readAppData();
    data.financialConnections = [
      {
        ...stamped,
        id: "connection",
        providerId: "mock",
        status: "connected",
        institutionIds: [],
        consentedAt: stamped.createdAt,
      },
    ];
    data.syncStates = [
      {
        id: "connection",
        lastAttemptAt: stamped.createdAt,
        lastSuccessAt: stamped.createdAt,
        nextRefreshAllowedAt: null,
        status: "idle",
        message: "",
      },
    ];
    await restoreAppData(data);
    expect((await db.financialConnections.get("connection"))?.status).toBe(
      "disconnected",
    );
    expect((await db.syncStates.get("connection"))?.status).toBe(
      "reauthentication",
    );
    expect(await db.providerCredentials.count()).toBe(0);
    validateData(await readAppData());
  });
  it("deletes and restores imported expenses without orphaning receipts or recreating ignored imports", async () => {
    await db.financialConnections.put({
      ...stamped,
      id: "connection",
      providerId: "mock",
      status: "connected",
      institutionIds: [],
      consentedAt: stamped.createdAt,
    });
    await db.accounts.put({
      ...stamped,
      id: "account",
      name: "架空口座",
      kind: "BANK",
      institutionName: "",
      currency: "JPY",
      snapshotBalance: 30000,
      balanceAsOf: "2026-09-24",
      snapshotRecordedAt: stamped.createdAt,
      balanceSource: "provider",
      providerId: "mock",
      connectionId: "connection",
      externalAccountId: "bank",
      isSpendable: true,
      isActive: true,
      automationLevel: "automatic",
    });
    await db.receipts.put({
      ...stamped,
      id: "receipt",
      mimeType: "image/jpeg",
      imageBase64: "AA==",
    });
    const imported = expense({
      receiptId: "receipt",
      sourceAccountId: "account",
      providerId: "mock",
      connectionId: "connection",
      externalTransactionId: "external",
      balanceEffect: "snapshot",
    });
    await db.externalTransactions.put({
      ...stamped,
      id: "raw",
      providerId: "mock",
      connectionId: "connection",
      externalTransactionId: "external",
      externalAccountId: "bank",
      accountId: "account",
      date: imported.date,
      amount: -1280,
      description: "架空支出",
      currency: "JPY",
      pendingStatus: "posted",
      externalUpdatedAt: stamped.createdAt,
      kind: "unclassified",
    });
    await saveExpense(imported);
    validateData(await readAppData());
    const deleted = await deleteExpense(imported.id);
    expect((await db.externalTransactions.get("raw"))?.kind).toBe("ignored");
    expect((await db.receipts.get("receipt"))?.expenseId).toBeUndefined();
    validateData(await readAppData());
    await saveExpense(deleted!);
    expect(await db.externalTransactions.get("raw")).toMatchObject({
      kind: "expense",
      linkedRecordId: imported.id,
    });
    expect((await db.receipts.get("receipt"))?.expenseId).toBe(imported.id);
    validateData(await readAppData());
  });
  it("keeps full backup restore, learning and clear atomic inside the encrypted vault", async () => {
    await updateSettings({ openingLiquidBalance: 30000 });
    await saveExpense(expense());
    await db.drafts.put({
      id: "expense",
      value: "fictional unfinished amount",
    });
    await initializeVault("a separate test vault passphrase");
    await db.providerCredentials.bulkPut([
      { id: "moneytree:default", value: "fictional authorization" },
      { id: "moneytree:secondary", value: "fictional second authorization" },
    ]);
    const snapshot = await readAppData();
    const before = computeFinance(snapshot, "2026-09-24");
    const events: Event[] = [];
    const held = new Set<string>();
    const acquired: string[] = [];
    const target = new EventTarget();
    target.addEventListener("pace:financial-reset", (event) =>
      events.push(event),
    );
    vi.stubGlobal("window", target);
    vi.stubGlobal("navigator", {
      locks: {
        async request(name: string, action: () => Promise<unknown>) {
          acquired.push(name);
          held.add(name);
          try {
            return await action();
          } finally {
            held.delete(name);
          }
        },
      },
    });
    let writes = 0;
    const checkResetLock = () => {
      expect(events.length).toBeGreaterThan(0);
      expect(held.has("pace:moneytree:state:moneytree:default")).toBe(true);
      writes++;
    };
    db.settings.hook("creating", checkResetLock);
    try {
      await clearAllData();
      expect(await db.providerCredentials.count()).toBe(0);
      expect(await getVaultStatus()).toEqual({ enabled: true, unlocked: true });
      await restoreAppData(snapshot);
      expect(await db.providerCredentials.count()).toBe(0);
      expect(events.map((event) => event.type)).toEqual([
        "pace:financial-reset",
        "pace:financial-reset",
      ]);
      expect(events.every((event) => !("detail" in event))).toBe(true);
      expect(acquired).toEqual([
        "pace:moneytree:state:moneytree:default",
        "pace:moneytree:state:moneytree:secondary",
        "pace:moneytree:state:moneytree:default",
      ]);
      expect(writes).toBe(2);
      expect(held.size).toBe(0);
    } finally {
      db.settings.hook("creating").unsubscribe(checkResetLock);
      vi.unstubAllGlobals();
    }
    expect(computeFinance(await readAppData(), "2026-09-24")).toEqual(before);
    expect(await db.drafts.count()).toBe(0);
    expect((await db.merchantRules.get("サイゼリヤ"))?.categoryId).toBe("food");
    lockVault();
    await expect(readAppData()).rejects.toThrow("パスフレーズ");
    await unlockVault("a separate test vault passphrase");
    expect(computeFinance(await readAppData(), "2026-09-24")).toEqual(before);
  });
});
