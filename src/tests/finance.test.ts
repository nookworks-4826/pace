import { describe, expect, it } from "vitest";
import type {
  AppData,
  CreditCard,
  Debt,
  Expense,
  RecurringExpense,
  SavingsGoal,
} from "../types";
import {
  calculateCardOutstanding,
  calculateDebtBalance,
  calculateSavingsAmount,
  computeFinance,
  getCardSummary,
  getRecurringDue,
  nextDebtPayment,
  assertMoney,
} from "../domain/finance";
import { addMonthsDate, dateKey, dateOnDay, isDateKey } from "../domain/dates";
import { defaultCategories, defaultSettings } from "../db";

const today = "2026-09-24";
const stamped = {
  createdAt: "2026-09-01T00:00:00+09:00",
  updatedAt: "2026-09-01T00:00:00+09:00",
};
const card: CreditCard = {
  ...stamped,
  id: "card",
  name: "Visa",
  last4: "1234",
  closingDay: 15,
  paymentDay: 27,
  paymentMonthOffset: 1,
  openingOutstanding: 0,
  isActive: true,
};
const debt: Debt = {
  ...stamped,
  id: "debt",
  lenderName: "親",
  title: "渡航費",
  originalAmount: 70000,
  openingBalance: 70000,
  currentBalance: 70000,
  startedAt: "2026-09-01",
  plannedMonthlyPayment: 5000,
  nextPaymentDate: "2026-09-27",
  note: "",
  isEstimated: false,
  cashReceived: false,
  status: "active",
};
const savings: SavingsGoal = {
  id: "savings",
  name: "旅行",
  targetAmount: 100000,
  openingAmount: 0,
  currentAmount: 0,
  targetDate: "",
  monthlyTarget: 5000,
  createdAt: stamped.createdAt,
};
const recurring: RecurringExpense = {
  id: "fixed",
  name: "通信",
  amount: 5000,
  categoryId: "fixed",
  subcategoryId: "fixed-0",
  paymentMethod: "bank",
  frequency: "monthly",
  dueDay: 27,
  startDate: "2026-09-01",
  isActive: true,
  note: "",
};
function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    ...stamped,
    id: "expense",
    amount: 5000,
    date: today,
    merchant: "買い物",
    description: "",
    categoryId: "food",
    subcategoryId: "food-0",
    paymentMethod: "cash",
    memo: "",
    isFixedCost: false,
    ...overrides,
  };
}
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
      ...structuredClone(defaultSettings),
      openingLiquidBalance: 30000,
    },
    merchantRules: [],
    categories: structuredClone(defaultCategories),
    balanceAdjustments: [],
    dailyCheckIns: [],
    favorites: [],
  };
}

