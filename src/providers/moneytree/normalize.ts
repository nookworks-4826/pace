import type { ProviderAccount, ProviderInstitution, ProviderTransaction } from "../types";
import { FinancialProviderError } from "../types";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FinancialProviderError("invalidResponse");
  return value as Record<string, unknown>;
}
function id(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d{1,32}$/.test(value)) return value;
  throw new FinancialProviderError("invalidResponse");
}
function text(value: unknown, max = 512) {
  return typeof value === "string" ? value.slice(0, max) : "";
}
export function timestamp(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}
function currency(value: unknown) {
  if (typeof value === "string" && /^[A-Z]{3}$/.test(value)) return value;
  throw new FinancialProviderError("invalidResponse");
}
function amount(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || (code === "JPY" && !Number.isSafeInteger(value))) throw new FinancialProviderError("invalidResponse");
  return value;
}
export function normalizeMoneytreeAccount(value: unknown): ProviderAccount {
  const row = object(value);
  const subtype = text(row.account_subtype);
  const code = currency(row.currency);
  const liability = ["credit_card", "card_loan", "loan_installment", "home_loan"].includes(subtype);
  const kind = subtype === "credit_card" ? "CREDIT_CARD" : subtype === "stored_value" ? "EWALLET" : ["term_deposit", "term_deposit_builder", "term_deposit_shikumi", "zaikei"].includes(subtype) ? "SAVINGS" : ["savings", "checking", "chochiku", "debit_card", "tax_payment_reserve_deposit"].includes(subtype) ? "BANK" : "OTHER";
  const rawBalance = row.current_balance === null || row.current_balance === undefined ? null : amount(row.current_balance, code);
  return {
    externalAccountId: id(row.id), name: text(row.nickname) || text(row.institution_account_name) || "名称未設定の口座",
    institutionId: text(row.institution_entity_key) || undefined, kind, currency: code,
    // Moneytree liabilities are negative. Card credit overpayments are not treated as spendable cash.
    balance: rawBalance === null ? null : liability ? Math.max(0, -rawBalance) : rawBalance,
    balanceUpdatedAt: timestamp(row.last_aggregated_success), liability,
    requiresReauthentication: /^(suspended\.missing-answer\.auth|error\.auth|suspended\.auth)/.test(text(row.aggregation_status)),
  };
}
export function normalizeMoneytreeInstitution(value: unknown): ProviderInstitution {
  const row = object(value);
  const key = text(row.entity_key);
  if (!key) throw new FinancialProviderError("invalidResponse");
  return { id: key, name: text(row.display_name) || key, kind: text(row.institution_type), status: row.status === "active" ? "active" : row.status === "inactive" ? "inactive" : "unknown", statusReason: typeof row.status_reason === "string" ? row.status_reason.slice(0, 256) : null };
}
export function normalizeMoneytreeTransaction(value: unknown, account: ProviderAccount): ProviderTransaction {
  const row = object(value);
  if (id(row.account_id) !== account.externalAccountId) throw new FinancialProviderError("invalidResponse");
  const date = text(row.date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new FinancialProviderError("invalidResponse");
  const updatedAt = timestamp(row.updated_at);
  if (!updatedAt) throw new FinancialProviderError("invalidResponse");
  const valueAmount = amount(row.amount, account.currency);
  const attributes = row.attributes && typeof row.attributes === "object" && !Array.isArray(row.attributes) ? object(row.attributes) : {};
  const foreignCurrency = typeof attributes.fx_base_currency === "string" && /^[A-Z]{3}$/.test(attributes.fx_base_currency) ? attributes.fx_base_currency : undefined;
  const foreignAmount = foreignCurrency && typeof attributes.fx_base_amount === "number" && Number.isFinite(attributes.fx_base_amount) ? attributes.fx_base_amount : undefined;
  return {
    externalTransactionId: id(row.id), externalAccountId: account.externalAccountId, externalUpdatedAt: updatedAt,
    date, amount: valueAmount, description: text(row.description_guest) || text(row.description_pretty) || text(row.description_raw), currency: account.currency,
    // The public transactions schema does not expose a pending/final flag. Do not invent it.
    pendingStatus: "unknown", originalCurrency: foreignCurrency, originalAmount: foreignAmount,
    finalJPYAmount: account.currency === "JPY" ? valueAmount : undefined,
  };
}
