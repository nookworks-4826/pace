import type { Stamped } from "./index.ts";

export type AccountKind =
  "BANK" | "CASH" | "EWALLET" | "CREDIT_CARD" | "SAVINGS" | "OTHER";
export type FinancialProviderId = "moneytree" | "manual" | "mock";
export type BalanceEffect = "snapshot" | "ledger";
export type PaymentChannel = "direct" | "applePay" | "other";
export type AutomationLevel = "automatic" | "semi" | "manual";
export interface Account extends Stamped {
  lastVerifiedAt?: string;
  archivedAt?: string;
  verificationDays?: import("./practical").VerificationDays;
  name: string;
  kind: AccountKind;
  institutionName: string;
  currency: "JPY";
  snapshotBalance: number | null;
  balanceAsOf: string;
  snapshotRecordedAt: string;
  balanceSource: "manual" | "provider";
  creditCardId?: string;
  providerId?: FinancialProviderId;
  connectionId?: string;
  externalAccountId?: string;
  isSpendable: boolean;
  isActive: boolean;
  automationLevel: AutomationLevel;
}
export interface Transfer extends Stamped {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  date: string;
  memo: string;
  fromBalanceEffect?: BalanceEffect;
  toBalanceEffect?: BalanceEffect;
  externalTransactionIds?: string[];
  status: "confirmed" | "reversed";
}
export interface ExternalMetadata {
  providerId?: FinancialProviderId;
  connectionId?: string;
  externalTransactionId?: string;
  externalAccountId?: string;
  pendingStatus?: "pending" | "posted" | "unknown";
  originalCurrency?: string;
  originalAmount?: number;
  finalJPYAmount?: number;
  feeAmount?: number;
  balanceEffect?: BalanceEffect;
}
export interface ExternalTransaction extends Stamped {
  providerId: FinancialProviderId;
  connectionId: string;
  externalTransactionId: string;
  externalAccountId: string;
  accountId: string;
  date: string;
  amount: number;
  description: string;
  currency: string;
  pendingStatus: "pending" | "posted" | "unknown";
  externalUpdatedAt: string;
  kind:
    | "unclassified"
    | "expense"
    | "income"
    | "transfer"
    | "refund"
    | "cardPayment"
    | "ignored";
  linkedRecordId?: string;
  relatedExpenseId?: string;
  originalCurrency?: string;
  originalAmount?: number;
  finalJPYAmount?: number;
  balanceEffect?: BalanceEffect;
}
export interface FinancialConnection extends Stamped {
  providerId: FinancialProviderId;
  status: "connected" | "reauthentication" | "disconnected";
  institutionIds: string[];
  consentedAt: string;
}
export interface SyncState {
  id: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextRefreshAllowedAt: string | null;
  status:
    | "idle"
    | "syncing"
    | "offline"
    | "reauthentication"
    | "maintenance"
    | "rateLimited"
    | "error";
  message: string;
}
export interface Receipt extends Stamped {
  expenseId?: string;
  mimeType: string;
  imageBase64: string;
}
export interface SalaryRule extends Stamped {
  accountId: string;
  normalizedDescription: string;
  enabled: boolean;
}
export interface FinancialAudit extends Stamped {
  action: string;
  recordId: string;
  detail: string;
}
export interface AccountAdjustment extends Stamped {
  accountId: string;
  previousBalance: number;
  newBalance: number;
  date: string;
  memo: string;
}
export interface BudgetCycleConfig {
  mode: "calendar" | "salary";
  startDay: number;
}
export interface ReminderSettings {
  enabled: boolean;
  time: string;
  privacyMode: "generic";
  delivery: "calendar" | "foreground";
  lastNotifiedDate?: string;
}