describe("ledger and reservation accounting", () => {
  it("card purchase lowers available money immediately, settlement cannot count it twice", () => {
    const data = fixture();
    data.cards = [card];
    data.expenses = [
      makeExpense({ paymentMethod: "creditCard", creditCardId: card.id }),
    ];
    expect(computeFinance(data, today)).toMatchObject({
      liquidBalance: 30000,
      cardOutstanding: 5000,
      safeToSpend: 25000,
      monthlyExpenseTotal: 5000,
    });
    data.cardPayments.push({
      ...stamped,
      id: "paid",
      creditCardId: card.id,
      amount: 5000,
      date: today,
      memo: "",
    });
    expect(computeFinance(data, today)).toMatchObject({
      liquidBalance: 25000,
      cardOutstanding: 0,
      safeToSpend: 25000,
      monthlyExpenseTotal: 5000,
    });
  });
  it("fixed-cost reserve is released when a cash expense is confirmed", () => {
    const data = fixture();
    data.recurringExpenses = [recurring];
    expect(computeFinance(data, today)).toMatchObject({
      liquidBalance: 30000,
      upcomingFixedCosts: 5000,
      safeToSpend: 25000,
    });
    data.expenses.push(
      makeExpense({
        isFixedCost: true,
        recurringOccurrenceId: "fixed:2026-09",
      }),
    );
    data.recurringOccurrences.push({
      id: "fixed:2026-09",
      recurringExpenseId: "fixed",
      dueDate: "2026-09-27",
      status: "paid",
      expenseId: "expense",
    });
    expect(computeFinance(data, today)).toMatchObject({
      liquidBalance: 25000,
      upcomingFixedCosts: 0,
      safeToSpend: 25000,
    });
  });
  it("a card fixed-cost confirmation transfers the reserve into outstanding", () => {
    const data = fixture();
    data.cards = [card];
    data.recurringExpenses = [recurring];
    data.expenses.push(
      makeExpense({
        paymentMethod: "creditCard",
        creditCardId: card.id,
        isFixedCost: true,
        recurringOccurrenceId: "fixed:2026-09",
      }),
    );
    expect(computeFinance(data, today)).toMatchObject({
      liquidBalance: 30000,
      upcomingFixedCosts: 0,
      cardOutstanding: 5000,
      safeToSpend: 25000,
    });
  });
  it("debt repayment releases its monthly reserve and does not become living expense", () => {
    const data = fixture();
    data.debts = [debt];
    expect(computeFinance(data, today)).toMatchObject({
      safeToSpend: 25000,
      debtReserve: 5000,
    });
    data.repayments.push({
      id: "repaid",
      debtId: debt.id,
      amount: 5000,
      date: today,
      memo: "",
    });
    expect(computeFinance(data, today)).toMatchObject({
      liquidBalance: 25000,
      safeToSpend: 25000,
      debtReserve: 0,
      monthlyExpenseTotal: 0,
    });
    expect(calculateDebtBalance(debt, data.repayments, today)).toBe(65000);
  });
  it("savings contributions release the reserve without lowering safe amount twice", () => {
    const data = fixture();
    data.savingsGoals = [savings];
    expect(computeFinance(data, today)).toMatchObject({
      safeToSpend: 25000,
      savingsReserve: 5000,
    });
    data.savingsContributions.push({
      id: "saved",
      savingsGoalId: savings.id,
      amount: 2000,
      date: today,
      memo: "",
    });
    expect(computeFinance(data, today)).toMatchObject({
      liquidBalance: 28000,
      safeToSpend: 25000,
      savingsReserve: 3000,
    });
    data.savingsContributions.push({
      id: "saved2",
      savingsGoalId: savings.id,
      amount: 3000,
      date: today,
      memo: "",
    });
    expect(computeFinance(data, today)).toMatchObject({
      liquidBalance: 25000,
      safeToSpend: 25000,
      savingsReserve: 0,
    });
    expect(
      calculateSavingsAmount(savings, data.savingsContributions, today),
    ).toBe(5000);
  });
  it("savings reserve is capped by the amount left to the goal", () => {
    const data = fixture();
    data.savingsGoals = [{ ...savings, openingAmount: 99000 }];
    expect(computeFinance(data, today).savingsReserve).toBe(1000);
  });
  it("reserve calculations rely on ledger entries rather than stale cached totals and status", () => {
    const data = fixture();
    data.debts = [{ ...debt, currentBalance: 0, status: "paid" }];
    data.savingsGoals = [
      { ...savings, currentAmount: 100000, completedAt: stamped.createdAt },
    ];
    expect(computeFinance(data, today)).toMatchObject({
      debtReserve: 5000,
      savingsReserve: 5000,
      safeToSpend: 20000,
    });
  });
  it("cash-received borrowing changes liquidity while a parent-paid debt does not", () => {
    const data = fixture();
    data.debts = [debt];
    expect(computeFinance(data, today).liquidBalance).toBe(30000);
    data.debts[0] = { ...debt, cashReceived: true };
    expect(computeFinance(data, today).liquidBalance).toBe(100000);
    expect(computeFinance(data, today).monthlyIncomeTotal).toBe(0);
  });
  it("salary forecasts and future-dated rows never inflate current liquidity", () => {
    const data = fixture();
    data.settings.salarySchedule = {
      payday: 25,
      expectedAmount: 100000,
      variableIncome: true,
    };
    data.incomes.push({
      ...stamped,
      id: "salary",
      amount: 100000,
      date: "2026-09-25",
      source: "給与",
      type: "salary",
      memo: "",
    });
    data.expenses.push(makeExpense({ date: "2026-09-25" }));
    expect(computeFinance(data, today)).toMatchObject({
      liquidBalance: 30000,
      monthlyIncomeTotal: 0,
      monthlyExpenseTotal: 0,
    });
    expect(computeFinance(data, "2026-09-25")).toMatchObject({
      liquidBalance: 125000,
      monthlyIncomeTotal: 100000,
      monthlyExpenseTotal: 5000,
    });
  });
  it("deleting and editing card purchases recalculates their ledger", () => {
    const data = fixture();
    data.cards = [card];
    data.expenses = [
      makeExpense({ paymentMethod: "creditCard", creditCardId: card.id }),
    ];
    data.expenses[0].amount = 1200;
    expect(calculateCardOutstanding(data, card.id, today)).toBe(1200);
    data.expenses[0].paymentMethod = "cash";
    expect(computeFinance(data, today)).toMatchObject({
      liquidBalance: 28800,
      cardOutstanding: 0,
      safeToSpend: 28800,
    });
    data.expenses = [];
    expect(computeFinance(data, today)).toMatchObject({
      liquidBalance: 30000,
      cardOutstanding: 0,
      safeToSpend: 30000,
    });
  });
  it("inactive cards retain their outstanding and overpayments do not become spendable cash", () => {
    const data = fixture();
    data.cards = [{ ...card, isActive: false, openingOutstanding: 8000 }];
    expect(computeFinance(data, today).cardOutstanding).toBe(8000);
    data.cardPayments.push({
      ...stamped,
      id: "payment",
      creditCardId: card.id,
      amount: 9000,
      date: today,
      memo: "",
    });
    expect(computeFinance(data, today)).toMatchObject({
      liquidBalance: 21000,
      cardOutstanding: 0,
      safeToSpend: 21000,
    });
    expect(getCardSummary(data, data.cards[0], today).creditBalance).toBe(1000);
  });
  it("balance adjustments are an auditable difference in the ledger", () => {
    const data = fixture();
    data.balanceAdjustments = [
      {
        id: "adjust",
        previousBalance: 30000,
        newBalance: 27000,
        difference: -3000,
        date: today,
        memo: "照合",
      },
    ];
    expect(computeFinance(data, today).liquidBalance).toBe(27000);
    expect(computeFinance(data, today).monthlyExpenseTotal).toBe(0);
  });
});

