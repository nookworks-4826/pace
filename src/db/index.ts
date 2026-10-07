import { reviewReasons } from "../domain/practical";
import type { ExpenseInbox } from "../types";
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
  Account,
  Transfer,
  FinancialConnection,
  ExternalTransaction,
  SyncState,
  Receipt,
  SalaryRule,
  FinancialAudit,
  AccountAdjustment,
} from "../types";
import {
  installVaultMiddleware,
  type VaultMetadata,
  type VaultSession,
} from "./encryption";
import {
  assertMoney,
  calculateLiquidBalance,
  MAX_MONEY,
} from "../domain/finance";
import { dateKey, dateOnDay, monthKey, todayJST } from "../domain/dates";
import { learnMerchantRule, normalizeMerchant } from "../domain/categorization";
import { validateData } from "../domain/backup/schema";

import { APP_VERSION } from "../types";
export const defaultSettings: AppSettings = {
  practical: { welcomedVersion: APP_VERSION, preparedVersion: APP_VERSION },
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
  expenseInbox!: Table<ExpenseInbox, string>;
  accounts!: Table<Account, string>;
  transfers!: Table<Transfer, string>;
  financialConnections!: Table<FinancialConnection, string>;
  externalTransactions!: Table<ExternalTransaction, string>;
  syncStates!: Table<SyncState, string>;
  receipts!: Table<Receipt, string>;
  salaryRules!: Table<SalaryRule, string>;
  financialAudits!: Table<FinancialAudit, string>;
  accountAdjustments!: Table<AccountAdjustment, string>;
  providerCredentials!: Table<{ id: string; value: string }, string>;
  vaultMeta!: Table<VaultMetadata, string>;
  readonly vaultSession: VaultSession = {
    keys: null,
    migrating: false,
    hashes: new Map(),
  };
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
    this.version(3).stores({
      accounts: "id,kind,creditCardId,connectionId",
      transfers: "id,date,fromAccountId,toAccountId",
      financialConnections: "id,providerId",
      externalTransactions:
        "id,&[providerId+connectionId+externalTransactionId],accountId,date",
      syncStates: "id",
      receipts: "id,expenseId",
      salaryRules: "id,accountId",
      financialAudits: "id,recordId",
      accountAdjustments: "id,accountId,date",
      providerCredentials: "id",
      vaultMeta: "id",
    });
    this.version(4).stores({ expenseInbox: "id,expenseId" });
    installVaultMiddleware(this, this.vaultSession);
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
    for (const table of [this.transfers, this.accountAdjustments]) {
      table.hook("creating", (_key, value) => validateAutomationMoney(value));
      table.hook("updating", (changes, _key, value) =>
        validateAutomationMoney({ ...value, ...changes }),
      );
    }
    this.accounts.hook("creating", (_key, value) => validateAccount(value));
    this.accounts.hook("updating", (changes, _key, value) =>
      validateAccount({ ...value, ...changes }),
    );
    this.externalTransactions.hook("creating", (_key, value) =>
      validateExternalTransaction(value),
    );
    this.externalTransactions.hook("updating", (changes, _key, value) =>
      validateExternalTransaction({ ...value, ...changes }),
    );
  }
}
function validateAutomationMoney(value: Transfer | AccountAdjustment) {
  dateKey(value.date);
  if ("amount" in value) {
    assertMoney(value.amount);
    if (value.fromAccountId === value.toAccountId)
      throw new Error("移動元と移動先は異なる口座を選んでください。");
  } else
    for (const amount of [value.previousBalance, value.newBalance]) {
      if (!Number.isSafeInteger(amount) || Math.abs(amount) > MAX_MONEY)
        throw new Error("残高を確認してください。");
    }
}
function validateAccount(value: Account) {
  if (
    value.snapshotBalance !== null &&
    (!Number.isSafeInteger(value.snapshotBalance) ||
      Math.abs(value.snapshotBalance) > MAX_MONEY)
  )
    throw new Error("口座残高を確認してください。");
  if (!value.name.trim() || value.currency !== "JPY")
    throw new Error("口座名と通貨を確認してください。");
  if (
    value.snapshotBalance !== null &&
    (!value.balanceAsOf || !value.snapshotRecordedAt)
  )
    throw new Error("残高を確認した日時を入力してください。");
  if (value.balanceAsOf) dateKey(value.balanceAsOf);
}
function validateExternalTransaction(value: ExternalTransaction) {
  if (!Number.isSafeInteger(value.amount) || Math.abs(value.amount) > MAX_MONEY)
    throw new Error("金融明細の金額を確認してください。");
  dateKey(value.date);
  if (!value.externalTransactionId || !value.connectionId || !value.accountId)
    throw new Error("金融明細の関連付けを確認してください。");
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
    initialization = inspectAndPrepare().catch((error: unknown) => {
      db.vaultSession.readOnly = true;
      initialization = undefined;
      throw error;
    });
  return initialization;
}
async function inspectAndPrepare() {
  const { settings, data: existing } = await inspectStoredData();
  if (!settings) {
    const counts = await Promise.all(
      db.tables.filter((t) => t.name !== "vaultMeta").map((t) => t.count()),
    );
    if (counts.some((n) => n > 0))
      throw new Error(
        "設定の記録を確認できません。データを変更せず保護しています。",
      );
    db.vaultSession.readOnly = false;
    await db.transaction("rw", [db.settings, db.categories], async () => {
      await db.settings.add(structuredClone(defaultSettings));
      await db.categories.bulkAdd(structuredClone(defaultCategories));
    });
    return;
  }
  db.vaultSession.readOnly = false;
  if (settings.practical?.preparedVersion !== APP_VERSION)
    await db.transaction("rw", [db.settings, db.expenseInbox], async () => {
      for (const e of existing!.expenses) {
        const reasons = reviewReasons(e);
        if (reasons.length)
          await db.expenseInbox.put({ id: e.id, expenseId: e.id, reasons });
      }
      await db.settings.put({
        ...settings,
        notificationCenter:
          settings.notificationCenter &&
          settings.notificationCenter.intensity === undefined
            ? {
                ...settings.notificationCenter,
                intensity: "standard",
                rules: Object.fromEntries(
                  Object.entries(settings.notificationCenter.rules).map(
                    ([kind, rule]) => [
                      kind,
                      { ...rule, explicitlyConfigured: true },
                    ],
                  ),
                ) as NonNullable<AppSettings["notificationCenter"]>["rules"],
              }
            : settings.notificationCenter,
        practical: { ...settings.practical, preparedVersion: APP_VERSION },
      });
    });
}
export async function inspectStoredData(database: PaceDatabase = db) {
  try {
    return await database.transaction("r", database.tables, async () => {
      const settings = await database.settings.get("main");
      await database.drafts.toArray();
      await database.providerCredentials.toArray();
      await database.vaultMeta.toArray();
      const data = await readAppData(true, database);
      if (!settings) {
        const counts = await Promise.all(
          database.tables
            .filter((t) => t.name !== "vaultMeta")
            .map((t) => t.count()),
        );
        if (counts.some((n) => n > 0))
          throw new Error("設定の記録を確認できません。");
        return { settings, data: null };
      }
      return { settings, data: validateData(data) };
    });
  } catch (error) {
    database.vaultSession.readOnly = true;
    throw error;
  }
}
export async function readAppData(
  includeImages = true,
  database: PaceDatabase = db,
): Promise<AppData> {
  // A read transaction gives finance one coherent snapshot while writes are in flight.
  return database.transaction("r", database.tables, async () => {
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
      accounts,
      expenseInbox,
      transfers,
      financialConnections,
      externalTransactions,
      syncStates,
      receipts,
      salaryRules,
      financialAudits,
      accountAdjustments,
    ] = await Promise.all([
      database.expenses.toArray(),
      database.incomes.toArray(),
      database.cards.toArray(),
      database.cardPayments.toArray(),
      database.debts.toArray(),
      database.repayments.toArray(),
      database.recurringExpenses.toArray(),
      database.recurringOccurrences.toArray(),
      database.savingsGoals.toArray(),
      database.savingsContributions.toArray(),
      database.budgets.toArray(),
      database.settings.get("main"),
      database.merchantRules.toArray(),
      database.categories.toArray(),
      database.balanceAdjustments.toArray(),
      database.dailyCheckIns.toArray(),
      database.favorites.toArray(),
      database.accounts.toArray(),
      database.expenseInbox.toArray(),
      database.transfers.toArray(),
      database.financialConnections.toArray(),
      database.externalTransactions.toArray(),
      database.syncStates.toArray(),
      includeImages ? database.receipts.toArray() : Promise.resolve([]),
      database.salaryRules.toArray(),
      database.financialAudits.toArray(),
      database.accountAdjustments.toArray(),
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
      accounts,
      expenseInbox,
      transfers,
      financialConnections,
      externalTransactions,
      syncStates,
      receipts,
      salaryRules,
      financialAudits,
      accountAdjustments,
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
      db.receipts,
      db.externalTransactions,
      db.expenseInbox,
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
      const reasons = reviewReasons(expense);
      if (reasons.length)
        await db.expenseInbox.put({
          id: expense.id,
          expenseId: expense.id,
          reasons,
        });
      else await db.expenseInbox.delete(expense.id);
      if (expense.receiptId) {
        const receipt = await db.receipts.get(expense.receiptId);
        if (!receipt)
          throw new Error("レシートが見つかりません。添付を確認してください。");
        await db.receipts.put({ ...receipt, expenseId: expense.id });
      }
      if (
        expense.providerId &&
        expense.connectionId &&
        expense.externalTransactionId
      ) {
        const external = await db.externalTransactions
          .where("[providerId+connectionId+externalTransactionId]")
          .equals([
            expense.providerId,
            expense.connectionId,
            expense.externalTransactionId,
          ])
          .first();
        if (external)
          await db.externalTransactions.put({
            ...external,
            kind: "expense",
            linkedRecordId: expense.id,
          });
      }
      const normalized = normalizeMerchant(expense.merchant);
      const rule = learnMerchantRule(
        expense.merchant,
        expense.categoryId,
        expense.subcategoryId,
        normalized ? await db.merchantRules.get(normalized) : undefined,
      );
      if (rule && expense.merchant !== "支出") await db.merchantRules.put(rule);
    },
  );
}
export async function deleteExpense(id: string): Promise<Expense | undefined> {
  return db.transaction(
    "rw",
    [
      db.expenses,
      db.recurringOccurrences,
      db.receipts,
      db.externalTransactions,
      db.expenseInbox,
    ],
    async () => {
      const expense = await db.expenses.get(id);
      if (!expense) return undefined;
      await db.expenses.delete(id);
      await db.expenseInbox.delete(id);
      if (expense.recurringOccurrenceId)
        await db.recurringOccurrences.delete(expense.recurringOccurrenceId);
      const receipts = await db.receipts
        .where("expenseId")
        .equals(id)
        .toArray();
      for (const receipt of receipts)
        await db.receipts.put({ ...receipt, expenseId: undefined });
      for (const external of await db.externalTransactions.toArray()) {
        if (external.kind === "expense" && external.linkedRecordId === id)
          await db.externalTransactions.put({
            ...external,
            kind: "ignored",
            linkedRecordId: undefined,
          });
        else if (external.relatedExpenseId === id)
          await db.externalTransactions.put({
            ...external,
            relatedExpenseId: undefined,
          });
      }
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

async function resetFinancialSession<T>(action: () => Promise<T>): Promise<T> {
  // Invalidate local in-flight requests before replacing their authorization state.
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("pace:financial-reset"));
  const keys = [
    ...new Set([
      "moneytree:default",
      ...(await db.providerCredentials.toArray()).map((row) => row.id),
    ]),
  ].sort();
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  const withLock = (index: number): Promise<T> =>
    !locks || index === keys.length
      ? action()
      : locks.request(`pace:moneytree:state:${keys[index]}`, () =>
          withLock(index + 1),
        );
  // The provider uses these same state locks and rejects responses from a removed
  // session. Another tab therefore cannot restore a token between clear and write.
  return withLock(0);
}

export async function clearAllData(): Promise<void> {
  await resetFinancialSession(() =>
    db.transaction("rw", db.tables, async () => {
      for (const table of db.tables)
        if (table.name !== "vaultMeta") await table.clear();
      await db.settings.add({
        ...structuredClone(defaultSettings),
        lastSeenMonth: monthKey(todayJST()),
      });
      await db.categories.bulkAdd(structuredClone(defaultCategories));
    }),
  );
}
export async function restoreAppData(data: AppData): Promise<void> {
  // Importers validate the full versioned envelope first; all table changes commit together.
  data = validateData(data);
  validateSettings(data.settings);
  await resetFinancialSession(() =>
    db.transaction("rw", db.tables, async () => {
      for (const table of db.tables)
        if (table.name !== "vaultMeta") await table.clear();
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
      const restoredSettings = structuredClone(data.settings);
      const health = restoredSettings.practical?.backupHealth;
      // A confirmation from another device does not verify this device's saved file.
      if (health?.status === "normal") {
        restoredSettings.practical!.backupHealth = {
          ...health,
          status: "review",
          savedConfirmed: false,
        };
      }
      await db.settings.add({ ...restoredSettings, id: "main" });
      await db.merchantRules.bulkAdd(data.merchantRules);
      await db.categories.bulkAdd(data.categories);
      await db.balanceAdjustments.bulkAdd(data.balanceAdjustments);
      await db.dailyCheckIns.bulkAdd(data.dailyCheckIns);
      await db.favorites.bulkAdd(data.favorites);
      await db.expenseInbox.bulkAdd(
        data.expenseInbox ??
          data.expenses.flatMap((e) => {
            const reasons = reviewReasons(e);
            return reasons.length
              ? [{ id: e.id, expenseId: e.id, reasons }]
              : [];
          }),
      );
      await db.accounts.bulkAdd(data.accounts ?? []);
      await db.transfers.bulkAdd(data.transfers ?? []);
      // A restored backup retains records but never grants provider authorization.
      await db.financialConnections.bulkAdd(
        (data.financialConnections ?? []).map((row) => ({
          ...row,
          status: "disconnected" as const,
        })),
      );
      await db.externalTransactions.bulkAdd(data.externalTransactions ?? []);
      await db.syncStates.bulkAdd(
        (data.syncStates ?? []).map((row) => ({
          ...row,
          status: "reauthentication" as const,
          message: "金融連携をもう一度設定してください。",
        })),
      );
      await db.receipts.bulkAdd(data.receipts ?? []);
      await db.salaryRules.bulkAdd(data.salaryRules ?? []);
      await db.financialAudits.bulkAdd(data.financialAudits ?? []);
      await db.accountAdjustments.bulkAdd(data.accountAdjustments ?? []);
    }),
  );
}
