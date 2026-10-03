import { z } from "zod";
import { APP_VERSION, SCHEMA_VERSION, type AppData } from "../../types";
import { MAX_MONEY } from "../finance";
import { dateKey, isDateKey, monthKey } from "../dates";

const text = z.string().max(10_000);
const id = z.string().min(1).max(300);
const money = z.number().int().min(0).max(MAX_MONEY);
const signedMoney = z.number().int().min(-MAX_MONEY).max(MAX_MONEY);
const positive = money.refine((value) => value > 0);
const validDate = (value: string): boolean => {
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      value,
    )
  )
    return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (year < 1900 || year > 9999) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    Number.isFinite(Date.parse(value))
  );
};
const date = z.string().refine(validDate);
const optionalDate = z.union([date, z.literal("")]);
const stamp = { id, createdAt: date, updatedAt: date };
const method = z.enum(["cash", "debit", "bank", "creditCard", "other"]);
const category = { categoryId: id, subcategoryId: z.string().max(300) };
const payment = { paymentMethod: method, creditCardId: id.optional() };
const sourceAccount = { sourceAccountId: id.optional() };
const paymentChannel = z.enum(["direct", "applePay", "other"]).optional();
const providerId = z.enum(["moneytree", "manual", "mock"]);
const balanceEffect = z.enum(["snapshot", "ledger"]).optional();
const externalMetadata = {
  providerId: providerId.optional(),
  connectionId: id.optional(),
  externalTransactionId: id.optional(),
  externalAccountId: id.optional(),
  pendingStatus: z.enum(["pending", "posted", "unknown"]).optional(),
  originalCurrency: z.string().min(1).max(10).optional(),
  originalAmount: z.number().finite().min(-MAX_MONEY).max(MAX_MONEY).optional(),
  finalJPYAmount: money.optional(),
  feeAmount: money.optional(),
  balanceEffect,
};
const entries = <T extends z.ZodType>(schema: T) =>
  z.array(schema).max(250_000);
const settings = z
  .object({
    id: z.literal("main"),
    openingLiquidBalance: money.nullable(),
    salarySchedule: z
      .object({
        payday: z.number().int().min(1).max(31),
        expectedAmount: money.nullable(),
        variableIncome: z.boolean(),
      })
      .strict()
      .nullable(),
    theme: z.enum(["default", "midnight", "forest", "mono"]),
    colorMode: z.enum(["system", "light", "dark"]),
    onboardingCompleted: z.boolean(),
    setupReviewed: z.array(z.string().max(100)).max(100),
    helpDismissed: z.boolean(),
    lastBackupAt: date.nullable(),
    lastSeenMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$|^$/),
    lockAfterSeconds: z.union([
      z.literal(0),
      z.literal(60),
      z.literal(300),
      z.literal(900),
    ]),
    budgetCycle: z
      .object({
        mode: z.enum(["calendar", "salary"]),
        startDay: z.number().int().min(1).max(31),
      })
      .strict()
      .optional(),
    financialAutomationEnabled: z.boolean().optional(),
    reminder: z
      .object({
        enabled: z.boolean(),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        privacyMode: z.literal("generic"),
        delivery: z.enum(["calendar", "foreground"]),
        lastNotifiedDate: date.optional(),
      })
      .strict()
      .optional(),
    saveReceiptImages: z.boolean().optional(),
  })
  .strict();

