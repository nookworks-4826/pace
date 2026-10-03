import "fake-indexeddb/auto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { db, initializeDb, readAppData } from "../db";
import { initializeVault } from "../domain/vault";
import {
  syncFinancialConnection,
  disconnectFinancialConnection,
} from "../domain/financialSync";
import { MockFinancialProvider } from "../providers/mock";
import type { FinancialDataProvider } from "../providers/types";
import { computeFinance } from "../domain/finance";
import { todayJST } from "../domain/dates";
import type { FinancialConnection } from "../types";
const today = todayJST(),
  now = new Date().toISOString();
const connection: FinancialConnection = {
  id: "fictional-connection",
  providerId: "mock",
  status: "connected",
  institutionIds: [],
  consentedAt: now,
  createdAt: now,
  updatedAt: now,
};
const provider = new MockFinancialProvider({
  updatedAt: now,
  accounts: [
    {
      externalAccountId: "fictional-bank",
      name: "検証専用銀行",
      kind: "BANK",
      currency: "JPY",
      balance: 9000,
      balanceUpdatedAt: now,
      liability: false,
    },
  ],
  transactions: [
    {
      externalTransactionId: "fictional-purchase",
      externalAccountId: "fictional-bank",
      externalUpdatedAt: now,
      date: today,
      amount: -1000,
      description: "検証専用店",
      currency: "JPY",
      pendingStatus: "posted",
    },
  ],
});
beforeAll(async () => {
  await db.delete();
  await db.open();
  await initializeVault("fictional sync vault passphrase");
  await initializeDb();
  await db.settings.update("main", { financialAutomationEnabled: true });
  await db.financialConnections.put(connection);
}, 15000);
afterAll(async () => {
  db.close();
  await db.delete();
});
it("rejects a pre-reset sync even if a new connection has the same id", async () => {
  await db.financialConnections.put(connection);
  await db.syncStates.delete(connection.id);
  const delayed: FinancialDataProvider = new MockFinancialProvider();
  let epoch = 0;
  delayed.lifecycleEpoch = () => epoch;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let began: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  delayed.getAccounts = async () => {
    began();
    await gate;
    return [];
  };
  const captured = syncFinancialConnection(delayed, connection).catch(
    (error) => error,
  );
  await started;
  epoch++;
  await db.syncStates.delete(connection.id);
  release();
  expect(await captured).toBeInstanceOf(Error);
  expect(await db.syncStates.get(connection.id)).toBeUndefined();
});
it("is idempotent and does not subtract imported purchases from a provider snapshot twice", async () => {
  await syncFinancialConnection(provider, connection);
  let data = await readAppData();
  expect(data.expenses).toHaveLength(1);
  expect(computeFinance(data).liquidBalance).toBe(9000);
  await db.syncStates.update(connection.id, {
    lastAttemptAt: "2000-01-01T00:00:00Z",
  });
  await syncFinancialConnection(provider, connection);
  data = await readAppData();
  expect(data.expenses).toHaveLength(1);
  expect(data.externalTransactions).toHaveLength(1);
  expect(computeFinance(data).liquidBalance).toBe(9000);
});
it("preserves records when a fetch fails", async () => {
  const before = await readAppData();
  await db.syncStates.update(connection.id, {
    lastAttemptAt: "2000-01-01T00:00:00Z",
  });
  const broken = new MockFinancialProvider();
  broken.getAccounts = async () => {
    throw new Error("fictional transport failure");
  };
  await expect(syncFinancialConnection(broken, connection)).rejects.toThrow(
    "更新できませんでした",
  );
  const after = await readAppData();
  expect(after.accounts).toEqual(before.accounts);
  expect(after.expenses).toEqual(before.expenses);
  expect(after.syncStates?.[0].status).toBe("error");
});
it("does not invent a fresh balance timestamp when the provider omits it", async () => {
  const before = (await readAppData()).accounts?.[0];
  await db.syncStates.update(connection.id, {
    lastAttemptAt: "2000-01-01T00:00:00Z",
  });
  const stale = new MockFinancialProvider({
    updatedAt: now,
    accounts: [
      {
        externalAccountId: "fictional-bank",
        name: "検証専用銀行",
        kind: "BANK",
        currency: "JPY",
        balance: 123456,
        balanceUpdatedAt: null,
        liability: false,
      },
    ],
    transactions: [],
  });
  stale.getBalances = async () => [];
  await syncFinancialConnection(stale, connection);
  const after = (await readAppData()).accounts?.[0];
  expect(after?.snapshotBalance).toBe(before?.snapshotBalance);
  expect(after?.snapshotRecordedAt).toBe(before?.snapshotRecordedAt);
});
it("keeps a manually merged purchase when imported history is removed", async () => {
  const expense = (await readAppData()).expenses[0];
  await db.expenses.update(expense.id, { externalMergedFromManual: true });
  await disconnectFinancialConnection(provider, connection.id, true);
  const data = await readAppData();
  expect(
    data.expenses.some((e) => e.id === expense.id && !e.externalTransactionId),
  ).toBe(true);
  await db.expenses.delete(expense.id);
  await db.financialConnections.put(connection);
});
it("does not resurrect a disconnected connection after an in-flight response", async () => {
  const isolatedConnection = {
    ...connection,
    id: "fictional-in-flight-disconnect",
  };
  await db.financialConnections.put(isolatedConnection);
  await db.syncStates.delete(isolatedConnection.id);
  const delayed = new MockFinancialProvider();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let began: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  delayed.getAccounts = async () => {
    began();
    await gate;
    return [];
  };
  const syncing = syncFinancialConnection(delayed, isolatedConnection);
  const captured = syncing.catch((e) => e);
  try {
    // An early rejection must fail the test instead of waiting forever for a
    // provider request that never started. Always release an in-flight request.
    await Promise.race([
      started,
      captured.then((result) => {
        throw result instanceof Error
          ? result
          : new Error("The sync completed before the delayed request started");
      }),
    ]);
    await disconnectFinancialConnection(delayed, isolatedConnection.id, true);
  } finally {
    release();
    await captured;
  }
  expect(await captured).toBeInstanceOf(Error);
  const data = await readAppData();
  expect(
    data.financialConnections?.find((entry) => entry.id === isolatedConnection.id)
      ?.status,
  ).toBe("disconnected");
  expect(data.expenses).toHaveLength(0);
  expect(data.externalTransactions).toHaveLength(0);
}, 15000);
