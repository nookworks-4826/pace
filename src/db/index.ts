import Dexie, { type Table } from "dexie";
import type {
  AppData,
  AppSettings,
  BalanceAdjustment,
  Budget,
  CardPayment,
  Category,
  CreditCard,
  DailyCheckIn,
  Debt,
  DebtRepayment,
  Expense,
  Favorite,
  Income,
  MerchantCategoryRule,
  RecurringExpense,
  RecurringOccurrence,
  SavingsContribution,
  SavingsGoal,
} from "../types";
import {
  assertMoney,
  calculateLiquidBalance,
  MAX_MONEY,
} from "../domain/finance";
import { dateKey, dateOnDay, monthKey, todayJST } from "../domain/dates";
import { learnMerchantRule, normalizeMerchant } from "../domain/categorization";

export const defaultSettings: AppSettings = {
  id: "main",
  openingLiquidBalance: null,
  salarySchedule: null,
  theme: "default",
  colorMode: "light",
  onboardingCompleted: false,
  setupReviewed: [],
  helpDismissed: false,
  lastBackupAt: null,
  lastSeenMonth: monthKey(todayJST()),
  lockAfterSeconds: 60,
};
const categorySeed: [string, string, string, string, string[]][] = [
  [
    "food",
    "食費",
    "#447A80",
    "Utensils",
    [
      "外食",
      "コンビニ",
      "スーパー",
      "カフェ",
      "デリバリー",
      "飲み物",
      "その他",
    ],
  ],
  [
    "transport",
    "交通",
    "#577CAE",
    "TrainFront",
    ["電車", "バス", "タクシー", "カーシェア", "ガソリン", "駐車場", "その他"],
  ],
  [
    "social",
    "交際",
    "#A47EBA",
    "Users",
    ["友人との食事", "飲み会", "プレゼント", "その他"],
  ],
  [
    "entertainment",
    "娯楽",
    "#B18756",
    "Gamepad2",
    ["ゲーム", "映画", "カラオケ", "イベント", "趣味", "その他"],
  ],
  [
    "shopping",
    "買い物",
    "#7777B3",
    "ShoppingBag",
    ["衣服", "靴", "家電", "スマホ関連", "ネットショッピング", "その他"],
  ],
  [
    "living",
    "生活",
    "#5E9273",
    "House",
    ["日用品", "美容", "医療", "薬", "その他"],
  ],
  [
    "work",
    "学校・仕事",
    "#768AA6",
    "GraduationCap",
    ["教材", "文房具", "学費関連", "仕事関連"],
  ],
  [
    "travel",
    "旅行",
    "#478F9D",
    "Plane",
    ["宿泊", "交通", "食事", "観光", "その他"],
  ],
  [
    "fixed",
    "固定費",
    "#9D7881",
    "Repeat2",
    ["通信", "サブスク", "保険", "その他"],
  ],
  ["other", "その他", "#8C8B7A", "CircleEllipsis", []],
  ["uncategorized", "未分類", "#8A94A1", "CircleHelp", []],
];
export const defaultCategories: Category[] = categorySeed.map(
  ([id, name, color, icon, subcategories]) => ({
    id,
    name,
    color,
    icon,
    subcategories: subcategories.map((name, index) => ({
      id: `${id}-${index}`,
      name,
    })),
  }),
);

