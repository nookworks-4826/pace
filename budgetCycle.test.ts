import { describe, expect, it } from "vitest";
import {
  getBudgetCycle,
  getCycleBudgetMonth,
  isInBudgetCycle,
} from "../domain/budgetCycle";
import { computeFinance, nextDebtPayment } from "../domain/finance";
import { previewPurchase } from "../domain/spendingPreview";
import type { AppData, Debt, Expense } from "../types";
import { defaultCategories, defaultSettings } from "../db";

const salary = { mode: "salary" as const, startDay: 10 };
const stamped = {
  createdAt: "2026-10-10T00:00:00+09:00",
  updatedAt: "2026-10-10T00:00:00+09:00",
};
function fixture(): AppData {
  return {
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
      budgetCycle: salary,
      openingLiquidBalance: 31000,
    },
    merchantRules: [],
    categories: defaultCategories,
    balanceAdjustments: [],
    dailyCheckIns: [],
    favorites: [],
  };
}
function expense(
  amount: number,
  date: string,
  overrides: Partial<Expense> = {},
): Expense {
  return {
    ...stamped,
    id: date,
    amount,
    date,
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
const debt: Debt = {
  ...stamped,
  id: "loan",
  lenderName: "家族",
  title: "借入",
  originalAmount: 70000,
  openingBalance: 70000,
  currentBalance: 70000,
  startedAt: "2026-10-01",
  plannedMonthlyPayment: 5000,
  nextPaymentDate: "2026-10-27",
  note: "",
  isEstimated: false,
  cashReceived: false,
  status: "active",
  reserveForCurrentBudget: false,
};

describe("salary budget cycle boundaries", () => {
  it("uses the tenth through the next ninth and resets on the tenth", () => {
    expect(getBudgetCycle("2026-10-10", salary)).toMatchObject({
      start: "2026-10-10",
      end: "2026-11-09",
      nextStart: "2026-11-10",
      totalDays: 31,
      elapsedDays: 1,
      remainingDaysIncludingToday: 31,
    });
    expect(getBudgetCycle("2026-11-09", salary)).toMatchObject({
      start: "2026-10-10",
      end: "2026-11-09",
      remainingDaysIncludingToday: 1,
    });
    expect(getBudgetCycle("2026-11-10", salary)).toMatchObject({
      start: "2026-11-10",
      end: "2026-12-09",
      totalDays: 30,
    });
    expect(getBudgetCycle("2027-01-09", salary)).toMatchObject({
      start: "2026-12-10",
      end: "2027-01-09",
    });
    expect(getCycleBudgetMonth(getBudgetCycle("2027-01-09", salary))).toEqual({
      year: 2026,
      month: 12,
    });
  });
  it("clamps short months and restores the configured day without drifting", () => {
    const endOfMonth = { mode: "salary" as const, startDay: 31 };
    expect(getBudgetCycle("2028-02-29", endOfMonth)).toMatchObject({
      start: "2028-02-29",
      end: "2028-03-30",
      nextStart: "2028-03-31",
      totalDays: 31,
    });
    expect(getBudgetCycle("2027-02-28", endOfMonth)).toMatchObject({
      start: "2027-02-28",
      nextStart: "2027-03-31",
    });
    expect(getBudgetCycle("2028-03-31", endOfMonth).start).toBe("2028-03-31");
    expect(() =>
      getBudgetCycle("2026-10-10", { mode: "salary", startDay: 0 }),
    ).toThrow();
  });
  it("preserves calendar-month defaults and accepts Japan date instants", () => {
    expect(getBudgetCycle("2028-02-29")).toMatchObject({
      mode: "calendar",
      start: "2028-02-01",
      end: "2028-02-29",
      remainingDaysIncludingToday: 1,
    });
    const cycle = getBudgetCycle("2026-10-09T15:00:00Z", salary);
    expect(cycle.start).toBe("2026-10-10");
    expect(isInBudgetCycle("2026-11-09", cycle)).toBe(true);
    expect(isInBudgetCycle("2026-11-10", cycle)).toBe(false);
  });
});

describe("salary-period finance", () => {
  it("counts actual deposits on their real dates without treating the expected salary as money", () => {
    const app = fixture();
    app.settings.salarySchedule = {
      payday: 10,
      expectedAmount: 20000,
      variableIncome: true,
    };
    app.incomes = [
      {
        ...stamped,
        id: "salary",
        amount: 18760,
        date: "2026-10-09",
        source: "給与",
        memo: "",
        type: "salary",
      },
    ];
    expect(computeFinance(app, "2026-10-09")).toMatchObject({
      liquidBalance: 49760,
      periodIncomeTotal: 18760,
      cycle: { start: "2026-09-10", end: "2026-10-09" },
    });
    expect(computeFinance(app, "2026-10-10")).toMatchObject({
      liquidBalance: 49760,
      periodIncomeTotal: 0,
    });
  });
  it("preserves this morning's frame while spending is subtracted once; overspending lowers tomorrow's frame", () => {
    const app = fixture();
    const morning = computeFinance(app, "2026-10-10");
    expect(morning).toMatchObject({
      dailyAllowance: 1000,
      todayRemaining: 1000,
      tomorrowAllowance: 1000,
      overspentToday: 0,
    });
    app.expenses.push(expense(1500, "2026-10-10"));
    expect(computeFinance(app, "2026-10-10")).toMatchObject({
      safeToSpend: 29500,
      dailyAllowance: 1000,
      todayRemaining: 0,
      tomorrowAllowance: 983,
      overspentToday: 500,
    });
    const nextDay = computeFinance(app, "2026-10-11");
    expect(nextDay.dailyAllowance).toBe(983);
  });
  it("uses the period budget when lower than assets and does not confuse November's calendar budget", () => {
    const app = fixture();
    app.budgets = [
      {
        ...stamped,
        id: "oct",
        year: 2026,
        month: 10,
        totalBudget: 6200,
        categoryBudgets: {},
      },
      {
        ...stamped,
        id: "nov",
        year: 2026,
        month: 11,
        totalBudget: 31000,
        categoryBudgets: {},
      },
    ];
    app.expenses.push(expense(200, "2026-10-10"));
    expect(computeFinance(app, "2026-10-10")).toMatchObject({
      periodBudgetRemaining: 6000,
      dailyAllowance: 200,
      todayRemaining: 0,
      tomorrowAllowance: 200,
    });
    expect(computeFinance(app, "2026-11-01")).toMatchObject({
      monthlyBudget: 31000,
      periodBudget: 6200,
      periodExpenseTotal: 200,
      monthlyExpenseTotal: 0,
    });
    expect(
      previewPurchase(computeFinance(app, "2026-11-01"), 1500, "2026-11-01"),
    ).toMatchObject({
      budgetAfter: 4500,
      daysAfterToday: 8,
      tomorrowAllowance: 562,
    });
  });
  it("does not guess tomorrow's salary or divide by zero at the period boundary", () => {
    const app = fixture();
    app.settings.salarySchedule = {
      payday: 10,
      expectedAmount: 20000,
      variableIncome: true,
    };
    expect(computeFinance(app, "2026-11-09").tomorrowAllowance).toBeNull();
    expect(
      previewPurchase(computeFinance(app, "2026-11-09"), 0, "2026-11-09")
        ?.tomorrowAllowance,
    ).toBeNull();
    expect(computeFinance(app, "2026-11-10").liquidBalance).toBe(31000);
  });
  it("shows an inactive repayment debt but excludes its plan until repayment starts", () => {
    const app = fixture();
    app.debts = [debt];
    expect(computeFinance(app, "2026-10-20")).toMatchObject({
      debtReserve: 0,
      safeToSpend: 31000,
    });
    expect(nextDebtPayment(app, debt, "2026-10-20")).toBeNull();
    app.debts[0] = { ...debt, reserveForCurrentBudget: true };
    expect(computeFinance(app, "2026-10-20")).toMatchObject({
      debtReserve: 5000,
      safeToSpend: 26000,
    });
    app.repayments.push({
      id: "repay",
      debtId: "loan",
      amount: 2000,
      date: "2026-10-21",
      memo: "",
    });
    expect(computeFinance(app, "2026-10-21")).toMatchObject({
      liquidBalance: 29000,
      debtReserve: 3000,
      safeToSpend: 26000,
    });
    expect(nextDebtPayment(app, app.debts[0], "2026-10-21")).toMatchObject({
      date: "2026-10-27",
      amount: 3000,
    });
  });
  it("reserves next-calendar-month fixed expenses inside the cycle and releases only confirmed costs", () => {
    const app = fixture();
    app.recurringExpenses = [
      {
        id: "fixed",
        name: "月額サービス",
        amount: 1000,
        categoryId: "fixed",
        subcategoryId: "fixed-1",
        paymentMethod: "cash",
        frequency: "monthly",
        dueDay: 1,
        startDate: "2026-10-10",
        isActive: true,
        note: "",
      },
    ];
    expect(computeFinance(app, "2026-10-20")).toMatchObject({
      upcomingFixedCosts: 1000,
      safeToSpend: 30000,
      recurringDue: [{ dueDate: "2026-11-01" }],
    });
    app.expenses.push(
      expense(1000, "2026-11-01", {
        isFixedCost: true,
        recurringOccurrenceId: "fixed:2026-11",
      }),
    );
    expect(computeFinance(app, "2026-11-01")).toMatchObject({
      upcomingFixedCosts: 0,
      safeToSpend: 30000,
      todayDiscretionarySpent: 0,
      overspentToday: 0,
    });
  });
  it("savings reserves follow salary periods while actual savings still stay in their own balance", () => {
    const app = fixture();
    app.savingsGoals = [
      {
        id: "goal",
        name: "旅行",
        targetAmount: 100000,
        openingAmount: 0,
        currentAmount: 0,
        targetDate: "",
        monthlyTarget: 3000,
        createdAt: stamped.createdAt,
      },
    ];
    app.savingsContributions = [
      {
        id: "saved",
        savingsGoalId: "goal",
        amount: 3000,
        date: "2026-10-30",
        memo: "",
      },
    ];
    expect(computeFinance(app, "2026-11-01")).toMatchObject({
      liquidBalance: 28000,
      savingsReserve: 0,
      safeToSpend: 28000,
    });
    expect(computeFinance(app, "2026-11-10")).toMatchObject({
      liquidBalance: 28000,
      savingsReserve: 3000,
      safeToSpend: 25000,
    });
  });
});
