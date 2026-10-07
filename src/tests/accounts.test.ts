import { describe, expect, it } from "vitest";
import type { Account, AppData, Expense, Transfer } from "../types";
import { defaultCategories, defaultSettings } from "../db";
import {
  calculateAccountBalance,
  getAccountBalances,
  getAccountTotals,
  previewTransfer,
  validateTransfer,
} from "../domain/accounts";
import { computeFinance } from "../domain/finance";

const day = "2026-10-20";
const initial = "2026-10-10T00:00:00+09:00";
const stamped = {
  createdAt: "2026-10-20T12:00:00+09:00",
  updatedAt: "2026-10-20T12:00:00+09:00",
};
function account(
  id: string,
  kind: Account["kind"],
  balance: number | null,
  overrides: Partial<Account> = {},
): Account {
  return {
    id,
    name: id,
    kind,
    institutionName: "テスト金融機関",
    currency: "JPY",
    snapshotBalance: balance,
    balanceAsOf: "2026-10-10",
    snapshotRecordedAt: initial,
    balanceSource: "manual",
    isSpendable: kind !== "SAVINGS" && kind !== "CREDIT_CARD",
    isActive: true,
    automationLevel: "manual",
    createdAt: initial,
    updatedAt: initial,
    ...overrides,
  };
}
function data(accounts: Account[]): AppData {
  return {
    accounts,
    transfers: [],
    externalTransactions: [],
    expenses: [],
    incomes: [],
    cards: [],
    cardPayments: [],
    debts: [],
    repayments: [],
    recurringExpenses: [],
    recurringOccurrences: [],
    savingsGoals: [],
    savingsContributions: [],
    budgets: [],
    settings: {
      ...defaultSettings,
      openingLiquidBalance: 77777,
      financialAutomationEnabled: true,
      budgetCycle: { mode: "salary", startDay: 10 },
    },
    merchantRules: [],
    categories: defaultCategories,
    balanceAdjustments: [],
    dailyCheckIns: [],
    favorites: [],
  };
}
function transfer(
  from: string,
  to: string,
  amount: number,
  overrides: Partial<Transfer> = {},
): Transfer {
  return {
    ...stamped,
    id: "move",
    fromAccountId: from,
    toAccountId: to,
    amount,
    date: day,
    memo: "",
    status: "confirmed",
    ...overrides,
  };
}
function expense(
  sourceAccountId: string,
  amount: number,
  overrides: Partial<Expense> = {},
): Expense {
  return {
    ...stamped,
    id: "spent",
    sourceAccountId,
    amount,
    date: day,
    merchant: "テスト店舗",
    description: "",
    categoryId: "food",
    subcategoryId: "food-0",
    paymentMethod: "cash",
    memo: "",
    isFixedCost: false,
    ...overrides,
  };
}
describe("account snapshots and transfer ledger", () => {
  it("income is recorded once and a later bank transfer does not become expense or another income", () => {
    const app = data([
      account("salary-bank", "BANK", 0),
      account("main-bank", "BANK", 0),
    ]);
    app.incomes.push({
      ...stamped,
      id: "salary",
      sourceAccountId: "salary-bank",
      amount: 19842,
      date: day,
      source: "アルバイト給与",
      memo: "",
      type: "salary",
    });
    app.transfers!.push(transfer("salary-bank", "main-bank", 19000));
    app.settings.salarySchedule = {
      payday: 10,
      expectedAmount: 20000,
      variableIncome: true,
    };
    expect(calculateAccountBalance(app, "salary-bank", day)).toBe(842);
    expect(calculateAccountBalance(app, "main-bank", day)).toBe(19000);
    expect(computeFinance(app, day)).toMatchObject({
      liquidBalance: 19842,
      safeToSpend: 19842,
      periodIncomeTotal: 19842,
      periodExpenseTotal: 0,
    });
  });
  it("ATM withdrawal relocates assets and only the cash purchase reduces assets and expense", () => {
    const app = data([
      account("bank", "BANK", 10000),
      account("cash", "CASH", 0),
    ]);
    app.transfers!.push(transfer("bank", "cash", 10000));
    expect(getAccountTotals(app, day)).toMatchObject({
      totalAssets: 10000,
      spendableAssets: 10000,
    });
    app.expenses.push(expense("cash", 850));
    expect(calculateAccountBalance(app, "cash", day)).toBe(9150);
    expect(computeFinance(app, day)).toMatchObject({
      safeToSpend: 9150,
      periodExpenseTotal: 850,
      periodIncomeTotal: 0,
    });
  });
  it("bank wallet charges preserve assets and wallet purchases are consumed once", () => {
    const app = data([
      account("bank", "BANK", 10000),
      account("suica", "EWALLET", 0),
      account("wallet", "EWALLET", 0),
    ]);
    app.transfers!.push(
      transfer("bank", "suica", 3000),
      transfer("bank", "wallet", 5000, { id: "charge-2" }),
    );
    expect(getAccountTotals(app, day).totalAssets).toBe(10000);
    app.expenses.push(
      expense("suica", 500),
      expense("wallet", 800, { id: "spent-2" }),
    );
    expect(calculateAccountBalance(app, "suica", day)).toBe(2500);
    expect(calculateAccountBalance(app, "wallet", day)).toBe(4200);
    expect(computeFinance(app, day)).toMatchObject({
      safeToSpend: 8700,
      periodExpenseTotal: 1300,
    });
  });
  it("card top-up increases wallet assets and liabilities equally; settlement is not a second expense", () => {
    const app = data([
      account("bank", "BANK", 10000),
      account("card", "CREDIT_CARD", 0),
      account("suica", "EWALLET", 0),
    ]);
    app.transfers!.push(transfer("card", "suica", 3000));
    expect(computeFinance(app, day)).toMatchObject({
      liquidBalance: 13000,
      cardOutstanding: 3000,
      safeToSpend: 10000,
      periodExpenseTotal: 0,
    });
    app.expenses.push(expense("suica", 500));
    app.transfers!.push(transfer("bank", "card", 3000, { id: "settlement" }));
    expect(computeFinance(app, day)).toMatchObject({
      liquidBalance: 9500,
      cardOutstanding: 0,
      safeToSpend: 9500,
      periodExpenseTotal: 500,
    });
  });
  it("provider balances are authoritative, even when history and transfers are loaded later", () => {
    const app = data([
      account("bank", "BANK", 7000, { balanceSource: "provider" }),
      account("cash", "CASH", 0),
    ]);
    app.expenses.push(
      expense("bank", 500, { providerId: "mock", balanceEffect: "snapshot" }),
    );
    app.incomes.push({
      ...stamped,
      id: "income",
      sourceAccountId: "bank",
      amount: 10000,
      date: day,
      source: "給与",
      memo: "",
      type: "salary",
      balanceEffect: "snapshot",
    });
    app.transfers!.push(
      transfer("bank", "cash", 3000, {
        fromBalanceEffect: "snapshot",
        toBalanceEffect: "ledger",
      }),
    );
    expect(calculateAccountBalance(app, "bank", day)).toBe(7000);
    expect(calculateAccountBalance(app, "cash", day)).toBe(3000);
    expect(computeFinance(app, day)).toMatchObject({
      liquidBalance: 10000,
      periodIncomeTotal: 10000,
      periodExpenseTotal: 500,
    });
  });
  it("a provider liability replaces, rather than adds to, the legacy card ledger", () => {
    const app = data([
      account("cash", "CASH", 10000),
      account("card-account", "CREDIT_CARD", 1200, {
        creditCardId: "legacy-card",
        balanceSource: "provider",
      }),
    ]);
    app.cards.push({
      ...stamped,
      id: "legacy-card",
      name: "カード",
      last4: "",
      closingDay: 31,
      paymentDay: 10,
      paymentMonthOffset: 1,
      openingOutstanding: 0,
      isActive: true,
    });
    app.expenses.push(
      expense("card-account", 1200, {
        paymentMethod: "creditCard",
        creditCardId: "legacy-card",
        balanceEffect: "snapshot",
      }),
    );
    expect(computeFinance(app, day)).toMatchObject({
      cardOutstanding: 1200,
      safeToSpend: 8800,
      reconciliationAlerts: [],
    });
    app.accounts![1].snapshotBalance = 1400;
    expect(computeFinance(app, day)).toMatchObject({
      cardOutstanding: 1400,
      safeToSpend: 8600,
      reconciliationAlerts: [{ difference: 200 }],
    });
  });
  it("explicit uncovered pending card spending stays reserved and posted snapshot values do not repeat it", () => {
    const app = data([
      account("cash", "CASH", 10000),
      account("card", "CREDIT_CARD", 2000, {
        balanceSource: "provider",
        balanceAsOf: "2026-10-19",
        snapshotRecordedAt: "2026-10-19T12:00:00+09:00",
      }),
    ]);
    app.expenses.push(
      expense("card", 1000, {
        paymentMethod: "creditCard",
        pendingStatus: "pending",
        balanceEffect: "ledger",
      }),
    );
    expect(computeFinance(app, day).cardOutstanding).toBe(3000);
    // A newer provider snapshot with no imported authorization must not release the reserve.
    app.accounts![1].balanceAsOf = day;
    app.accounts![1].snapshotRecordedAt = "2026-10-20T13:00:00+09:00";
    expect(computeFinance(app, day)).toMatchObject({
      cardOutstanding: 3000,
      safeToSpend: 7000,
    });
    // A user-entered current card balance does include old hand-entered spending.
    app.accounts![1].balanceSource = "manual";
    app.accounts![1].snapshotBalance = 3000;
    expect(computeFinance(app, day).cardOutstanding).toBe(3000);
    app.accounts![1].balanceSource = "provider";
    app.expenses[0] = {
      ...app.expenses[0],
      amount: 1120,
      pendingStatus: "posted",
      balanceEffect: "snapshot",
    };
    app.accounts![1].snapshotBalance = 3120;
    app.accounts![1].snapshotRecordedAt = "2026-10-20T14:00:00+09:00";
    expect(computeFinance(app, day)).toMatchObject({
      cardOutstanding: 3120,
      safeToSpend: 6880,
      periodExpenseTotal: 1120,
    });
  });
  it("old liabilities without an account remain reserved", () => {
    const app = data([account("cash", "CASH", 10000)]);
    app.cards.push({
      ...stamped,
      id: "old-card",
      name: "カード",
      last4: "",
      closingDay: 31,
      paymentDay: 10,
      paymentMonthOffset: 1,
      openingOutstanding: 2500,
      isActive: false,
    });
    expect(computeFinance(app, day)).toMatchObject({
      cardOutstanding: 2500,
      safeToSpend: 7500,
    });
  });
  it("unknown balances and new unallocated activity prevent a fabricated safe amount", () => {
    expect(computeFinance(data([]), day).safeToSpend).toBeNull();
    const app = data([account("cash", "CASH", null)]);
    expect(computeFinance(app, day).safeToSpend).toBeNull();
    app.accounts![0].snapshotBalance = 10000;
    app.expenses.push(expense("", 500));
    expect(computeFinance(app, day)).toMatchObject({
      safeToSpend: null,
      unallocatedRecordIds: ["spent"],
    });
    app.expenses[0].sourceAccountId = "cash";
    expect(computeFinance(app, day).safeToSpend).toBe(9500);
    app.accounts!.push(account("card", "CREDIT_CARD", null));
    expect(computeFinance(app, day)).toMatchObject({
      liquidBalance: 9500,
      safeToSpend: null,
    });
  });
  it("never adds a legacy aggregate to individual bank balances", () => {
    const app = data([
      account("legacy-liquid", "OTHER", 10000),
      account("bank", "BANK", 7000),
    ]);
    expect(computeFinance(app, day)).toMatchObject({
      safeToSpend: null,
      accountingWarnings: ["既存の合計残高を口座ごとに分けてください。"],
    });
    app.accounts![0].isActive = false;
    expect(computeFinance(app, day).safeToSpend).toBe(7000);
  });
  it("cash snapshot covers existing activity but permits a later same-day purchase", () => {
    const app = data([
      account("cash", "CASH", 10000, {
        balanceAsOf: day,
        snapshotRecordedAt: "2026-10-20T10:00:00+09:00",
      }),
    ]);
    app.expenses.push(
      expense("cash", 300, { createdAt: "2026-10-20T09:00:00+09:00" }),
    );
    app.expenses.push(
      expense("cash", 850, {
        id: "later",
        createdAt: "2026-10-20T12:00:00+09:00",
      }),
    );
    expect(calculateAccountBalance(app, "cash", day)).toBe(9150);
    app.expenses.push(
      expense("cash", 2000, { id: "future", date: "2026-10-21" }),
    );
    expect(calculateAccountBalance(app, "cash", day)).toBe(9150);
    expect(calculateAccountBalance(app, "cash", "2026-10-19")).toBeNull();
  });
  it("a reversed transfer and previews never change persisted financial records", () => {
    const app = data([
      account("bank", "BANK", 10000),
      account("cash", "CASH", 0),
    ]);
    const move = transfer("bank", "cash", 3000);
    const before = structuredClone(app);
    expect(previewTransfer(app, move, day)).toMatchObject({
      fromAfter: 7000,
      toAfter: 3000,
    });
    expect(app).toEqual(before);
    app.transfers!.push({ ...move, status: "reversed" });
    expect(calculateAccountBalance(app, "bank", day)).toBe(10000);
    expect(() =>
      validateTransfer({ ...move, toAccountId: "bank" }, app.accounts!),
    ).toThrow();
    expect(() =>
      validateTransfer({ ...move, amount: -1 }, app.accounts!),
    ).toThrow();
  });
  it("uses 24 actual hours for an explicitly selected one-day verification interval", () => {
    const app = data([
      account("bank", "BANK", 100, {
        balanceSource: "provider",
        verificationDays: 1,
        snapshotRecordedAt: "2026-10-19T12:00:00+09:00",
      }),
    ]);
    expect(
      getAccountBalances(app, day, "2026-10-20T11:59:59+09:00")[0].isStale,
    ).toBe(false);
    expect(
      getAccountBalances(app, day, "2026-10-20T12:00:01+09:00")[0].isStale,
    ).toBe(true);
  });
  it("transfer preview holds the covered provider side and applies only the later manual side", () => {
    const app = data([
      account("bank", "BANK", 7000, { balanceSource: "provider" }),
      account("cash", "CASH", 1000),
    ]);
    const before = structuredClone(app);
    const move = transfer("bank", "cash", 3000, {
      fromBalanceEffect: "snapshot",
      toBalanceEffect: "ledger",
    });
    expect(previewTransfer(app, move, day)).toMatchObject({
      fromBefore: 7000,
      fromAfter: 7000,
      toBefore: 1000,
      toAfter: 4000,
    });
    expect(app).toEqual(before);
    expect(
      previewTransfer(app, { ...move, status: "reversed" }, day),
    ).toMatchObject({ fromAfter: 7000, toAfter: 1000 });
    expect(
      previewTransfer(app, { ...move, date: "2026-10-09" }, day),
    ).toMatchObject({ fromAfter: 7000, toAfter: 1000 });
  });
  it("dates a refund as a spending correction, without income or another provider balance adjustment", () => {
    const app = data([
      account("bank", "BANK", 10000, { balanceSource: "provider" }),
    ]);
    app.expenses.push(
      expense("bank", 1500, { balanceEffect: "snapshot", date: "2026-10-19" }),
    );
    app.externalTransactions!.push({
      ...stamped,
      id: "refund",
      providerId: "mock",
      connectionId: "connection",
      externalTransactionId: "refund-1",
      externalAccountId: "bank",
      accountId: "bank",
      date: day,
      amount: 500,
      description: "一部返金",
      currency: "JPY",
      pendingStatus: "posted",
      externalUpdatedAt: stamped.updatedAt,
      kind: "refund",
      relatedExpenseId: "spent",
      balanceEffect: "snapshot",
    });
    expect(computeFinance(app, "2026-10-19")).toMatchObject({
      liquidBalance: 10000,
      periodExpenseTotal: 1500,
      periodIncomeTotal: 0,
    });
    expect(computeFinance(app, day)).toMatchObject({
      liquidBalance: 10000,
      periodExpenseTotal: 1000,
      monthlyExpenseTotal: 1000,
      periodIncomeTotal: 0,
    });
  });
  it("conserves total assets for asset transfers and net assets for card-funded top-ups over many amounts", () => {
    for (const amount of [1, 100, 500, 999, 10000, 999999]) {
      const app = data([
        account("bank", "BANK", 1000000),
        account("wallet", "EWALLET", 0),
        account("card", "CREDIT_CARD", 0),
      ]);
      app.transfers!.push(transfer("bank", "wallet", amount));
      expect(getAccountTotals(app, day).totalAssets).toBe(1000000);
      expect(computeFinance(app, day).periodExpenseTotal).toBe(0);
      app.transfers!.push(transfer("card", "wallet", amount, { id: "credit" }));
      const summary = computeFinance(app, day);
      expect(summary.totalAssets! - summary.cardOutstanding).toBe(1000000);
      expect(summary.safeToSpend).toBe(1000000);
    }
  });
  it("a positive card refund lowers liability once and never becomes salary income", () => {
    const app = data([
      account("bank", "BANK", 10000),
      account("card", "CREDIT_CARD", 1500, { balanceSource: "provider" }),
    ]);
    app.expenses.push(
      expense("card", 1500, {
        paymentMethod: "creditCard",
        balanceEffect: "snapshot",
      }),
    );
    app.externalTransactions!.push({
      ...stamped,
      id: "card-refund",
      providerId: "mock",
      connectionId: "connection",
      externalTransactionId: "card-refund-1",
      externalAccountId: "card",
      accountId: "card",
      date: day,
      amount: 500,
      description: "一部返金",
      currency: "JPY",
      pendingStatus: "posted",
      externalUpdatedAt: stamped.updatedAt,
      kind: "refund",
      relatedExpenseId: "spent",
      balanceEffect: "ledger",
    });
    expect(computeFinance(app, day)).toMatchObject({
      cardOutstanding: 1000,
      safeToSpend: 9000,
      periodExpenseTotal: 1000,
      periodIncomeTotal: 0,
    });
    app.accounts![1].snapshotBalance = 1000;
    app.accounts![1].balanceAsOf = day;
    app.accounts![1].snapshotRecordedAt = "2026-10-20T13:00:00+09:00";
    app.externalTransactions![0].balanceEffect = "snapshot";
    expect(computeFinance(app, day)).toMatchObject({
      cardOutstanding: 1000,
      safeToSpend: 9000,
      periodExpenseTotal: 1000,
      periodIncomeTotal: 0,
    });
  });
});
