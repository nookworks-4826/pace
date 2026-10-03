import { db, readAppData, deleteExpense } from "../db";
import { isVaultUnlocked } from "./vault";
import { todayJST } from "./dates";
import { planFinancialImport } from "./financialImport";
import { FinancialProviderError } from "../providers/types";
import type {
  FinancialDataProvider,
  ProviderCredentialStore,
} from "../providers/types";
import type { Account, FinancialConnection, SyncState } from "../types";
export const encryptedCredentials: ProviderCredentialStore = {
  async read(id) {
    if (!isVaultUnlocked()) throw new Error("保管庫を開いてください。");
    const r = await db.providerCredentials.get(id);
    return r ? JSON.parse(r.value) : null;
  },
  async write(id, value) {
    if (!isVaultUnlocked()) throw new Error("保管庫を開いてください。");
    await db.providerCredentials.put({ id, value: JSON.stringify(value) });
  },
  async delete(id) {
    await db.providerCredentials.delete(id);
  },
};
const active = new Map<string, Promise<void>>();
const generations = new Map<string, number>();
export function syncFinancialConnection(
  provider: FinancialDataProvider,
  connection: FinancialConnection,
  requestRefresh = false,
) {
  const prior = active.get(connection.id);
  if (prior) return prior;
  const task = doSync(provider, connection, requestRefresh).finally(() =>
    active.delete(connection.id),
  );
  active.set(connection.id, task);
  return task;
}
async function doSync(
  provider: FinancialDataProvider,
  connection: FinancialConnection,
  requestRefresh: boolean,
) {
  const generation = generations.get(connection.id) ?? 0;
  const providerEpoch = provider.lifecycleEpoch?.();
  if (!isVaultUnlocked()) throw new Error("保管庫を開いてください。");
  const previous = await db.syncStates.get(connection.id),
    now = new Date().toISOString();
  if (
    previous?.lastAttemptAt &&
    Date.now() - Date.parse(previous.lastAttemptAt) < 60_000
  )
    throw new Error("少し待ってから更新してください。");
  const state: SyncState = {
    id: connection.id,
    lastAttemptAt: now,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    nextRefreshAllowedAt: previous?.nextRefreshAllowedAt ?? null,
    status: "syncing",
    message: "更新中",
  };
  await db.syncStates.put(state);
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false)
      throw new FinancialProviderError("offline");
    let requested = false;
    if (requestRefresh) {
      const refresh = await provider.refresh();
      state.nextRefreshAllowedAt = refresh.nextAllowedAt;
      requested = refresh.status === "requested";
    }
    const accounts = await provider.getAccounts(),
      balances = await provider.getBalances();
    const transactions = await provider.getTransactions({
      accountIds: accounts.map((a) => a.externalAccountId),
    });
    const data = await readAppData();
    const updated: Account[] = [];
    for (const remote of accounts) {
      if (remote.currency !== "JPY") continue;
      const old = data.accounts?.find(
        (a) =>
          a.connectionId === connection.id &&
          a.externalAccountId === remote.externalAccountId,
      );
      const snapshot = balances.find(
        (b) => b.externalAccountId === remote.externalAccountId,
      );
      const balance = snapshot?.balance ?? remote.balance;
      const snapshotTime = snapshot?.asOf ?? remote.balanceUpdatedAt;
      const hasSnapshot =
        balance !== null &&
        Number.isSafeInteger(balance) &&
        Math.abs(balance) <= 999_999_999_999 &&
        !!snapshotTime &&
        Number.isFinite(Date.parse(snapshotTime)) &&
        snapshotTime.slice(0, 10) <= todayJST();
      const stamp = { id: crypto.randomUUID(), createdAt: now, updatedAt: now };
      const card =
        remote.kind === "CREDIT_CARD"
          ? (old?.creditCardId ??
            data.cards.find((c) => c.name === remote.name)?.id)
          : undefined;
      updated.push({
        ...old,
        id: old?.id ?? stamp.id,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        name: old?.name ?? remote.name.replace(/三菱東京UFJ/g, "三菱UFJ"),
        kind: remote.kind,
        institutionName: remote.institutionId ?? "",
        currency: "JPY",
        snapshotBalance: hasSnapshot ? balance : (old?.snapshotBalance ?? null),
        balanceAsOf: hasSnapshot
          ? snapshotTime.slice(0, 10)
          : (old?.balanceAsOf ?? todayJST()),
        snapshotRecordedAt: hasSnapshot
          ? snapshotTime
          : (old?.snapshotRecordedAt ?? now),
        balanceSource: hasSnapshot
          ? "provider"
          : (old?.balanceSource ?? "provider"),
        creditCardId: card,
        providerId: provider.id,
        connectionId: connection.id,
        externalAccountId: remote.externalAccountId,
        isSpendable:
          old?.isSpendable ??
          (remote.kind !== "CREDIT_CARD" && remote.kind !== "SAVINGS"),
        isActive: true,
        automationLevel: hasSnapshot
          ? "automatic"
          : (old?.automationLevel ?? "automatic"),
      });
    }
    const importData = {
      ...data,
      accounts: [
        ...(data.accounts ?? []).filter(
          (a) => !updated.some((u) => u.id === a.id),
        ),
        ...updated,
      ],
    };
    const plans = updated.map((a) =>
      planFinancialImport(
        importData,
        a,
        transactions.filter((t) => t.date <= todayJST()),
        connection.id,
        now,
      ),
    );
    await db.transaction("rw", db.tables, async () => {
      const current = await db.financialConnections.get(connection.id);
      if (
        current?.status === "disconnected" ||
        !current ||
        (generations.get(connection.id) ?? 0) !== generation ||
        provider.lifecycleEpoch?.() !== providerEpoch
      )
        throw new Error("接続が変更されたため更新を中止しました。");
      await db.accounts.bulkPut(updated);
      for (const p of plans) {
        await db.externalTransactions.bulkPut(p.external);
        await db.expenses.bulkPut(p.expenses);
        await db.incomes.bulkPut(p.incomes);
        await db.recurringOccurrences.bulkPut(p.occurrences);
      }
      await db.syncStates.put({
        ...state,
        status: "idle",
        lastSuccessAt: now,
        message: requested
          ? "更新を依頼しました。取得済みの明細を表示しています。"
          : "取得済みの明細を反映しました。",
      });
      await db.financialConnections.update(connection.id, {
        status: "connected",
        updatedAt: now,
      });
    });
  } catch (error) {
    const current = await db.financialConnections.get(connection.id);
    if (
      current?.status === "disconnected" ||
      !current ||
      (generations.get(connection.id) ?? 0) !== generation ||
      provider.lifecycleEpoch?.() !== providerEpoch
    )
      throw new Error("接続が変更されたため更新を中止しました。");
    const code =
      error instanceof FinancialProviderError ? error.code : "invalidResponse";
    const status: SyncState["status"] =
      code === "offline"
        ? "offline"
        : code === "authenticationRequired"
          ? "reauthentication"
          : code === "rateLimited"
            ? "rateLimited"
            : code === "maintenance"
              ? "maintenance"
              : "error";
    await db.syncStates.put({
      ...state,
      status,
      message:
        error instanceof FinancialProviderError
          ? error.message
          : "更新できませんでした。保存済みの情報は残っています。",
      nextRefreshAllowedAt:
        error instanceof FinancialProviderError
          ? (error.retryAt ?? state.nextRefreshAllowedAt)
          : state.nextRefreshAllowedAt,
    });
    if (status === "reauthentication")
      await db.financialConnections.update(connection.id, {
        status: "reauthentication",
      });
    throw new Error(
      error instanceof FinancialProviderError
        ? error.message
        : "更新できませんでした。時間をおいてお試しください。",
    );
  }
}
export async function disconnectFinancialConnection(
  provider: FinancialDataProvider,
  connectionId: string,
  deleteImported = false,
) {
  generations.set(connectionId, (generations.get(connectionId) ?? 0) + 1);
  // Revocation must succeed before local credentials are removed. Failed revocation is actionable.
  await provider.revokeAuthorization();
  await db.transaction("rw", db.tables, async () => {
    const accounts = await db.accounts.toArray();
    const affected = accounts.filter((a) => a.connectionId === connectionId);
    for (const a of affected)
      await db.accounts.update(a.id, {
        balanceSource: "manual",
        automationLevel: "manual",
        providerId: undefined,
        connectionId: undefined,
        externalAccountId: undefined,
      });
    await db.financialConnections.update(connectionId, {
      status: "disconnected",
      updatedAt: new Date().toISOString(),
    });
    if (deleteImported) {
      for (const e of await db.expenses.toArray())
        if (e.connectionId === connectionId) {
          if (e.externalMergedFromManual)
            await db.expenses.update(e.id, {
              providerId: undefined,
              connectionId: undefined,
              externalTransactionId: undefined,
              externalAccountId: undefined,
              externalMergedFromManual: undefined,
              pendingStatus:
                e.paymentMethod === "creditCard" ? "pending" : undefined,
            });
          else await deleteExpense(e.id);
        }
      for (const i of await db.incomes.toArray())
        if (i.connectionId === connectionId) await db.incomes.delete(i.id);
      for (const t of await db.externalTransactions.toArray())
        if (t.connectionId === connectionId)
          await db.externalTransactions.delete(t.id);
      const remaining = new Set(
        (await db.externalTransactions.toArray()).map((t) => t.id),
      );
      for (const t of await db.transfers.toArray())
        if (t.externalTransactionIds?.some((id) => !remaining.has(id)))
          await db.transfers.update(t.id, {
            externalTransactionIds: t.externalTransactionIds.filter((id) =>
              remaining.has(id),
            ),
          });
    }
    await db.syncStates.delete(connectionId);
  });
  await provider.disconnect();
}
