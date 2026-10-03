import type { FinancialDataProvider, ProviderAccount, ProviderCredentialStore, ProviderSecretState, ProviderTransactionQuery } from "../types";
import { FinancialProviderError } from "../types";
import type { MoneytreeConfig } from "./config";
import { MONEYTREE_SCOPES, moneytreeConfigFromEnv, moneytreeEndpoints, validateMoneytreeConfig } from "./config";
import type { OAuthCallback } from "./pkce";
import { callbackCode, createPkce } from "./pkce";
import { normalizeMoneytreeAccount, normalizeMoneytreeInstitution, normalizeMoneytreeTransaction, object, timestamp } from "./normalize";

export interface MoneytreeProviderOptions {
  store: ProviderCredentialStore;
  credentialKey?: string;
  config?: MoneytreeConfig | null;
  fetch?: typeof fetch;
  now?: () => number;
  isOnline?: () => boolean;
}
const MIN_REFRESH_INTERVAL = 15 * 60_000;
const MAX_PAGES = 100;
function jstDate(now: number) { return new Date(now + 9 * 60 * 60_000).toISOString().slice(0, 10); }
function nextJstMidnight(now: number) {
  const shifted = new Date(now + 9 * 60 * 60_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1) - 9 * 60 * 60_000).toISOString();
}
export class MoneytreeProvider implements FinancialDataProvider {
  readonly id = "moneytree" as const;
  private readonly config: MoneytreeConfig | null;
  private readonly store: ProviderCredentialStore;
  private readonly key: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly isOnline: () => boolean;
  private accounts: ProviderAccount[] = [];
  private accountsNonce: string | null = null;
  private tokenPromise: Promise<string> | null = null;
  private refreshPromise: Promise<{ status: "requested"; nextAllowedAt: string }> | null = null;
  private epoch = 0;
  private controllers = new Set<AbortController>();
  constructor(options: MoneytreeProviderOptions) {
    this.config = options.config === undefined ? moneytreeConfigFromEnv(import.meta.env) : options.config;
    this.store = options.store;
    this.key = options.credentialKey ?? "moneytree:default";
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.isOnline = options.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
    if (typeof window !== "undefined") window.addEventListener("pace:vault-status", () => this.invalidateConnection());
    if (typeof window !== "undefined") window.addEventListener("pace:financial-reset", () => this.invalidateConnection());
  }
  isConfigured() { try { validateMoneytreeConfig(this.config); return true; } catch { return false; } }
  private configured() { return validateMoneytreeConfig(this.config); }
  private async state() { return (await this.store.read(this.key)) ?? {}; }
  lifecycleEpoch() { return this.epoch; }
  invalidateConnection() { this.epoch++; this.accounts = []; this.accountsNonce = null; this.tokenPromise = null; this.refreshPromise = null; for (const controller of this.controllers) controller.abort(); }
  private assertEpoch(expected: number) { if (expected !== this.epoch) throw new FinancialProviderError("authenticationRequired"); }
  private async lock<T>(purpose: string, action: () => Promise<T>): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request(`pace:moneytree:${purpose}:${this.key}`, action);
    // A browser without cross-tab locking cannot safely rotate a one-use token.
    if (typeof window !== "undefined") throw new FinancialProviderError("unsupported");
    return action(); // Isolated Node tests/manual tooling have no browser tabs.
  }
  private async sessionState(epoch = this.epoch): Promise<ProviderSecretState & { sessionNonce: string }> {
    return this.lock("state", async () => {
      this.assertEpoch(epoch);
      const current = await this.state(); this.assertEpoch(epoch);
      if (!current.sessionNonce && !current.accessToken && !current.refreshToken && !current.pending) throw new FinancialProviderError("notConnected");
      if (current.sessionNonce) return current as ProviderSecretState & { sessionNonce: string };
      // Upgrade existing encrypted credentials once, under the same lock used by reset.
      const next = { ...current, sessionNonce: crypto.randomUUID() };
      await this.store.write(this.key, next); this.assertEpoch(epoch);
      return next;
    });
  }
  private async assertSession(nonce: string, epoch: number) {
    this.assertEpoch(epoch);
    const state = await this.state(); this.assertEpoch(epoch);
    if (state.sessionNonce !== nonce) throw new FinancialProviderError("authenticationRequired");
  }
  private async updateState(update: (current: ProviderSecretState) => ProviderSecretState, epoch = this.epoch, nonce?: string) {
    return this.lock("state", async () => {
      this.assertEpoch(epoch);
      const current = await this.state(); this.assertEpoch(epoch);
      if (nonce !== undefined && current.sessionNonce !== nonce) throw new FinancialProviderError("authenticationRequired");
      const next = update(current);
      await this.store.write(this.key, next);
      this.assertEpoch(epoch);
      return next;
    });
  }
  private async fetchSafe(url: string, init: RequestInit = {}) {
    const epoch = this.epoch;
    if (!this.isOnline()) throw new FinancialProviderError("offline");
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.fetcher(url, { ...init, signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", mode: "cors" });
      this.assertEpoch(epoch);
      if (response.status === 401) throw new FinancialProviderError("authenticationRequired");
      if (response.status === 403) throw new FinancialProviderError("missingScope");
      if (response.status === 429) {
        const retry = response.headers.get("Retry-After");
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
        const parsed = retry ? Date.parse(retry) : NaN;
        const retryAt = seconds !== null && seconds <= 86400 ? new Date(this.now() + seconds * 1000).toISOString() : Number.isFinite(parsed) && parsed > this.now() ? new Date(parsed).toISOString() : null;
        throw new FinancialProviderError("rateLimited", retryAt);
      }
      if (response.status === 503) throw new FinancialProviderError("maintenance");
      if (response.status >= 500) throw new FinancialProviderError("providerUnavailable");
      if (!response.ok) throw new FinancialProviderError("invalidResponse");
      return response;
    } catch (error) {
      this.assertEpoch(epoch);
      if (error instanceof FinancialProviderError) throw error;
      // Fetch does not distinguish a failed CORS check from some network failures.
      throw new FinancialProviderError(this.isOnline() ? "networkOrCors" : "offline");
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
  async connect() { const epoch = this.epoch; return this.lock("authorization", () => this.startAuthorization(epoch)); }
  private async startAuthorization(epoch: number) {
    this.assertEpoch(epoch);
    const config = this.configured();
    if (typeof location !== "undefined" && new URL(config.redirectUri).origin !== location.origin) throw new FinancialProviderError("configurationRequired");
    const pkce = await createPkce();
    this.assertEpoch(epoch);
    const sessionNonce = crypto.randomUUID();
    this.accounts = [];
    this.accountsNonce = null;
    await this.updateState((state) => ({ refreshBudget: state.refreshBudget, lastUpdatedAt: state.lastUpdatedAt, sessionNonce, pending: { state: pkce.state, verifier: pkce.verifier, redirectUri: config.redirectUri, createdAt: new Date(this.now()).toISOString() } }), epoch);
    this.assertEpoch(epoch);
    const url = new URL("/oauth/authorize", moneytreeEndpoints(config).auth);
    url.search = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri, scope: MONEYTREE_SCOPES.join(" "), state: pkce.state, code_challenge: pkce.challenge, code_challenge_method: "S256", locale: "ja" }).toString();
    return { authorizationUrl: url.href };
  }
  async completeAuthorization(callback: OAuthCallback) { const epoch = this.epoch; return this.lock("authorization", () => this.lock("token", () => this.consumeAuthorization(callback, epoch))); }
  private async consumeAuthorization(callback: OAuthCallback, epoch: number) {
    this.assertEpoch(epoch);
    const config = this.configured();
    const session = await this.sessionState(epoch);
    let pending: ProviderSecretState["pending"];
    // Consume before any exchange: replay and invalid callbacks cannot reuse the verifier.
    await this.updateState((state) => { pending = state.pending; const cleaned = { ...state }; delete cleaned.pending; return cleaned; }, epoch, session.sessionNonce);
    this.assertEpoch(epoch);
    if (!pending) throw new FinancialProviderError("stateMismatch");
    const code = callbackCode(callback, pending, this.now(), config.clientId);
    await this.exchange(new URLSearchParams({ grant_type: "authorization_code", client_id: config.clientId, redirect_uri: pending.redirectUri, code, code_verifier: pending.verifier }), epoch, session.sessionNonce);
  }
  private async exchange(body: URLSearchParams, epoch: number, nonce: string) {
    this.assertEpoch(epoch);
    const config = this.configured();
    let response: Response;
    try { response = await this.fetchSafe(new URL("/oauth/token", moneytreeEndpoints(config).auth).href, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }); }
    catch (error) {
      if (body.get("grant_type") === "refresh_token" && error instanceof FinancialProviderError && ["invalidResponse", "authenticationRequired"].includes(error.code)) throw new FinancialProviderError("authenticationRequired");
      throw error;
    }
    let data: Record<string, unknown>;
    try { data = object(await response.json()); } catch { throw new FinancialProviderError("invalidResponse"); }
    this.assertEpoch(epoch);
    if (typeof data.access_token !== "string" || !data.access_token || data.access_token.length > 8192 || typeof data.refresh_token !== "string" || !data.refresh_token || data.refresh_token.length > 8192 || String(data.token_type).toLowerCase() !== "bearer" || typeof data.expires_in !== "number" || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 365 * 86400 || typeof data.scope !== "string") throw new FinancialProviderError("invalidResponse");
    const expected = config.environment === "staging" ? "jp-api-staging" : "jp-api";
    const resource = data.resource_server;
    // Documentation also returns the auth-server label in examples. Both map to the fixed JP host; arbitrary hosts never receive tokens.
    const authLabel = config.environment === "staging" ? "myaccount-staging" : "myaccount";
    if (![expected, authLabel, `${expected}.getmoneytree.com`, `https://${expected}.getmoneytree.com`].includes(String(resource))) throw new FinancialProviderError("invalidResponse");
    const next = await this.updateState((state) => ({ ...state, accessToken: data.access_token as string, refreshToken: data.refresh_token as string, expiresAt: new Date(this.now() + Number(data.expires_in) * 1000).toISOString(), scope: String(data.scope).split(/\s+/).filter(Boolean), resourceServer: expected }), epoch, nonce);
    return next.accessToken!;
  }
  private async accessToken(forceRefresh = false): Promise<string> {
    const epoch = this.epoch;
    this.configured();
    const state = await this.sessionState(epoch);
    this.assertEpoch(epoch);
    if (!forceRefresh && state.accessToken && state.expiresAt && Date.parse(state.expiresAt) > this.now() + 30_000) return state.accessToken;
    if (this.tokenPromise) return this.tokenPromise;
    if (!state.refreshToken) throw new FinancialProviderError(state.accessToken ? "authenticationRequired" : "notConnected");
    this.tokenPromise = this.lock("token", async () => {
      this.assertEpoch(epoch);
      const latest = await this.state();
      this.assertEpoch(epoch);
      if (latest.sessionNonce !== state.sessionNonce) throw new FinancialProviderError("authenticationRequired");
      const valid = latest.accessToken && latest.expiresAt && Date.parse(latest.expiresAt) > this.now() + 30_000;
      // Another tab may have rotated this token while we were waiting for the lock.
      if (valid && (!forceRefresh || latest.accessToken !== state.accessToken)) return latest.accessToken!;
      if (!latest.refreshToken) throw new FinancialProviderError("authenticationRequired");
      return this.exchange(new URLSearchParams({ grant_type: "refresh_token", client_id: this.configured().clientId, refresh_token: latest.refreshToken }), epoch, state.sessionNonce);
    });
    const pending = this.tokenPromise;
    try { return await pending; } finally { if (this.tokenPromise === pending) this.tokenPromise = null; }
  }
  private async request(path: string, init: RequestInit = {}) {
    const epoch = this.epoch;
    const config = this.configured();
    const session = await this.sessionState(epoch);
    const url = new URL(path, moneytreeEndpoints(config).api);
    if (url.origin !== moneytreeEndpoints(config).api || !url.pathname.startsWith("/link/")) throw new FinancialProviderError("invalidResponse");
    const make = async (token: string) => { await this.assertSession(session.sessionNonce, epoch); const response = await this.fetchSafe(url.href, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers).entries()), Authorization: `Bearer ${token}` } }); await this.assertSession(session.sessionNonce, epoch); return response; };
    try { return await make(await this.accessToken()); }
    catch (error) {
      this.assertEpoch(epoch);
      await this.assertSession(session.sessionNonce, epoch);
      if (error instanceof FinancialProviderError && error.code === "authenticationRequired") return make(await this.accessToken(true));
      throw error;
    }
  }
  private async pages(path: string, property: string, params: URLSearchParams = new URLSearchParams(), pageSize: number | null = 500) {
    const epoch = this.epoch;
    const session = await this.sessionState(epoch);
    const results: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const query = new URLSearchParams(params);
      query.set("page", String(page));
      if (pageSize) query.set("per_page", String(pageSize));
      const response = await this.request(`${path}?${query}`);
      let data: Record<string, unknown>;
      try { data = object(await response.json()); } catch { throw new FinancialProviderError("invalidResponse"); }
      this.assertEpoch(epoch);
      await this.assertSession(session.sessionNonce, epoch);
      if (!Array.isArray(data[property])) throw new FinancialProviderError("invalidResponse");
      const rows = data[property] as unknown[];
      results.push(...rows);
      if (!rows.length || (pageSize && rows.length < pageSize)) return results;
    }
    // An incomplete, capped result must never be presented as a complete sync.
    throw new FinancialProviderError("invalidResponse");
  }
  async getInstitutions() { const epoch = this.epoch; const rows = await this.pages("/link/institutions.json", "institutions", new URLSearchParams({ locale: "ja" }), null); this.assertEpoch(epoch); return rows.map(normalizeMoneytreeInstitution); }
  async getAccounts() {
    const epoch = this.epoch;
    const session = await this.sessionState(epoch);
    const accounts = (await this.pages("/link/accounts.json", "accounts")).map(normalizeMoneytreeAccount);
    const state = await this.state(); // Recheck the vault gate after asynchronous network work.
    this.assertEpoch(epoch);
    if (state.sessionNonce !== session.sessionNonce) throw new FinancialProviderError("authenticationRequired");
    if (!state.accessToken) throw new FinancialProviderError("notConnected");
    const updated = accounts.map((account) => account.balanceUpdatedAt).filter((value): value is string => value !== null).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
    if (updated) await this.updateState((current) => ({ ...current, lastUpdatedAt: updated }), epoch, session.sessionNonce);
    this.assertEpoch(epoch);
    this.accounts = accounts;
    this.accountsNonce = session.sessionNonce;
    return structuredClone(accounts);
  }
  async getBalances() {
    const epoch = this.epoch;
    const state = await this.sessionState(epoch); // Cached balances are still protected by the unlocked credential vault.
    if (!state.accessToken) throw new FinancialProviderError("notConnected");
    const accounts = this.accounts.length && this.accountsNonce === state.sessionNonce ? this.accounts : await this.getAccounts();
    this.assertEpoch(epoch);
    await this.assertSession(state.sessionNonce, epoch);
    return accounts.map((account) => ({ externalAccountId: account.externalAccountId, balance: account.balance, currency: account.currency, asOf: account.balanceUpdatedAt }));
  }
  async getTransactions(query: ProviderTransactionQuery = {}) {
    const epoch = this.epoch;
    const session = await this.sessionState(epoch);
    if (query.since && (!/^\d{4}-\d{2}-\d{2}$/.test(query.since) || !Number.isFinite(Date.parse(query.since)))) throw new FinancialProviderError("invalidResponse");
    const accounts = this.accounts.length && this.accountsNonce === session.sessionNonce ? this.accounts : await this.getAccounts();
    this.assertEpoch(epoch);
    const selected = query.accountIds ? accounts.filter((account) => query.accountIds!.includes(account.externalAccountId)) : accounts;
    const transactions = [];
    for (const account of selected) {
      const params = new URLSearchParams();
      if (query.since) params.set("since", query.since);
      const rows = await this.pages(`/link/accounts/${encodeURIComponent(account.externalAccountId)}/transactions.json`, "transactions", params);
      this.assertEpoch(epoch);
      transactions.push(...rows.map((row) => normalizeMoneytreeTransaction(row, account)));
    }
    await this.assertSession(session.sessionNonce, epoch);
    return transactions;
  }
  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    const epoch = this.epoch;
    this.refreshPromise = this.lock("refresh", () => this.requestRefresh(epoch));
    const pending = this.refreshPromise;
    try { return await pending; } finally { if (this.refreshPromise === pending) this.refreshPromise = null; }
  }
  private async requestRefresh(epoch: number) {
    this.assertEpoch(epoch);
    this.configured();
    if (!this.isOnline()) throw new FinancialProviderError("offline");
    const state = await this.sessionState(epoch);
    this.assertEpoch(epoch);
    const now = this.now();
    const date = jstDate(now);
    const budget = state.refreshBudget?.jstDate === date ? state.refreshBudget : { jstDate: date, count: 0, nextAllowedAt: new Date(now).toISOString() };
    if (budget.count >= 4) throw new FinancialProviderError("rateLimited", nextJstMidnight(now));
    if (Date.parse(budget.nextAllowedAt) > now) throw new FinancialProviderError("rateLimited", budget.nextAllowedAt);
    await this.accessToken();
    this.assertEpoch(epoch);
    // Reserve the attempt before the request; a lost response may still have queued a job.
    const nextAllowedAt = new Date(now + MIN_REFRESH_INTERVAL).toISOString();
    await this.updateState((current) => ({ ...current, refreshBudget: { jstDate: date, count: budget.count + 1, nextAllowedAt } }), epoch, state.sessionNonce);
    const response = await this.request("/link/profile/refresh.json", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ background_refreshable_only: true }) });
    this.assertEpoch(epoch);
    await this.assertSession(state.sessionNonce, epoch);
    if (response.status !== 202) throw new FinancialProviderError("invalidResponse");
    return { status: "requested" as const, nextAllowedAt };
  }
  async getLastUpdatedAt() { const epoch = this.epoch; const state = await this.state(); this.assertEpoch(epoch); return timestamp(state.lastUpdatedAt); }
  async requiresReauthentication() {
    const epoch = this.epoch;
    const state = await this.state();
    this.assertEpoch(epoch);
    return (!state.refreshToken && (!state.accessToken || !state.expiresAt || Date.parse(state.expiresAt) <= this.now())) || this.accounts.some((account) => account.requiresReauthentication);
  }
  /** Local disconnect. Explicit revokeAuthorization performs provider consent withdrawal. */
  async disconnect() { this.invalidateConnection(); await this.lock("token", () => this.lock("state", () => this.store.delete(this.key))); }
  async revokeAuthorization() {
    const response = await this.request("/link/profile/revoke.json", { method: "POST" });
    if (response.status !== 202) throw new FinancialProviderError("invalidResponse");
    await this.disconnect();
  }
}
export function createMoneytreeProvider(options: MoneytreeProviderOptions) { return new MoneytreeProvider(options); }
export { MONEYTREE_SCOPES, moneytreeConfigFromEnv } from "./config";
export { consumeOAuthCallback } from "./pkce";
export type { MoneytreeConfig } from "./config";
export type { OAuthCallback } from "./pkce";
