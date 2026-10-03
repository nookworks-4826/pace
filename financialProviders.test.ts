import { describe, expect, it, vi } from "vitest";
import { createMoneytreeProvider, consumeOAuthCallback } from "../providers/moneytree";
import type { MoneytreeConfig } from "../providers/moneytree";
import type { ProviderCredentialStore, ProviderSecretState } from "../providers/types";
import { normalizeMoneytreeAccount, normalizeMoneytreeTransaction } from "../providers/moneytree/normalize";
import { MockFinancialProvider } from "../providers/mock";
import { ManualFinancialProvider } from "../providers/manual";

const config: MoneytreeConfig = { clientId: "fictional-test-client", redirectUri: "https://pace.example.test/pace/", environment: "staging", browserAccessConfirmed: true };
const instant = Date.parse("2026-10-03T03:00:00Z");
function memoryStore(initial: ProviderSecretState | null = null): ProviderCredentialStore {
  let value = initial ? structuredClone(initial) : null;
  return { read: async () => value ? structuredClone(value) : null, write: async (_key, next) => { value = structuredClone(next); }, delete: async () => { value = null; } };
}
function tokenState(): ProviderSecretState { return { accessToken: "fictional-access", refreshToken: "fictional-refresh", expiresAt: new Date(instant + 3600_000).toISOString(), scope: ["guest_read", "accounts_read", "transactions_read", "request_refresh"], resourceServer: "jp-api-staging" }; }
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function browserLocks() {
  const queues = new Map<string, Promise<void>>();
  const request = async <T>(name: string, work: () => Promise<T>) => {
    const previous = queues.get(name) ?? Promise.resolve(); const gate = deferred<void>(); queues.set(name, previous.then(() => gate.promise));
    await previous; try { return await work(); } finally { gate.resolve(); }
  };
  vi.stubGlobal("navigator", { locks: { request }, onLine: true });
  return request;
}
const newToken = { access_token: "fictional-delayed-access", refresh_token: "fictional-delayed-refresh", token_type: "bearer", expires_in: 3600, scope: "guest_read accounts_read transactions_read request_refresh", resource_server: "jp-api-staging" };
const bank = { id: 12, account_subtype: "savings", currency: "JPY", current_balance: 20000, nickname: "テスト銀行", institution_entity_key: "fictional_bank", last_aggregated_success: "2026-10-02T22:00:00+09:00", aggregation_status: "success" };
const card = { ...bank, id: 13, account_subtype: "credit_card", current_balance: -3000, nickname: "テストカード" };
describe("financial provider boundaries", () => {
  it("rejects a late OAuth exchange after a local financial reset", async () => {
    const store = memoryStore(); const response = deferred<Response>(); const fetcher = vi.fn(() => response.promise);
    const provider = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => instant });
    await provider.connect(); const pending = (await store.read("test"))!.pending!;
    const exchange = provider.completeAuthorization(consumeOAuthCallback(`${config.redirectUri}?code=fictional-code&state=${pending.state}`, () => {})!);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const epoch = provider.lifecycleEpoch(); provider.invalidateConnection(); await store.delete("test");
    response.resolve(json(newToken));
    await expect(exchange).rejects.toMatchObject({ code: "authenticationRequired" });
    expect(provider.lifecycleEpoch()).toBe(epoch + 1); expect(await store.read("test")).toBeNull();
  });
  it("does not recreate credentials when another tab clears a delayed OAuth exchange", async () => {
    const lock = browserLocks();
    try {
      const store = memoryStore(); const response = deferred<Response>(); const fetcher = vi.fn(() => response.promise);
      const provider = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => instant });
      await provider.connect(); const pending = (await store.read("test"))!.pending!;
      const exchange = provider.completeAuthorization(consumeOAuthCallback(`${config.redirectUri}?code=fictional-code&state=${pending.state}`, () => {})!);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      await lock("pace:moneytree:state:moneytree:default", () => store.delete("test"));
      response.resolve(json(newToken));
      await expect(exchange).rejects.toMatchObject({ code: "authenticationRequired" }); expect(await store.read("test")).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });
  it("cannot overwrite a newer authorization session with a late token rotation", async () => {
    const lock = browserLocks();
    try {
      const store = memoryStore({ ...tokenState(), expiresAt: new Date(instant - 1).toISOString() }); const response = deferred<Response>();
      const fetcher = vi.fn(() => response.promise);
      const first = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => instant });
      const second = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => instant });
      const operation = first.getAccounts(); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      const oldNonce = (await store.read("test"))!.sessionNonce;
      await lock("pace:moneytree:state:moneytree:default", () => store.delete("test")); await second.connect();
      const fresh = (await store.read("test"))!; expect(fresh.sessionNonce).not.toBe(oldNonce);
      response.resolve(json(newToken));
      await expect(operation).rejects.toMatchObject({ code: "authenticationRequired" });
      expect(await store.read("test")).toEqual(fresh); expect(fresh.accessToken).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });
  it("does not expose a delayed account payload from an earlier tab session", async () => {
    browserLocks();
    try {
      const store = memoryStore(tokenState()); const response = deferred<Response>(); const fetcher = vi.fn(() => response.promise);
      const first = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => instant });
      const second = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => instant });
      const operation = first.getAccounts(); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      await second.connect(); const fresh = (await store.read("test"))!; response.resolve(json({ accounts: [bank] }));
      await expect(operation).rejects.toMatchObject({ code: "authenticationRequired" });
      await expect(first.getBalances()).rejects.toMatchObject({ code: "notConnected" }); expect(await store.read("test")).toEqual(fresh);
    } finally { vi.unstubAllGlobals(); }
  });
  it("invalidates network work on vault events even if a fetch ignores abort", async () => {
    browserLocks(); const events = new EventTarget(); vi.stubGlobal("window", events);
    try {
      const response = deferred<Response>(); let signal: AbortSignal | null = null;
      const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => { signal = init?.signal ?? null; return response.promise; });
      const provider = createMoneytreeProvider({ store: memoryStore(tokenState()), config, fetch: fetcher, now: () => instant });
      const operation = provider.getAccounts(); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      events.dispatchEvent(new Event("pace:vault-status")); response.resolve(json({ accounts: [bank] }));
      await expect(operation).rejects.toMatchObject({ code: "authenticationRequired" }); expect(signal!.aborted).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it("does not disclose cached balances after credential vault access becomes unavailable", async () => {
    const backing = memoryStore(tokenState()); let locked = false;
    const store: ProviderCredentialStore = { ...backing, read: async (key) => { if (locked) throw new Error("fictional locked vault"); return backing.read(key); } };
    const fetcher = vi.fn(async () => json({ accounts: [bank] }));
    const provider = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => instant });
    await provider.getAccounts(); locked = true;
    await expect(provider.getBalances()).rejects.toThrow("fictional locked vault");
    expect(fetcher).toHaveBeenCalledTimes(1);
    locked = false; await provider.disconnect();
    await expect(provider.getBalances()).rejects.toMatchObject({ code: "notConnected" });
  });
  it("serializes token rotation and refresh reservation across separate provider instances", async () => {
    const queues = new Map<string, Promise<void>>();
    const request = async <T>(name: string, work: () => Promise<T>) => {
      const previous = queues.get(name) ?? Promise.resolve(); let release: () => void = () => {};
      const next = new Promise<void>((resolve) => { release = resolve; }); queues.set(name, previous.then(() => next));
      await previous; try { return await work(); } finally { release(); }
    };
    vi.stubGlobal("navigator", { locks: { request }, onLine: true });
    try {
      const store = memoryStore({ ...tokenState(), expiresAt: new Date(instant - 1).toISOString() });
      const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes("/oauth/token") ? json({ access_token: "fictional-rotated", refresh_token: "fictional-rotated-refresh", token_type: "bearer", expires_in: 3600, scope: "guest_read accounts_read transactions_read request_refresh", resource_server: "jp-api-staging" }) : String(url).includes("/refresh.json") ? json({}, 202) : json({ accounts: [bank] }));
      const first = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => instant });
      const second = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => instant });
      await Promise.all([first.getAccounts(), second.getAccounts()]);
      expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/oauth/token"))).toHaveLength(1);
      const attempts = await Promise.allSettled([first.refresh(), second.refresh()]);
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({ reason: { code: "rateLimited" } });
      const state = await store.read("test");
      expect(state).toMatchObject({ accessToken: "fictional-rotated", refreshToken: "fictional-rotated-refresh", refreshBudget: { count: 1 }, lastUpdatedAt: bank.last_aggregated_success });
    } finally { vi.unstubAllGlobals(); }
  });
  it("requires a formally issued client and confirmed browser access", async () => {
    const fetcher = vi.fn();
    for (const candidate of [null, { ...config, clientId: "" }, { ...config, browserAccessConfirmed: false }, { ...config, redirectUri: "https://pace.example.test/pace/#/financial" }]) {
      const provider = createMoneytreeProvider({ store: memoryStore(), config: candidate, fetch: fetcher });
      await expect(provider.connect()).rejects.toMatchObject({ code: "configurationRequired" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses fresh S256 PKCE and state without any client secret", async () => {
    const store = memoryStore();
    const provider = createMoneytreeProvider({ store, config, now: () => instant });
    const first = new URL((await provider.connect()).authorizationUrl!);
    const pending = (await store.read("test"))!.pending!;
    expect(first.origin).toBe("https://myaccount-staging.getmoneytree.com");
    expect(first.searchParams.get("response_type")).toBe("code");
    expect(first.searchParams.get("code_challenge_method")).toBe("S256");
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier))).toString("base64url");
    expect(first.searchParams.get("code_challenge")).toBe(digest);
    expect(first.searchParams.get("state")).toBe(pending.state);
    expect(first.searchParams.get("scope")).toBe("guest_read accounts_read transactions_read request_refresh");
    expect(first.href).not.toContain(pending.verifier);
    expect(first.searchParams.has("client_secret")).toBe(false);
    expect(new URL((await provider.connect()).authorizationUrl!).searchParams.get("state")).not.toBe(pending.state);
  });
  it("scrubs callback values before returning them to unlock-dependent code", () => {
    const clean = vi.fn();
    const callback = consumeOAuthCallback("https://pace.example.test/pace/?code=temporary-code&state=random-state&client_id=public#/?x=1", clean)!;
    expect(callback.code).toBe("temporary-code");
    const saved = new URL(clean.mock.calls[0][0]);
    expect(saved.search).toBe("");
    expect(saved.hash).toBe("#/?x=1");
    expect(consumeOAuthCallback("https://pace.example.test/pace/#/", clean)).toBeNull();
  });
  it("rejects implicit/hash tokens and duplicate callback parameters after scrubbing", () => {
    const clean = vi.fn();
    expect(consumeOAuthCallback("https://pace.example.test/pace/#access_token=private&state=state", clean)).toMatchObject({ malformed: true, code: null });
    expect(clean.mock.calls[0][0]).not.toContain("private");
    expect(consumeOAuthCallback("https://pace.example.test/pace/?code=a&code=b&state=s", clean)).toMatchObject({ malformed: true });
  });
  it("exchanges a verified code with body-only secrets and consumes its pending state", async () => {
    const store = memoryStore();
    const fetcher = vi.fn(async () => json({ access_token: "fictional-new-access", refresh_token: "fictional-new-refresh", token_type: "bearer", expires_in: 600, scope: "guest_read accounts_read transactions_read request_refresh", resource_server: "jp-api-staging" }));
    const provider = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => instant });
    await provider.connect();
    const pending = (await store.read("test"))!.pending!;
    const callback = consumeOAuthCallback(`${config.redirectUri}?code=fictional-code&state=${pending.state}`, () => {})!;
    await provider.completeAuthorization(callback);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://myaccount-staging.getmoneytree.com/oauth/token");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("code_verifier")).toBe(pending.verifier);
    expect(body.get("client_secret")).toBeNull();
    expect(init).toMatchObject({ cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    const final = (await store.read("test"))!;
    expect(final.pending).toBeUndefined();
    expect(final.expiresAt).toBe(new Date(instant + 600_000).toISOString());
    await expect(provider.completeAuthorization(callback)).rejects.toMatchObject({ code: "stateMismatch" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not exchange mismatched states, paths or expired callbacks", async () => {
    for (const mode of ["state", "path", "expired"]) {
      const store = memoryStore(); const fetcher = vi.fn();
      let now = instant;
      const provider = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => now });
      await provider.connect();
      const pending = (await store.read("test"))!.pending!;
      if (mode === "expired") now += 11 * 60_000;
      const callback = consumeOAuthCallback(`https://pace.example.test/${mode === "path" ? "other" : "pace/"}?code=fake&state=${mode === "state" ? "wrong" : pending.state}`, () => {})!;
      await expect(provider.completeAuthorization(callback)).rejects.toMatchObject({ code: mode === "expired" ? "callbackExpired" : "stateMismatch" });
      expect(fetcher).not.toHaveBeenCalled();
      expect((await store.read("test"))!.pending).toBeUndefined();
    }
  });
  it("never accepts an arbitrary token resource server", async () => {
    const store = memoryStore();
    const fetcher = vi.fn(async () => json({ access_token: "fictional-access", refresh_token: "fictional-refresh", token_type: "bearer", expires_in: 3600, scope: "accounts_read", resource_server: "https://third-party.example.test" }));
    const provider = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => instant });
    await provider.connect(); const state = (await store.read("test"))!.pending!.state;
    await expect(provider.completeAuthorization(consumeOAuthCallback(`${config.redirectUri}?code=fake&state=${state}`, () => {})!)).rejects.toMatchObject({ code: "invalidResponse" });
    expect((await store.read("test"))!.accessToken).toBeUndefined();
  });
  it("preserves actual balance timestamps and signed transactions, without invented pending flags", async () => {
    const store = memoryStore(tokenState());
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes("transactions") ? json({ transactions: [{ id: 99, account_id: 13, amount: -1120, date: "2026-10-03T00:00:00+09:00", updated_at: "2026-10-03T01:00:00+09:00", description_raw: "テスト購入", attributes: { fx_base_currency: "USD", fx_base_amount: 7.5 } }] }) : json({ accounts: [bank, card] }));
    const provider = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => instant });
    expect(await provider.getAccounts()).toMatchObject([{ balance: 20000, liability: false }, { balance: 3000, liability: true }]);
    const rows = await provider.getTransactions({ accountIds: ["13"] });
    expect(rows[0]).toMatchObject({ amount: -1120, finalJPYAmount: -1120, originalCurrency: "USD", originalAmount: 7.5, pendingStatus: "unknown" });
    expect(await provider.getLastUpdatedAt()).toBe(bank.last_aggregated_success);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("fictional-access");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fictional-access");
  });
  it("does not coerce fractional or foreign-currency amounts into JPY", () => {
    expect(() => normalizeMoneytreeAccount({ ...bank, current_balance: 10.5 })).toThrow();
    const usd = normalizeMoneytreeAccount({ ...bank, currency: "USD", current_balance: 10.5 });
    expect(usd).toMatchObject({ currency: "USD", balance: 10.5 });
    expect(normalizeMoneytreeTransaction({ id: 1, account_id: 12, amount: -1.5, date: "2026-10-03", updated_at: "2026-10-03T00:00:00Z" }, usd).finalJPYAmount).toBeUndefined();
  });
  it("rotates a refresh token once when concurrent calls need renewal", async () => {
    const store = memoryStore({ ...tokenState(), expiresAt: new Date(instant - 1).toISOString() });
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/oauth/token")) return json({ access_token: "fictional-rotated-access", refresh_token: "fictional-rotated-refresh", token_type: "bearer", expires_in: 3600, scope: "accounts_read", resource_server: "jp-api-staging" });
      return json({ accounts: [bank] });
    });
    const provider = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => instant });
    await Promise.all([provider.getAccounts(), provider.getAccounts()]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/oauth/token"))).toHaveLength(1);
    expect((await store.read("test"))!.refreshToken).toBe("fictional-rotated-refresh");
  });
  it("distinguishes a refresh request from up-to-date data and persists rate limits", async () => {
    let now = instant;
    const store = memoryStore(tokenState());
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    const provider = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => now });
    expect(await provider.refresh()).toMatchObject({ status: "requested" });
    expect(await provider.getLastUpdatedAt()).toBeNull();
    await expect(provider.refresh()).rejects.toMatchObject({ code: "rateLimited" });
    for (let i = 0; i < 3; i++) { now += 16 * 60_000; await provider.refresh(); }
    now += 16 * 60_000;
    await expect(provider.refresh()).rejects.toMatchObject({ code: "rateLimited", retryAt: "2026-10-03T15:00:00.000Z" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("retains credentials after failed consent withdrawal and deletes on accepted withdrawal", async () => {
    const store = memoryStore(tokenState()); let succeed = false;
    const fetcher = vi.fn(async (_url: string | URL | Request) => new Response(null, { status: succeed ? 202 : 503 }));
    const provider = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => instant });
    await expect(provider.revokeAuthorization()).rejects.toMatchObject({ code: "maintenance" });
    expect((await store.read("test"))!.accessToken).toBe("fictional-access");
    succeed = true; await provider.revokeAuthorization();
    expect(await store.read("test")).toBeNull();
    expect(String(fetcher.mock.calls[1][0]).endsWith("/link/profile/revoke.json")).toBe(true);
  });
  it("uses safe errors without leaking provider payloads and preserves stored data", async () => {
    for (const [status, code] of [[401, "authenticationRequired"], [403, "missingScope"], [429, "rateLimited"], [503, "maintenance"], [500, "providerUnavailable"]] as const) {
      const store = memoryStore({ ...tokenState(), refreshToken: undefined });
      const fetcher = vi.fn(async () => json({ private: "sensitive-provider-detail" }, status));
      const provider = createMoneytreeProvider({ store, config, fetch: fetcher, now: () => instant });
      await expect(provider.getAccounts()).rejects.toMatchObject({ code });
      expect((await store.read("test"))!.accessToken).toBe("fictional-access");
    }
    const provider = createMoneytreeProvider({ store: memoryStore(tokenState()), config, isOnline: () => false });
    await expect(provider.getAccounts()).rejects.toMatchObject({ code: "offline" });
  });
  it("uses local providers offline and keeps pending/final updates under one external ID", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const normalized = normalizeMoneytreeAccount(card);
    const transaction = { externalTransactionId: "fictional-card-1", externalAccountId: "13", externalUpdatedAt: "2026-10-02T00:00:00Z", date: "2026-10-02", amount: -1000, description: "架空のお店", currency: "JPY", pendingStatus: "pending" as const };
    const snapshot = { accounts: [normalized], transactions: [transaction], updatedAt: "2026-10-02T00:00:00Z" };
    const provider = new MockFinancialProvider(snapshot);
    expect((await provider.getTransactions())[0]).toMatchObject({ externalTransactionId: "fictional-card-1", amount: -1000, pendingStatus: "pending" });
    provider.replaceSnapshot({ ...snapshot, transactions: [{ ...transaction, amount: -1120, pendingStatus: "posted" }] });
    expect(await provider.getTransactions()).toHaveLength(1);
    expect((await provider.getTransactions())[0]).toMatchObject({ externalTransactionId: "fictional-card-1", amount: -1120, pendingStatus: "posted" });
    const manual = new ManualFinancialProvider();
    expect(await manual.getAccounts()).toEqual([]);
    expect(await manual.refresh()).toMatchObject({ status: "unchanged" });
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });
});
