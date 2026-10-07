import { describe, expect, it } from "vitest";
import {
  moneyAllocation,
  previewPurchase,
  type FinanceSummary,
} from "../domain/spendingPreview";
import { getBudgetCycle } from "../domain/budgetCycle";
const summary = (values: Partial<FinanceSummary> = {}): FinanceSummary => ({
  liquidBalance: 12000,
  cardOutstanding: 2000,
  upcomingFixedCosts: 3000,
  debtReserve: 1000,
  savingsReserve: 1000,
  safeToSpend: 5000,
  monthlyBudgetRemaining: 4000,
  monthlyBudget: 10000,
  monthlyExpenseTotal: 6000,
  monthlyIncomeTotal: 12000,
  todaySpent: 300,
  dailyAllowance: 1000,
  todayRemaining: 700,
  todayDiscretionarySpent: 300,
  tomorrowAllowance: 1000,
  overspentToday: 0,
  cycle: getBudgetCycle("2026-09-27"),
  periodExpenseTotal: 6000,
  periodIncomeTotal: 12000,
  periodBudget: 10000,
  periodBudgetRemaining: 4000,
  accountBalances: [],
  totalAssets: 12000,
  lastFinancialUpdatedAt: null,
  financialDataIsStale: false,
  balanceConfidence: 'high',
  unknownAccountIds: [],
  unallocatedRecordIds: [],
  accountingWarnings: [],
  reconciliationAlerts: [],
  recurringDue: [],
  pace: { label: "", ratio: 1, budgetProgress: 0.6, timeProgress: 0.6 },
  ...values,
});
describe("additional purchase preview", () => {
  it("subtracts a new purchase once and uses the smaller budget allowance for future days without mutation", () => {
    const f = summary();
    const before = structuredClone(f);
    expect(previewPurchase(f, 1000, "2026-09-27")).toMatchObject({
      safeAfter: 4000,
      shortage: 0,
      budgetAfter: 3000,
      daysAfterToday: 3,
      tomorrowAllowance: 1000,
    });
    expect(f).toEqual(before);
  });
  it("keeps unknown balances unknown", () => {
    expect(
      previewPurchase(
        summary({ safeToSpend: null, liquidBalance: null }),
        1000,
        "2026-09-27",
      ),
    ).toBeNull();
  });
  it("reports a shortage and an exceeded budget independently", () => {
    expect(previewPurchase(summary(), 6000, "2026-09-27")).toMatchObject({
      safeAfter: -1000,
      shortage: 1000,
      budgetAfter: -2000,
      tomorrowAllowance: 0,
    });
    expect(
      previewPurchase(
        summary({ monthlyBudgetRemaining: 500 }),
        1000,
        "2026-09-27",
      ),
    ).toMatchObject({
      safeAfter: 4000,
      shortage: 0,
      budgetAfter: -500,
      tomorrowAllowance: 0,
    });
  });
  it("never divides by zero on the last day and respects leap-day boundaries", () => {
    expect(
      previewPurchase(summary(), 0, "2028-02-29")?.tomorrowAllowance,
    ).toBeNull();
    expect(
      previewPurchase(
        summary({ monthlyBudgetRemaining: null }),
        0,
        "2028-02-28",
      )?.tomorrowAllowance,
    ).toBe(5000);
  });
  it.each([-1, NaN, Infinity, 0.5, 1000000000000])(
    "rejects invalid amount %s",
    (amount) => {
      expect(() => previewPurchase(summary(), amount, "2026-09-27")).toThrow();
    },
  );
  it("keeps allocation within the actual balance when commitments exceed available money", () => {
    expect(moneyAllocation(summary())).toEqual({
      free: 5000,
      reserved: 7000,
      freeRatio: 5000 / 12000,
    });
    expect(moneyAllocation(summary({ safeToSpend: -1000 }))).toEqual({
      free: 0,
      reserved: 12000,
      freeRatio: 0,
    });
    expect(
      moneyAllocation(summary({ liquidBalance: 0, safeToSpend: 0 })),
    ).toEqual({ free: 0, reserved: 0, freeRatio: 0 });
    expect(
      moneyAllocation(summary({ liquidBalance: null, safeToSpend: null })),
    ).toBeNull();
  });
});