export class PaceDatabase extends Dexie {
  drafts!: Table<{ id: string; value: string }, string>;
  expenses!: Table<Expense, string>;
  incomes!: Table<Income, string>;
  cards!: Table<CreditCard, string>;
  cardPayments!: Table<CardPayment, string>;
  debts!: Table<Debt, string>;
  repayments!: Table<DebtRepayment, string>;
  recurringExpenses!: Table<RecurringExpense, string>;
  recurringOccurrences!: Table<RecurringOccurrence, string>;
  savingsGoals!: Table<SavingsGoal, string>;
  savingsContributions!: Table<SavingsContribution, string>;
  budgets!: Table<Budget, string>;
  settings!: Table<AppSettings, string>;
  merchantRules!: Table<MerchantCategoryRule, string>;
  categories!: Table<Category, string>;
  balanceAdjustments!: Table<BalanceAdjustment, string>;
  dailyCheckIns!: Table<DailyCheckIn, string>;
  favorites!: Table<Favorite, string>;
  constructor(name = "pace") {
    super(name);
    this.version(1).stores({
      expenses:
        "id,date,categoryId,paymentMethod,creditCardId,merchant,&recurringOccurrenceId,[categoryId+date],[creditCardId+date]",
      incomes: "id,date,type",
      cards: "id,isActive",
      cardPayments: "id,date,creditCardId",
      debts: "id,status,startedAt",
      repayments: "id,date,debtId",
      recurringExpenses: "id,isActive,startDate",
      recurringOccurrences: "id,recurringExpenseId,dueDate,status,expenseId",
      savingsGoals: "id,createdAt",
      savingsContributions: "id,date,savingsGoalId",
      budgets: "id,&[year+month]",
      settings: "id",
      merchantRules: "normalizedMerchant,categoryId",
      categories: "id",
      balanceAdjustments: "id,date",
      dailyCheckIns: "date",
      favorites: "id",
    });
    this.version(2).stores({ drafts: "id" });
    this.installValidation();
  }
  private installValidation() {
    const monetaryTables: Table<
      { id: string; amount: number; date: string },
      string
    >[] = [
      this.incomes,
      this.cardPayments,
      this.repayments,
      this.savingsContributions,
    ];
    for (const table of monetaryTables) {
      table.hook("creating", (_key, value) => {
        assertMoney(value.amount);
        dateKey(value.date);
      });
      table.hook("updating", (changes, _key, value) => {
        const next = { ...value, ...changes };
        assertMoney(next.amount);
        dateKey(next.date);
      });
    }
    this.expenses.hook("creating", (_key, value) => validateExpense(value));
    this.expenses.hook("updating", (changes, _key, value) =>
      validateExpense({ ...value, ...changes }),
    );
    this.cards.hook("creating", (_key, value) => {
      assertMoney(value.openingOutstanding, true);
      validateDay(value.closingDay);
      validateDay(value.paymentDay);
    });
    this.cards.hook("updating", (changes, _key, value) => {
      const next = { ...value, ...changes };
      assertMoney(next.openingOutstanding, true);
      validateDay(next.closingDay);
      validateDay(next.paymentDay);
    });
    this.debts.hook("creating", (_key, value) => validateDebt(value));
    this.debts.hook("updating", (changes, _key, value) =>
      validateDebt({ ...value, ...changes }),
    );
    this.savingsGoals.hook("creating", (_key, value) =>
      validateSavingsGoal(value),
    );
    this.savingsGoals.hook("updating", (changes, _key, value) =>
      validateSavingsGoal({ ...value, ...changes }),
    );
    this.recurringExpenses.hook("creating", (_key, value) =>
      validateRecurring(value),
    );
    this.recurringExpenses.hook("updating", (changes, _key, value) =>
      validateRecurring({ ...value, ...changes }),
    );
    this.budgets.hook("creating", (_key, value) => validateBudget(value));
    this.budgets.hook("updating", (changes, _key, value) =>
      validateBudget({ ...value, ...changes }),
    );
    this.balanceAdjustments.hook("creating", (_key, value) =>
      validateAdjustment(value),
    );
    this.settings.hook("creating", (_key, value) => validateSettings(value));
    this.settings.hook("updating", (changes, _key, value) =>
      validateSettings({ ...value, ...changes }),
    );
  }
}
function validateDay(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 31)
    throw new Error("日付は1〜31で入力してください。");
}
function validateExpense(value: Expense) {
  assertMoney(value.amount);
  dateKey(value.date);
  if (value.paymentMethod === "creditCard" && !value.creditCardId)
    throw new Error("支払いに使ったカードを選んでください。");
  if (!value.categoryId) throw new Error("カテゴリーを選んでください。");
}
function validateDebt(value: Debt) {
  assertMoney(value.originalAmount);
  assertMoney(value.openingBalance, true);
  assertMoney(value.currentBalance, true);
  assertMoney(value.plannedMonthlyPayment, true);
  dateKey(value.startedAt);
  if (value.nextPaymentDate) dateKey(value.nextPaymentDate);
}
function validateSavingsGoal(value: SavingsGoal) {
  assertMoney(value.targetAmount);
  assertMoney(value.openingAmount, true);
  assertMoney(value.currentAmount, true);
  assertMoney(value.monthlyTarget, true);
  if (value.targetDate) dateKey(value.targetDate);
}
function validateRecurring(value: RecurringExpense) {
  assertMoney(value.amount);
  validateDay(value.dueDay);
  dateKey(value.startDate);
  if (value.endDate && dateKey(value.endDate) < dateKey(value.startDate))
    throw new Error("終了日は開始日以降を選んでください。");
  if (value.paymentMethod === "creditCard" && !value.creditCardId)
    throw new Error("支払いに使うカードを選んでください。");
}
function validateBudget(value: Budget) {
  assertMoney(value.totalBudget, true);
  Object.values(value.categoryBudgets).forEach((amount) =>
    assertMoney(amount, true),
  );
  if (
    !Number.isInteger(value.year) ||
    value.year < 1900 ||
    value.year > 9999 ||
    !Number.isInteger(value.month) ||
    value.month < 1 ||
    value.month > 12
  )
    throw new Error("予算の年月を確認してください。");
}
function validateAdjustment(value: BalanceAdjustment) {
  if (
    ![value.previousBalance, value.newBalance, value.difference].every(
      (amount) => Number.isSafeInteger(amount) && Math.abs(amount) <= MAX_MONEY,
    )
  )
    throw new Error("残高の金額を確認してください。");
  if (value.newBalance - value.previousBalance !== value.difference)
    throw new Error("残高調整の差額が一致しません。");
  dateKey(value.date);
}
function validateSettings(value: AppSettings) {
  if (value.openingLiquidBalance !== null)
    assertMoney(value.openingLiquidBalance, true);
  if (value.salarySchedule) {
    validateDay(value.salarySchedule.payday);
    if (value.salarySchedule.expectedAmount !== null)
      assertMoney(value.salarySchedule.expectedAmount, true);
  }
}

