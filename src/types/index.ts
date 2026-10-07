export type ID = string;
import type { ExpenseInbox, PracticalSettings } from "./practical.ts";
export * from "./practical.ts";
import type {
  AppearanceSettings,
  NotificationCenterConfig,
  PersonalizationSettings,
} from "./experience.ts";
export * from "./experience.ts";
import type {
  Account,
  Transfer,
  ExternalMetadata,
  FinancialConnection,
  ExternalTransaction,
  SyncState,
  Receipt,
  SalaryRule,
  FinancialAudit,
  AccountAdjustment,
  BudgetCycleConfig,
  ReminderSettings,
  PaymentChannel,
} from "./automation.ts";
export * from "./automation.ts";
export type PaymentMethod = "cash" | "debit" | "bank" | "creditCard" | "other";
export interface Stamped {
  id: ID;
  createdAt: string;
  updatedAt: string;
}
export interface Category {
  id: ID;
  name: string;
  color: string;
  icon: string;
  subcategories: { id: ID; name: string }[];
  archived?: boolean;
}
export interface Expense extends Stamped, ExternalMetadata {
  reviewed?: boolean;
  ocrNeedsReview?: boolean;
  paymentNeedsReview?: boolean;
  inputOrigin?: "manual" | "receipt";
  externalMergedFromManual?: boolean;
  sourceAccountId?: ID;
  paymentChannel?: PaymentChannel;
  receiptId?: ID;
  amount: number;
  date: string;
  merchant: string;
  description: string;
  categoryId: ID;
  subcategoryId: ID;
  paymentMethod: PaymentMethod;
  creditCardId?: ID;
  memo: string;
  isFixedCost: boolean;
  recurringOccurrenceId?: ID;
}
export interface Income extends Stamped, ExternalMetadata {
  sourceAccountId?: ID;
  amount: number;
  date: string;
  source: string;
  memo: string;
  type: "salary" | "temporary" | "other";
}
export interface CreditCard extends Stamped {
  name: string;
  last4: string;
  closingDay: number;
  paymentDay: number;
  paymentMonthOffset: 1 | 2;
  openingOutstanding: number;
  isActive: boolean;
}
export interface CardPayment extends Stamped {
  sourceAccountId?: ID;
  creditCardId: ID;
  amount: number;
  date: string;
  memo: string;
}
export interface Debt extends Stamped {
  reserveForCurrentBudget?: boolean;
  lenderName: string;
  title: string;
  originalAmount: number;
  openingBalance: number;
  currentBalance: number;
  startedAt: string;
  plannedMonthlyPayment: number;
  nextPaymentDate: string;
  note: string;
  isEstimated: boolean;
  cashReceived: boolean;
  status: "active" | "paid";
}
export interface DebtRepayment {
  createdAt?: string;
  updatedAt?: string;
  sourceAccountId?: ID;
  id: ID;
  debtId: ID;
  amount: number;
  date: string;
  memo: string;
}
export interface SavingsGoal {
  id: ID;
  name: string;
  targetAmount: number;
  openingAmount: number;
  currentAmount: number;
  targetDate: string;
  monthlyTarget: number;
  createdAt: string;
  completedAt?: string;
}
export interface SavingsContribution {
  createdAt?: string;
  updatedAt?: string;
  sourceAccountId?: ID;
  id: ID;
  savingsGoalId: ID;
  amount: number;
  date: string;
  memo: string;
}
export interface RecurringExpense {
  sourceAccountId?: ID;
  id: ID;
  name: string;
  amount: number;
  categoryId: ID;
  subcategoryId: ID;
  paymentMethod: PaymentMethod;
  creditCardId?: ID;
  frequency: "monthly" | "yearly";
  dueDay: number;
  startDate: string;
  endDate?: string;
  isActive: boolean;
  note: string;
}
export interface RecurringOccurrence {
  id: ID;
  recurringExpenseId: ID;
  dueDate: string;
  status: "paid" | "skipped";
  expenseId?: ID;
}
export interface Budget extends Stamped {
  year: number;
  month: number;
  totalBudget: number;
  categoryBudgets: Record<ID, number>;
}
export interface BalanceAdjustment {
  id: ID;
  previousBalance: number;
  newBalance: number;
  difference: number;
  date: string;
  memo: string;
}
export interface MerchantCategoryRule {
  normalizedMerchant: string;
  categoryId: ID;
  subcategoryId: ID;
  usageCount: number;
  lastUsedAt: string;
}
export interface DailyCheckIn {
  date: string;
  noSpendingConfirmed: boolean;
  confirmedAt: string;
}
export interface Favorite {
  sourceAccountId?: ID;
  paymentChannel?: PaymentChannel;
  id: ID;
  name: string;
  amount: number;
  memo?: string;
  merchant: string;
  categoryId: ID;
  subcategoryId: ID;
  paymentMethod: PaymentMethod;
  creditCardId?: ID;
}
export interface SalarySchedule {
  payday: number;
  expectedAmount: number | null;
  variableIncome: boolean;
}
export interface AppSettings {
  practical?: PracticalSettings;
  personalization?: PersonalizationSettings;
  notificationCenter?: NotificationCenterConfig;
  appearance?: AppearanceSettings;
  budgetCycle?: BudgetCycleConfig;
  financialAutomationEnabled?: boolean;
  reminder?: ReminderSettings;
  saveReceiptImages?: boolean;
  id: "main";
  openingLiquidBalance: number | null;
  salarySchedule: SalarySchedule | null;
  theme:
    "default" | "softWhite" | "glassLight" | "midnight" | "forest" | "mono";
  colorMode: "system" | "light" | "dark";
  onboardingCompleted: boolean;
  setupReviewed: string[];
  helpDismissed: boolean;
  lastBackupAt: string | null;
  lastSeenMonth: string;
  lockAfterSeconds: 0 | 60 | 300 | 900;
}
export interface AppData {
  expenseInbox?: ExpenseInbox[];
  accounts?: Account[];
  transfers?: Transfer[];
  financialConnections?: FinancialConnection[];
  externalTransactions?: ExternalTransaction[];
  syncStates?: SyncState[];
  receipts?: Receipt[];
  salaryRules?: SalaryRule[];
  financialAudits?: FinancialAudit[];
  accountAdjustments?: AccountAdjustment[];
  expenses: Expense[];
  incomes: Income[];
  cards: CreditCard[];
  cardPayments: CardPayment[];
  debts: Debt[];
  repayments: DebtRepayment[];
  recurringExpenses: RecurringExpense[];
  recurringOccurrences: RecurringOccurrence[];
  savingsGoals: SavingsGoal[];
  savingsContributions: SavingsContribution[];
  budgets: Budget[];
  settings: AppSettings;
  merchantRules: MerchantCategoryRule[];
  categories: Category[];
  balanceAdjustments: BalanceAdjustment[];
  dailyCheckIns: DailyCheckIn[];
  favorites: Favorite[];
}
export const APP_NAME = "Pace";
export const APP_VERSION = "2.2.1";
export const SCHEMA_VERSION = 4;
export const paymentLabels: Record<PaymentMethod, string> = {
  cash: "現金",
  debit: "デビット",
  bank: "銀行引落",
  creditCard: "カード",
  other: "その他",
};