describe("dates, recurring payments and budgets", () => {
  it("unconfirmed fixed costs from prior months stay reserved until explicitly resolved", () => {
    const data = fixture();
    data.recurringExpenses = [{ ...recurring, startDate: "2026-08-01" }];
    expect(getRecurringDue(data, today).map((row) => row.id)).toEqual([
      "fixed:2026-08",
      "fixed:2026-09",
    ]);
    expect(computeFinance(data, today).upcomingFixedCosts).toBe(10000);
    data.recurringOccurrences.push({
      id: "fixed:2026-08",
      recurringExpenseId: "fixed",
      dueDate: "2026-08-27",
      status: "skipped",
    });
    expect(computeFinance(data, today).upcomingFixedCosts).toBe(5000);
  });
  it("a deleted fixed expense restores its reserve even if a stale paid marker remains", () => {
    const data = fixture();
    data.recurringExpenses = [recurring];
    data.recurringOccurrences = [
      {
        id: "fixed:2026-09",
        recurringExpenseId: "fixed",
        dueDate: "2026-09-27",
        status: "paid",
        expenseId: "deleted",
      },
    ];
    expect(computeFinance(data, today).upcomingFixedCosts).toBe(5000);
    data.recurringExpenses = [];
    expect(computeFinance(data, today).upcomingFixedCosts).toBe(0);
  });
  it("annual costs occur in their start month with short-month clamping", () => {
    const data = fixture();
    data.recurringExpenses = [
      {
        ...recurring,
        startDate: "2026-02-01",
        frequency: "yearly",
        dueDay: 31,
      },
    ];
    expect(
      getRecurringDue(data, "2026-03-01").map((row) => row.dueDate),
    ).toEqual(["2026-02-28"]);
    expect(
      getRecurringDue(data, "2027-02-01").map((row) => row.dueDate),
    ).toEqual(["2026-02-28", "2027-02-28"]);
    data.recurringExpenses[0].endDate = "2026-12-31";
    expect(getRecurringDue(data, "2027-02-01")).toHaveLength(1);
  });
  it("does not reserve occurrences before their first date", () => {
    const data = fixture();
    data.recurringExpenses = [{ ...recurring, startDate: "2026-09-28" }];
    expect(computeFinance(data, today).upcomingFixedCosts).toBe(0);
    expect(
      getRecurringDue(data, "2026-10-01").map((row) => row.dueDate),
    ).toEqual(["2026-10-27"]);
  });
  it("unknown starting balance is never replaced with a guessed zero", () => {
    const data = fixture();
    data.settings.openingLiquidBalance = null;
    expect(computeFinance(data, today)).toMatchObject({
      liquidBalance: null,
      safeToSpend: null,
      dailyAllowance: null,
      todayRemaining: null,
    });
  });
  it("has usable defaults without budget, cards, debt or savings", () => {
    expect(computeFinance(fixture(), today)).toMatchObject({
      safeToSpend: 30000,
      dailyAllowance: 4286,
      monthlyBudget: null,
      debtReserve: 0,
      savingsReserve: 0,
      cardOutstanding: 0,
    });
  });
  it("retains negative availability but floors the daily allowance", () => {
    const data = fixture();
    data.expenses = [makeExpense({ amount: 35000 })];
    expect(computeFinance(data, today)).toMatchObject({
      safeToSpend: -5000,
      dailyAllowance: 0,
      todayRemaining: 0,
    });
  });
  it("uses the lower of budget remainder and safe amount, including today", () => {
    const data = fixture();
    data.budgets = [
      {
        ...stamped,
        id: "budget",
        year: 2026,
        month: 9,
        totalBudget: 12000,
        categoryBudgets: {},
      },
    ];
    data.expenses = [makeExpense()];
    expect(computeFinance(data, today)).toMatchObject({
      monthlyBudgetRemaining: 7000,
      dailyAllowance: 1714,
      todaySpent: 5000,
      todayRemaining: 0,
    });
  });
  it("switches monthly totals and monthly savings reserves on October 1", () => {
    const data = fixture();
    data.expenses = [
      makeExpense({ date: "2026-09-30" }),
      makeExpense({ id: "oct", amount: 1200, date: "2026-10-01" }),
    ];
    data.savingsGoals = [savings];
    data.savingsContributions = [
      {
        id: "save",
        savingsGoalId: savings.id,
        amount: 5000,
        date: "2026-09-30",
        memo: "",
      },
    ];
    expect(computeFinance(data, "2026-09-30")).toMatchObject({
      monthlyExpenseTotal: 5000,
      savingsReserve: 0,
      dailyAllowance: 25000,
    });
    expect(computeFinance(data, "2026-10-01")).toMatchObject({
      monthlyExpenseTotal: 1200,
      savingsReserve: 5000,
    });
  });
  it("normalizes instants to Japan calendar dates at month boundary", () => {
    expect(dateKey("2026-09-30T14:59:59Z")).toBe("2026-09-30");
    expect(dateKey("2026-09-30T15:00:00Z")).toBe("2026-10-01");
    expect(dateOnDay("2028-02", 31)).toBe("2028-02-29");
    expect(addMonthsDate("2026-01-31", 1)).toBe("2026-02-28");
    expect(isDateKey("2026-02-30")).toBe(false);
    expect(() => dateKey("2026-02-30T12:00:00Z")).toThrow();
    expect(() => dateKey("09/24/2026")).toThrow();
    expect(() => dateKey("2026-09-24T12:00:00")).toThrow();
  });
  it("represents a zero budget explicitly and retains a usable daily amount", () => {
    const data = fixture();
    data.budgets = [
      {
        ...stamped,
        id: "zero",
        year: 2026,
        month: 9,
        totalBudget: 0,
        categoryBudgets: {},
      },
    ];
    expect(computeFinance(data, today)).toMatchObject({
      monthlyBudget: 0,
      monthlyBudgetRemaining: 0,
      dailyAllowance: 0,
      pace: { label: "予定ペース", ratio: 0 },
    });
    data.expenses = [makeExpense()];
    expect(computeFinance(data, today)).toMatchObject({
      dailyAllowance: 0,
      pace: { label: "ペース注意" },
    });
  });
  it("estimates statement dates from the closing date and marks its result as an estimate", () => {
    const data = fixture();
    data.cards = [card];
    data.expenses = [
      makeExpense({
        paymentMethod: "creditCard",
        creditCardId: card.id,
        date: "2026-08-15",
      }),
      makeExpense({
        id: "later",
        paymentMethod: "creditCard",
        creditCardId: card.id,
        date: "2026-08-16",
        amount: 3000,
      }),
    ];
    expect(getCardSummary(data, card, today)).toMatchObject({
      outstanding: 8000,
      nextPaymentDate: "2026-09-27",
      estimatedNextPaymentAmount: 5000,
      isEstimate: true,
    });
  });
  it("rejects zero, negative, decimal, unsafe and out-of-range amounts", () => {
    for (const amount of [
      0,
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER,
      1_000_000_000_000,
    ])
      expect(() => assertMoney(amount)).toThrow();
    expect(() => assertMoney(0, true)).not.toThrow();
    expect(() => assertMoney(999_999_999_999)).not.toThrow();
  });
});