export const db = new PaceDatabase();
let initialization: Promise<void> | undefined;
export function initializeDb(): Promise<void> {
  if (!initialization)
    initialization = db
      .transaction("rw", [db.settings, db.categories], async () => {
        if (!(await db.settings.get("main")))
          await db.settings.add(structuredClone(defaultSettings));
        if ((await db.categories.count()) === 0)
          await db.categories.bulkAdd(structuredClone(defaultCategories));
      })
      .catch((error: unknown) => {
        initialization = undefined;
        throw error;
      });
  return initialization;
}
export async function readAppData(): Promise<AppData> {
  // A read transaction gives finance one coherent snapshot while writes are in flight.
  return db.transaction("r", db.tables, async () => {
    const [
      expenses,
      incomes,
      cards,
      cardPayments,
      debts,
      repayments,
      recurringExpenses,
      recurringOccurrences,
      savingsGoals,
      savingsContributions,
      budgets,
      settings,
      merchantRules,
      categories,
      balanceAdjustments,
      dailyCheckIns,
      favorites,
    ] = await Promise.all([
      db.expenses.toArray(),
      db.incomes.toArray(),
      db.cards.toArray(),
      db.cardPayments.toArray(),
      db.debts.toArray(),
      db.repayments.toArray(),
      db.recurringExpenses.toArray(),
      db.recurringOccurrences.toArray(),
      db.savingsGoals.toArray(),
      db.savingsContributions.toArray(),
      db.budgets.toArray(),
      db.settings.get("main"),
      db.merchantRules.toArray(),
      db.categories.toArray(),
      db.balanceAdjustments.toArray(),
      db.dailyCheckIns.toArray(),
      db.favorites.toArray(),
    ]);
    return {
      expenses,
      incomes,
      cards,
      cardPayments,
      debts,
      repayments,
      recurringExpenses,
      recurringOccurrences,
      savingsGoals,
      savingsContributions,
      budgets,
      settings: settings ?? structuredClone(defaultSettings),
      merchantRules,
      categories,
      balanceAdjustments,
      dailyCheckIns,
      favorites,
    };
  });
}
export async function updateSettings(
  partial: Partial<Omit<AppSettings, "id">>,
): Promise<void> {
  await db.transaction("rw", db.settings, async () => {
    const current =
      (await db.settings.get("main")) ?? structuredClone(defaultSettings);
    await db.settings.put({ ...current, ...partial, id: "main" });
  });
}

/** The entered amount is today's real cash + bank balance, even after setup was skipped. */
export async function reconcileLiquidBalance(
  newBalance: number,
  today = todayJST(),
  memo = "",
): Promise<void> {
  assertMoney(newBalance, true);
  dateKey(today);
  await db.transaction("rw", db.tables, async () => {
    const data = await readAppData();
    if (data.settings.openingLiquidBalance === null) {
      // Zero is only an internal baseline; the accompanying adjustment records the real balance.
      data.settings = { ...data.settings, openingLiquidBalance: 0 };
      await db.settings.put(data.settings);
    }
    const previousBalance = calculateLiquidBalance(data, today)!;
    await db.balanceAdjustments.add({
      id: crypto.randomUUID(),
      previousBalance,
      newBalance,
      difference: newBalance - previousBalance,
      date: dateKey(today),
      memo,
    });
  });
}

