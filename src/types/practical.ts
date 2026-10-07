export type VerificationDays = 0 | 1 | 3 | 7 | 14 | 30;
export type QuickActionId =
  | "expense"
  | "receipt"
  | "transfer"
  | "balance"
  | "income"
  | "history"
  | "fixed"
  | "inbox";
export type ReviewReason = "merchant" | "category" | "ocr" | "payment";
export interface ExpenseInbox {
  id: string;
  expenseId: string;
  reasons: ReviewReason[];
}
export interface BackupHealth {
  status: "normal" | "review" | "failed";
  checkedAt: string;
  encrypted: boolean;
  schemaVersion: number;
  bytes: number;
  savedConfirmed: boolean;
}
export interface PracticalSettings {
  welcomedVersion?: string;
  preparedVersion?: string;
  backupHealth?: BackupHealth;
}