describe("next debt payment", () => {
  it("shows only the unpaid part of this month, capped by actual remaining debt", () => {
    const data = fixture();
    data.repayments = [
      { id: "partial", debtId: debt.id, amount: 2000, date: today, memo: "" },
    ];
    expect(nextDebtPayment(data, debt, today)).toEqual({
      date: "2026-09-27",
      amount: 3000,
    });
    expect(
      nextDebtPayment(data, { ...debt, openingBalance: 3000 }, today),
    ).toEqual({ date: "2026-09-27", amount: 1000 });
  });
  it("moves a completed monthly plan to next month without repeating it this month", () => {
    const data = fixture();
    data.repayments = [
      { id: "paid", debtId: debt.id, amount: 5000, date: today, memo: "" },
    ];
    expect(nextDebtPayment(data, debt, today)).toEqual({
      date: "2026-10-27",
      amount: 5000,
    });
  });
  it("retains an overdue unpaid date in the current month", () => {
    const data = fixture();
    data.repayments = [
      { id: "partial", debtId: debt.id, amount: 2000, date: today, memo: "" },
    ];
    expect(
      nextDebtPayment(data, { ...debt, nextPaymentDate: "2026-09-10" }, today),
    ).toEqual({ date: "2026-09-10", amount: 3000 });
    expect(
      nextDebtPayment(
        data,
        { ...debt, startedAt: "2026-01-01", nextPaymentDate: "2026-01-10" },
        today,
      ),
    ).toEqual({ date: "2026-09-10", amount: 3000 });
  });
  it("preserves an explicit earliest payment date several months in the future", () => {
    const data = fixture();
    expect(
      nextDebtPayment(data, { ...debt, nextPaymentDate: "2027-01-15" }, today),
    ).toEqual({ date: "2027-01-15", amount: 5000 });
  });
  it("clamps short months using the original day and restores the 31st in March", () => {
    const data = fixture();
    const loan = {
      ...debt,
      startedAt: "2026-01-01",
      nextPaymentDate: "2026-01-31",
    };
    expect(nextDebtPayment(data, loan, "2026-02-25")).toEqual({
      date: "2026-02-28",
      amount: 5000,
    });
    data.repayments = [
      {
        id: "paid",
        debtId: loan.id,
        amount: 5000,
        date: "2026-02-25",
        memo: "",
      },
    ];
    expect(nextDebtPayment(data, loan, "2026-02-25")).toEqual({
      date: "2026-03-31",
      amount: 5000,
    });
  });
  it("omits undated, unplanned, fully settled and not-yet-started debt", () => {
    const data = fixture();
    expect(
      nextDebtPayment(data, { ...debt, nextPaymentDate: "" }, today),
    ).toBeNull();
    expect(
      nextDebtPayment(data, { ...debt, plannedMonthlyPayment: 0 }, today),
    ).toBeNull();
    expect(
      nextDebtPayment(data, { ...debt, openingBalance: 0 }, today),
    ).toBeNull();
    expect(
      nextDebtPayment(data, { ...debt, startedAt: "2026-10-01" }, today),
    ).toBeNull();
  });
  it("excludes past-month and future-dated repayments from the current-month paid amount", () => {
    const data = fixture();
    data.repayments = [
      {
        id: "past",
        debtId: debt.id,
        amount: 5000,
        date: "2026-08-31",
        memo: "",
      },
      {
        id: "future",
        debtId: debt.id,
        amount: 5000,
        date: "2026-09-25",
        memo: "",
      },
    ];
    expect(nextDebtPayment(data, debt, today)).toEqual({
      date: "2026-09-27",
      amount: 5000,
    });
  });
});