export async function saveExpense(expense: Expense): Promise<void> {
  validateExpense(expense);
  await db.transaction(
    "rw",
    [
      db.expenses,
      db.merchantRules,
      db.categories,
      db.cards,
      db.recurringOccurrences,
      db.recurringExpenses,
    ],
    async () => {
      const category = await db.categories.get(expense.categoryId);
      if (
        !category ||
        (expense.subcategoryId &&
          !category.subcategories.some(
            (sub) => sub.id === expense.subcategoryId,
          ))
      )
        throw new Error("カテゴリーを選び直してください。");
      if (
        expense.paymentMethod === "creditCard" &&
        !(await db.cards.get(expense.creditCardId!))
      )
        throw new Error("カードを選び直してください。");
      const previous = await db.expenses.get(expense.id);
      if (
        previous?.recurringOccurrenceId &&
        previous.recurringOccurrenceId !== expense.recurringOccurrenceId
      )
        await db.recurringOccurrences.delete(previous.recurringOccurrenceId);
      if (expense.recurringOccurrenceId) {
        const existing = await db.expenses
          .where("recurringOccurrenceId")
          .equals(expense.recurringOccurrenceId)
          .first();
        if (existing && existing.id !== expense.id)
          throw new Error("この固定費はすでに記録されています。");
        const separator = expense.recurringOccurrenceId.lastIndexOf(":");
        const recurringExpenseId = expense.recurringOccurrenceId.slice(
          0,
          separator,
        );
        const recurring = await db.recurringExpenses.get(recurringExpenseId);
        if (!recurring)
          throw new Error("固定費が見つかりません。もう一度確認してください。");
        await db.recurringOccurrences.put({
          id: expense.recurringOccurrenceId,
          recurringExpenseId,
          dueDate: dateOnDay(
            expense.recurringOccurrenceId.slice(separator + 1),
            recurring.dueDay,
          ),
          status: "paid",
          expenseId: expense.id,
        });
      }
      await db.expenses.put(expense);
      const normalized = normalizeMerchant(expense.merchant);
      const rule = learnMerchantRule(
        expense.merchant,
        expense.categoryId,
        expense.subcategoryId,
        normalized ? await db.merchantRules.get(normalized) : undefined,
      );
      if (rule) await db.merchantRules.put(rule);
    },
  );
}
export async function deleteExpense(id: string): Promise<Expense | undefined> {
  return db.transaction(
    "rw",
    [db.expenses, db.recurringOccurrences],
    async () => {
      const expense = await db.expenses.get(id);
      if (!expense) return undefined;
      await db.expenses.delete(id);
      if (expense.recurringOccurrenceId)
        await db.recurringOccurrences.delete(expense.recurringOccurrenceId);
      return expense;
    },
  );
}
export function findDuplicateExpenses(
  expense: Pick<Expense, "id" | "merchant" | "amount" | "date" | "createdAt">,
  rows: Expense[],
): Expense[] {
  const merchant = normalizeMerchant(expense.merchant);
  return rows.filter(
    (row) =>
      row.id !== expense.id &&
      row.amount === expense.amount &&
      normalizeMerchant(row.merchant) === merchant &&
      dateKey(row.date) === dateKey(expense.date) &&
      Math.abs(Date.parse(row.createdAt) - Date.parse(expense.createdAt)) <=
        5 * 60_000,
  );
}

export async function clearAllData(): Promise<void> {
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
    await db.settings.add({
      ...structuredClone(defaultSettings),
      lastSeenMonth: monthKey(todayJST()),
    });
    await db.categories.bulkAdd(structuredClone(defaultCategories));
  });
}
export async function restoreAppData(data: AppData): Promise<void> {
  // Importers validate the full versioned envelope first; all table changes commit together.
  validateSettings(data.settings);
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
    await db.expenses.bulkAdd(data.expenses);
    await db.incomes.bulkAdd(data.incomes);
    await db.cards.bulkAdd(data.cards);
    await db.cardPayments.bulkAdd(data.cardPayments);
    await db.debts.bulkAdd(data.debts);
    await db.repayments.bulkAdd(data.repayments);
    await db.recurringExpenses.bulkAdd(data.recurringExpenses);
    await db.recurringOccurrences.bulkAdd(data.recurringOccurrences);
    await db.savingsGoals.bulkAdd(data.savingsGoals);
    await db.savingsContributions.bulkAdd(data.savingsContributions);
    await db.budgets.bulkAdd(data.budgets);
    await db.settings.add({ ...data.settings, id: "main" });
    await db.merchantRules.bulkAdd(data.merchantRules);
    await db.categories.bulkAdd(data.categories);
    await db.balanceAdjustments.bulkAdd(data.balanceAdjustments);
    await db.dailyCheckIns.bulkAdd(data.dailyCheckIns);
    await db.favorites.bulkAdd(data.favorites);
  });
}