export const appDataSchema = z
  .object({
    expenses: entries(
      z
        .object({
          ...stamp,
          amount: positive,
          date,
          merchant: text,
          description: text,
          ...category,
          ...payment,
          ...sourceAccount,
          ...externalMetadata,
          paymentChannel,
          receiptId: id.optional(),
          externalMergedFromManual: z.boolean().optional(),
          memo: text,
          isFixedCost: z.boolean(),
          recurringOccurrenceId: id.optional(),
        })
        .strict(),
    ),
    incomes: entries(
      z
        .object({
          ...stamp,
          amount: positive,
          date,
          source: text,
          memo: text,
          type: z.enum(["salary", "temporary", "other"]),
          ...sourceAccount,
          ...externalMetadata,
        })
        .strict(),
    ),
    cards: entries(
      z
        .object({
          ...stamp,
          name: text,
          last4: z.string().regex(/^\d{4}$|^$/),
          closingDay: z.number().int().min(1).max(31),
          paymentDay: z.number().int().min(1).max(31),
          paymentMonthOffset: z.union([z.literal(1), z.literal(2)]),
          openingOutstanding: money,
          isActive: z.boolean(),
        })
        .strict(),
    ),
    cardPayments: entries(
      z
        .object({
          ...stamp,
          creditCardId: id,
          ...sourceAccount,
          amount: positive,
          date,
          memo: text,
        })
        .strict(),
    ),
    debts: entries(
      z
        .object({
          ...stamp,
          lenderName: text,
          title: text,
          originalAmount: positive,
          openingBalance: money,
          currentBalance: money,
          startedAt: date,
          plannedMonthlyPayment: money,
          nextPaymentDate: optionalDate,
          note: text,
          isEstimated: z.boolean(),
          cashReceived: z.boolean(),
          status: z.enum(["active", "paid"]),
          reserveForCurrentBudget: z.boolean().optional(),
        })
        .strict(),
    ),
    repayments: entries(
      z
        .object({
          id,
          createdAt: date.optional(),
          updatedAt: date.optional(),
          debtId: id,
          amount: positive,
          date,
          memo: text,
          ...sourceAccount,
        })
        .strict(),
    ),
    recurringExpenses: entries(
      z
        .object({
          id,
          name: text,
          amount: positive,
          ...category,
          ...payment,
          ...sourceAccount,
          frequency: z.enum(["monthly", "yearly"]),
          dueDay: z.number().int().min(1).max(31),
          startDate: date,
          endDate: optionalDate.optional(),
          isActive: z.boolean(),
          note: text,
        })
        .strict(),
    ),
    recurringOccurrences: entries(
      z
        .object({
          id,
          recurringExpenseId: id,
          dueDate: date,
          status: z.enum(["paid", "skipped"]),
          expenseId: id.optional(),
        })
        .strict(),
    ),
    savingsGoals: entries(
      z
        .object({
          id,
          name: text,
          targetAmount: positive,
          openingAmount: money,
          currentAmount: money,
          targetDate: optionalDate,
          monthlyTarget: money,
          createdAt: date,
          completedAt: date.optional(),
        })
        .strict(),
    ),
    savingsContributions: entries(
      z
        .object({
          id,
          createdAt: date.optional(),
          updatedAt: date.optional(),
          savingsGoalId: id,
          amount: positive,
          date,
          memo: text,
          ...sourceAccount,
        })
        .strict(),
    ),
    budgets: entries(
      z
        .object({
          ...stamp,
          year: z.number().int().min(1900).max(9999),
          month: z.number().int().min(1).max(12),
          totalBudget: money,
          categoryBudgets: z.record(id, money),
        })
        .strict(),
    ),
    settings,
    merchantRules: entries(
      z
        .object({
          normalizedMerchant: id,
          ...category,
          usageCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          lastUsedAt: date,
        })
        .strict(),
    ),
    categories: entries(
      z
        .object({
          id,
          name: text,
          color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
          icon: z.string().max(100),
          subcategories: z
            .array(z.object({ id, name: text }).strict())
            .max(1000),
          archived: z.boolean().optional(),
        })
        .strict(),
    ),
    balanceAdjustments: entries(
      z
        .object({
          id,
          previousBalance: signedMoney,
          newBalance: signedMoney,
          difference: signedMoney,
          date,
          memo: text,
        })
        .strict(),
    ),
    dailyCheckIns: entries(
      z
        .object({ date, noSpendingConfirmed: z.boolean(), confirmedAt: date })
        .strict(),
    ),
    favorites: entries(
      z
        .object({
          id,
          name: text,
          amount: positive,
          merchant: text,
          ...category,
          ...payment,
          ...sourceAccount,
          paymentChannel,
        })
        .strict(),
    ),
    accounts: entries(
      z
        .object({
          ...stamp,
          name: text,
          kind: z.enum([
            "BANK",
            "CASH",
            "EWALLET",
            "CREDIT_CARD",
            "SAVINGS",
            "OTHER",
          ]),
          institutionName: text,
          currency: z.literal("JPY"),
          snapshotBalance: signedMoney.nullable(),
          balanceAsOf: optionalDate,
          snapshotRecordedAt: optionalDate,
          balanceSource: z.enum(["manual", "provider"]),
          creditCardId: id.optional(),
          providerId: providerId.optional(),
          connectionId: id.optional(),
          externalAccountId: id.optional(),
          isSpendable: z.boolean(),
          isActive: z.boolean(),
          automationLevel: z.enum(["automatic", "semi", "manual"]),
        })
        .strict(),
    ).optional(),
    transfers: entries(
      z
        .object({
          ...stamp,
          fromAccountId: id,
          toAccountId: id,
          amount: positive,
          date,
          memo: text,
          fromBalanceEffect: balanceEffect,
          toBalanceEffect: balanceEffect,
          externalTransactionIds: z.array(id).max(100).optional(),
          status: z.enum(["confirmed", "reversed"]),
        })
        .strict(),
    ).optional(),
    financialConnections: entries(
      z
        .object({
          ...stamp,
          providerId,
          status: z.enum(["connected", "reauthentication", "disconnected"]),
          institutionIds: z.array(id).max(500),
          consentedAt: date,
        })
        .strict(),
    ).optional(),
    externalTransactions: entries(
      z
        .object({
          ...stamp,
          providerId,
          connectionId: id,
          externalTransactionId: id,
          externalAccountId: id,
          accountId: id,
          date,
          amount: signedMoney,
          description: text,
          currency: z.string().min(1).max(10),
          pendingStatus: z.enum(["pending", "posted", "unknown"]),
          externalUpdatedAt: date,
          kind: z.enum([
            "unclassified",
            "expense",
            "income",
            "transfer",
            "refund",
            "cardPayment",
            "ignored",
          ]),
          linkedRecordId: id.optional(),
          relatedExpenseId: id.optional(),
          originalCurrency: z.string().min(1).max(10).optional(),
          originalAmount: z
            .number()
            .finite()
            .min(-MAX_MONEY)
            .max(MAX_MONEY)
            .optional(),
          finalJPYAmount: money.optional(),
          balanceEffect,
        })
        .strict(),
    ).optional(),
    syncStates: entries(
      z
        .object({
          id,
          lastAttemptAt: date.nullable(),
          lastSuccessAt: date.nullable(),
          nextRefreshAllowedAt: date.nullable(),
          status: z.enum([
            "idle",
            "syncing",
            "offline",
            "reauthentication",
            "maintenance",
            "rateLimited",
            "error",
          ]),
          message: text,
        })
        .strict(),
    ).optional(),
    receipts: entries(
      z
        .object({
          ...stamp,
          expenseId: id.optional(),
          mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
          imageBase64: z
            .string()
            .min(4)
            .max(15_000_000)
            .regex(/^[A-Za-z0-9+/]*={0,2}$/)
            .refine((value) => value.length % 4 === 0),
        })
        .strict(),
    ).optional(),
    salaryRules: entries(
      z
        .object({
          ...stamp,
          accountId: id,
          normalizedDescription: text,
          enabled: z.boolean(),
        })
        .strict(),
    ).optional(),
    financialAudits: entries(
      z
        .object({
          ...stamp,
          action: z.string().min(1).max(100),
          recordId: id,
          detail: text,
        })
        .strict(),
    ).optional(),
    accountAdjustments: entries(
      z
        .object({
          ...stamp,
          accountId: id,
          previousBalance: signedMoney,
          newBalance: signedMoney,
          date,
          memo: text,
        })
        .strict(),
    ).optional(),
  })
  .strict();

const backupSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    metadata: z
      .object({
        appVersion: z.string().min(1).max(100),
        schemaVersion: z.union([z.literal(1), z.literal(2)]),
        exportedAt: date,
      })
      .strict(),
    data: appDataSchema,
  })
  .strict();

/** Restores are validated fully before opening the IndexedDB replacement transaction. */
export function validateData(value: unknown): AppData {
  const data: AppData = appDataSchema.parse(value);
  // The UI stores civil accounting dates as YYYY-MM-DD. Older/imported ISO timestamps
  // are converted once at this boundary, so date inputs and lexical ranges agree with
  // the JST finance domain. Zod parsing cloned the input; the caller is not mutated.
  const civilDate = (value: string): string => {
    const normalized = dateKey(value);
    if (!isDateKey(normalized))
      throw new Error("日付が対応している範囲を超えています。");
    return normalized;
  };
  for (const row of [
    ...data.expenses,
    ...data.incomes,
    ...data.cardPayments,
    ...data.repayments,
    ...data.savingsContributions,
    ...data.balanceAdjustments,
    ...data.dailyCheckIns,
    ...(data.transfers ?? []),
    ...(data.externalTransactions ?? []),
    ...(data.accountAdjustments ?? []),
  ])
    row.date = civilDate(row.date);
  for (const row of data.debts) {
    row.startedAt = civilDate(row.startedAt);
    if (row.nextPaymentDate)
      row.nextPaymentDate = civilDate(row.nextPaymentDate);
  }
  for (const row of data.recurringExpenses) {
    row.startDate = civilDate(row.startDate);
    if (row.endDate) row.endDate = civilDate(row.endDate);
  }
  for (const row of data.recurringOccurrences)
    row.dueDate = civilDate(row.dueDate);
  for (const row of data.savingsGoals)
    if (row.targetDate) row.targetDate = civilDate(row.targetDate);
  const fail = () => {
    throw new Error("バックアップ内のデータの関連付けを確認できませんでした。");
  };
  const unique = (keys: string[]) => {
    if (new Set(keys).size !== keys.length) fail();
  };
  let records = 0;
  for (const list of Object.values(data)) {
    if (!Array.isArray(list)) continue;
    records += list.length;
    const keyed = list.filter((row): row is { id: string } => "id" in row);
    unique(keyed.map((row) => row.id));
  }
  if (records > 250_000) fail();
  unique(data.merchantRules.map((row) => row.normalizedMerchant));
  unique(data.dailyCheckIns.map((row) => row.date));
  unique(data.budgets.map((row) => `${row.year}-${row.month}`));
  const categories = new Map(data.categories.map((row) => [row.id, row]));
  for (const row of data.categories)
    unique(row.subcategories.map((sub) => sub.id));
  const cards = new Set(data.cards.map((row) => row.id));
  const debts = new Set(data.debts.map((row) => row.id));
  const goals = new Set(data.savingsGoals.map((row) => row.id));
  const recurring = new Set(data.recurringExpenses.map((row) => row.id));
  const occurrences = new Map(
    data.recurringOccurrences.map((row) => [row.id, row]),
  );
  const expenses = new Map(data.expenses.map((row) => [row.id, row]));
  const accounts = new Map((data.accounts ?? []).map((row) => [row.id, row]));
  const connections = new Map(
    (data.financialConnections ?? []).map((row) => [row.id, row]),
  );
  const transfers = new Map((data.transfers ?? []).map((row) => [row.id, row]));
  const incomes = new Map(data.incomes.map((row) => [row.id, row]));
  const receipts = new Map((data.receipts ?? []).map((row) => [row.id, row]));
  unique(
    (data.externalTransactions ?? []).map((row) =>
      JSON.stringify([
        row.providerId,
        row.connectionId,
        row.externalTransactionId,
      ]),
    ),
  );
  for (const account of accounts.values()) {
    if (
      account.snapshotBalance !== null &&
      (!account.balanceAsOf || !account.snapshotRecordedAt)
    )
      fail();
    if (
      account.creditCardId &&
      (!cards.has(account.creditCardId) || account.kind !== "CREDIT_CARD")
    )
      fail();
    if (account.kind === "CREDIT_CARD" && account.isSpendable) fail();
    if (account.connectionId && !connections.has(account.connectionId)) fail();
    if (
      account.balanceSource === "provider" &&
      (!account.connectionId ||
        !account.externalAccountId ||
        !account.providerId)
    )
      fail();
  }
  for (const row of [
    ...data.expenses,
    ...data.incomes,
    ...data.cardPayments,
    ...data.repayments,
    ...data.savingsContributions,
    ...data.recurringExpenses,
    ...data.favorites,
  ]) {
    if (row.sourceAccountId && !accounts.has(row.sourceAccountId)) fail();
    if (
      "connectionId" in row &&
      row.connectionId &&
      !connections.has(row.connectionId)
    )
      fail();
  }
  for (const row of data.transfers ?? [])
    if (
      !accounts.has(row.fromAccountId) ||
      !accounts.has(row.toAccountId) ||
      row.fromAccountId === row.toAccountId
    )
      fail();
  for (const row of data.externalTransactions ?? []) {
    const connection = connections.get(row.connectionId);
    if (
      !accounts.has(row.accountId) ||
      !connection ||
      connection.providerId !== row.providerId
    )
      fail();
    if (row.linkedRecordId) {
      if (row.kind === "expense" && !expenses.has(row.linkedRecordId)) fail();
      if (row.kind === "income" && !incomes.has(row.linkedRecordId)) fail();
      if (row.kind === "transfer" && !transfers.has(row.linkedRecordId)) fail();
      if (
        row.kind === "cardPayment" &&
        !data.cardPayments.some(
          (payment) => payment.id === row.linkedRecordId,
        ) &&
        !transfers.has(row.linkedRecordId)
      )
        fail();
    }
    if (row.relatedExpenseId && !expenses.has(row.relatedExpenseId)) fail();
  }
  for (const row of data.receipts ?? [])
    if (row.expenseId && !expenses.has(row.expenseId)) fail();
  for (const row of data.expenses)
    if (
      row.receiptId &&
      (!receipts.has(row.receiptId) ||
        receipts.get(row.receiptId)?.expenseId !== row.id)
    )
      fail();
  for (const row of [
    ...(data.salaryRules ?? []),
    ...(data.accountAdjustments ?? []),
  ])
    if (!accounts.has(row.accountId)) fail();
  for (const row of [
    ...data.expenses,
    ...data.recurringExpenses,
    ...data.merchantRules,
    ...data.favorites,
  ]) {
    const parent = categories.get(row.categoryId);
    if (
      !parent ||
      (row.subcategoryId &&
        !parent.subcategories.some((sub) => sub.id === row.subcategoryId))
    )
      fail();
    if (
      "paymentMethod" in row &&
      row.paymentMethod === "creditCard" &&
      (!row.creditCardId || !cards.has(row.creditCardId))
    )
      fail();
    if (
      "creditCardId" in row &&
      row.creditCardId &&
      !cards.has(row.creditCardId)
    )
      fail();
  }
  for (const row of data.cardPayments) if (!cards.has(row.creditCardId)) fail();
  for (const row of data.repayments) if (!debts.has(row.debtId)) fail();
  for (const row of data.savingsContributions)
    if (!goals.has(row.savingsGoalId)) fail();
  for (const row of data.recurringOccurrences) {
    if (!recurring.has(row.recurringExpenseId)) fail();
    // A fixed-cost occurrence is identified by its JST month. A shifted/mismatched
    // ID must be rejected rather than allowing the same month's reservation twice.
    if (row.id !== `${row.recurringExpenseId}:${monthKey(row.dueDate)}`) fail();
    if (
      row.status === "paid" &&
      (!row.expenseId ||
        expenses.get(row.expenseId)?.recurringOccurrenceId !== row.id)
    )
      fail();
    if (row.status === "skipped" && row.expenseId) fail();
  }
  for (const row of data.recurringExpenses)
    if (row.endDate && row.endDate.slice(0, 10) < row.startDate.slice(0, 10))
      fail();
  for (const row of data.expenses)
    if (
      row.recurringOccurrenceId &&
      occurrences.get(row.recurringOccurrenceId)?.expenseId !== row.id
    )
      fail();
  for (const row of data.budgets)
    for (const key of Object.keys(row.categoryBudgets))
      if (!categories.has(key)) fail();
  for (const row of data.balanceAdjustments)
    if (row.newBalance - row.previousBalance !== row.difference) fail();
  // Bound combined monetary values too, so otherwise valid integers cannot overflow a sum.
  let aggregate = Math.abs(data.settings.openingLiquidBalance ?? 0);
  const moneyKeys = new Set([
    "amount",
    "openingOutstanding",
    "originalAmount",
    "openingBalance",
    "currentBalance",
    "plannedMonthlyPayment",
    "targetAmount",
    "openingAmount",
    "currentAmount",
    "monthlyTarget",
    "totalBudget",
    "previousBalance",
    "newBalance",
    "difference",
    "snapshotBalance",
    "originalAmount",
    "finalJPYAmount",
    "feeAmount",
  ]);
  for (const rows of Object.values(data))
    if (Array.isArray(rows))
      for (const row of rows) {
        for (const [key, value] of Object.entries(row))
          if (moneyKeys.has(key) && typeof value === "number") {
            // Original foreign-currency amounts can have fractional units.
            aggregate += Math.ceil(Math.abs(value));
            if (!Number.isSafeInteger(aggregate)) fail();
          }
      }
  return data;
}

export function makeBackupObject(data: AppData) {
  return {
    schemaVersion: SCHEMA_VERSION,
    metadata: {
      appVersion: APP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
    },
    data: validateData(data),
  };
}

export function validateBackup(value: unknown): AppData {
  const envelope = backupSchema.parse(value);
  if (envelope.schemaVersion !== envelope.metadata.schemaVersion)
    throw new Error("Backup schema version mismatch");
  return validateData(envelope.data);
}
