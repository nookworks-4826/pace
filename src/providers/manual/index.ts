import type { FinancialDataProvider, ProviderAccount, ProviderInstitution, ProviderTransaction, ProviderTransactionQuery } from "../types";

export interface ManualProviderSnapshot {
  institutions?: ProviderInstitution[];
  accounts: ProviderAccount[];
  transactions: ProviderTransaction[];
  updatedAt: string | null;
}
/** A local adapter over data explicitly entered/imported by the user; no remote access. */
export class ManualFinancialProvider implements FinancialDataProvider {
  readonly id: "manual" | "mock" = "manual";
  private connected = false;
  protected snapshot: ManualProviderSnapshot;
  constructor(snapshot: ManualProviderSnapshot = { accounts: [], transactions: [], updatedAt: null }) { this.snapshot = structuredClone(snapshot); }
  async connect() { this.connected = true; return {}; }
  async disconnect() { this.connected = false; }
  async getInstitutions() { return structuredClone(this.snapshot.institutions ?? []); }
  async getAccounts() { return structuredClone(this.snapshot.accounts); }
  async getBalances() { return this.snapshot.accounts.map((account) => ({ externalAccountId: account.externalAccountId, balance: account.balance, currency: account.currency, asOf: account.balanceUpdatedAt })); }
  async getTransactions(query: ProviderTransactionQuery = {}) {
    return structuredClone(this.snapshot.transactions.filter((row) => (!query.accountIds || query.accountIds.includes(row.externalAccountId)) && (!query.since || row.externalUpdatedAt.slice(0, 10) >= query.since)));
  }
  async refresh() { return { status: "unchanged" as const, nextAllowedAt: null }; }
  async getLastUpdatedAt() { return this.snapshot.updatedAt; }
  async requiresReauthentication() { return false; }
  async revokeAuthorization() { await this.disconnect(); }
  isConnected() { return this.connected; }
}
