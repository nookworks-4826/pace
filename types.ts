import type { AccountKind, FinancialProviderId } from "../types/automation";

export interface ProviderInstitution {
  id: string;
  name: string;
  kind: string;
  status: "active" | "inactive" | "unknown";
  statusReason: string | null;
}
export interface ProviderAccount {
  externalAccountId: string;
  name: string;
  institutionId?: string;
  kind: AccountKind;
  currency: string;
  balance: number | null;
  balanceUpdatedAt: string | null;
  liability: boolean;
  requiresReauthentication?: boolean;
}
export interface ProviderBalance {
  externalAccountId: string;
  balance: number | null;
  currency: string;
  asOf: string | null;
}
export interface ProviderTransaction {
  externalTransactionId: string;
  externalAccountId: string;
  externalUpdatedAt: string;
  date: string;
  /** Outflow/purchase is negative; inflow/refund is positive, including cards. */
  amount: number;
  description: string;
  currency: string;
  pendingStatus: "pending" | "posted" | "unknown";
  originalCurrency?: string;
  originalAmount?: number;
  finalJPYAmount?: number;
}
export interface ProviderTransactionQuery {
  accountIds?: string[];
  since?: string;
}
export interface ProviderRefreshResult {
  status: "requested" | "unchanged";
  nextAllowedAt: string | null;
}
export interface ProviderConnectResult {
  authorizationUrl?: string;
}
export interface FinancialDataProvider {
  readonly id: FinancialProviderId;
  /** Optional reset generation, so a sync can reject results from an earlier lifecycle. */
  lifecycleEpoch?(): number;
  connect(): Promise<ProviderConnectResult>;
  disconnect(): Promise<void>;
  getInstitutions(): Promise<ProviderInstitution[]>;
  getAccounts(): Promise<ProviderAccount[]>;
  getBalances(): Promise<ProviderBalance[]>;
  getTransactions(query?: ProviderTransactionQuery): Promise<ProviderTransaction[]>;
  refresh(): Promise<ProviderRefreshResult>;
  getLastUpdatedAt(): Promise<string | null>;
  requiresReauthentication(): Promise<boolean>;
  revokeAuthorization(): Promise<void>;
}

/** This state contains secrets. Implementations MUST use the unlocked encrypted vault. */
export interface ProviderSecretState {
  /** Random connection lifecycle identity; prevents an earlier tab restoring revoked credentials. */
  sessionNonce?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string[];
  resourceServer?: string;
  pending?: { state: string; verifier: string; redirectUri: string; createdAt: string };
  refreshBudget?: { jstDate: string; count: number; nextAllowedAt: string };
  lastUpdatedAt?: string;
}
export interface ProviderCredentialStore {
  read(key: string): Promise<ProviderSecretState | null>;
  write(key: string, value: ProviderSecretState): Promise<void>;
  delete(key: string): Promise<void>;
}
export type ProviderErrorCode =
  | "configurationRequired" | "notConnected" | "offline" | "networkOrCors"
  | "authenticationRequired" | "missingScope" | "rateLimited" | "maintenance"
  | "providerUnavailable" | "invalidResponse" | "cancelled" | "stateMismatch"
  | "callbackExpired" | "unsupported";
const messages: Record<ProviderErrorCode, string> = {
  configurationRequired: "金融連携の正式な接続設定が必要です",
  notConnected: "金融連携を接続してください",
  offline: "オフラインです。最後に取得した情報を表示します",
  networkOrCors: "通信できません。接続設定またはネットワークを確認してください",
  authenticationRequired: "金融連携の再認証が必要です",
  missingScope: "この操作に必要な認可がありません",
  rateLimited: "更新回数の上限です。時間をおいて更新してください",
  maintenance: "連携サービスがメンテナンス中です",
  providerUnavailable: "連携サービスが現在利用できません",
  invalidResponse: "取得した情報を安全に確認できませんでした",
  cancelled: "連携をキャンセルしました",
  stateMismatch: "認証の確認に失敗しました。もう一度連携してください",
  callbackExpired: "連携の手続きが期限切れです。もう一度連携してください",
  unsupported: "この連携では自動取得できません",
};
export class FinancialProviderError extends Error {
  constructor(public readonly code: ProviderErrorCode, public readonly retryAt: string | null = null) {
    super(messages[code]);
    this.name = "FinancialProviderError";
  }
}
