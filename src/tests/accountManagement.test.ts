import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { db, defaultSettings, readAppData } from "../db";
import { enableAccountManagement } from "../domain/financialActions";
import { calculateLiquidBalance } from "../domain/finance";
import { addDaysDate, todayJST } from "../domain/dates";
import { initializeVault } from "../domain/vault";

const today = todayJST();
const recordedAt = new Date().toISOString();

beforeAll(async () => {
  await db.delete();
  await db.open();
  await initializeVault("fictional account management vault phrase");
}, 15_000);

beforeEach(async () => {
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables)
      if (table.name !== "vaultMeta") await table.clear();
  });
  await db.settings.put(structuredClone(defaultSettings));
});

afterAll(async () => {
  db.close();
  await db.delete();
});

it("keeps a chosen salary budget period separate from the expected payday", async () => {
  const cycle = { mode: "salary" as const, startDay: 25 };
  const salary = { payday: 10, expectedAmount: 180_000, variableIncome: false };
  await db.settings.update("main", {
    budgetCycle: cycle,
    salarySchedule: salary,
  });

  await enableAccountManagement();

  const data = await readAppData();
  expect(data.settings.budgetCycle).toEqual(cycle);
  expect(data.settings.salarySchedule).toEqual(salary);
  expect(data.settings.financialAutomationEnabled).toBe(true);
  expect(data.accounts).toHaveLength(0);
});

it("preserves a chosen calendar-month period when individual accounts are enabled", async () => {
  const cycle = { mode: "calendar" as const, startDay: 1 };
  await db.settings.update("main", {
    budgetCycle: cycle,
    openingLiquidBalance: 8_500,
  });

  await enableAccountManagement();

  const data = await readAppData();
  expect(data.settings.budgetCycle).toEqual(cycle);
  expect(calculateLiquidBalance(data, today)).toBe(8_500);
  expect(data.accounts).toHaveLength(1);
});

it("defaults to the calendar month and carries the actual legacy balance once", async () => {
  await db.settings.update("main", { openingLiquidBalance: 10_000 });
  await db.incomes.put({
    id: "fictional-income",
    createdAt: recordedAt,
    updatedAt: recordedAt,
    amount: 2_000,
    date: today,
    source: "架空の入金",
    memo: "検証専用",
    type: "temporary",
  });
  await db.cards.put({
    id: "fictional-card",
    createdAt: recordedAt,
    updatedAt: recordedAt,
    name: "架空カード",
    last4: "0000",
    closingDay: 15,
    paymentDay: 27,
    paymentMonthOffset: 1,
    openingOutstanding: 0,
    isActive: true,
  });
  const expense = {
    id: "fictional-paid-expense",
    createdAt: recordedAt,
    updatedAt: recordedAt,
    amount: 500,
    date: today,
    merchant: "架空の店",
    description: "",
    categoryId: "uncategorized",
    subcategoryId: "",
    paymentMethod: "cash" as const,
    memo: "検証専用",
    isFixedCost: false,
  };
  await db.expenses.bulkPut([
    expense,
    {
      ...expense,
      id: "fictional-future-expense",
      date: addDaysDate(today, 1),
      amount: 1_000,
    },
    {
      ...expense,
      id: "fictional-unpaid-card",
      paymentMethod: "creditCard",
      creditCardId: "fictional-card",
      amount: 750,
    },
  ]);
  const before = await readAppData();
  expect(before.settings.budgetCycle).toBeUndefined();
  expect(calculateLiquidBalance(before, today)).toBe(11_500);

  await enableAccountManagement();
  const after = await readAppData();
  expect(after.settings.budgetCycle).toEqual({ mode: "calendar", startDay: 1 });
  expect(after.accounts).toHaveLength(1);
  expect(after.accounts?.[0]).toMatchObject({
    id: "legacy-liquid",
    balanceSource: "manual",
    snapshotBalance: 11_500,
    balanceAsOf: today,
  });
  expect(calculateLiquidBalance(after, today)).toBe(11_500);
  expect(after.expenses).toEqual(before.expenses);
  expect(after.incomes).toEqual(before.incomes);

  await enableAccountManagement();
  const again = await readAppData();
  expect(again.accounts).toEqual(after.accounts);
  expect(again.settings).toEqual(after.settings);
  expect(calculateLiquidBalance(again, today)).toBe(11_500);
});
