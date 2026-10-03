import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import Dexie, { liveQuery } from "dexie";
import { PaceDatabase, defaultCategories, defaultSettings } from "../db";
import {
  getVaultStatus,
  initializeVault,
  isVaultUnlocked,
  lockVault,
  unlockVault,
} from "../domain/vault";

const databases: PaceDatabase[] = [];
const phrase = "an independent local vault secret";
const stamp = {
  createdAt: "2026-10-03T10:00:00.000Z",
  updatedAt: "2026-10-03T10:00:00.000Z",
};
const expense = {
  ...stamp,
  id: "expense-one",
  amount: 850,
  date: "2026-10-03",
  merchant: "架空カフェ",
  description: "",
  categoryId: "food",
  subcategoryId: "food-0",
  paymentMethod: "cash" as const,
  memo: "架空の領収書",
  isFixedCost: false,
};
function database(name = `pace-vault-test-${crypto.randomUUID()}`) {
  const instance = new PaceDatabase(name);
  databases.push(instance);
  return instance;
}
async function seed(instance: PaceDatabase) {
  await instance.settings.put(structuredClone(defaultSettings));
  await instance.categories.bulkAdd(structuredClone(defaultCategories));
  await instance.expenses.put(expense);
  await instance.drafts.put({
    id: "expense",
    value: JSON.stringify({ amount: "850", merchant: "架空カフェ" }),
  });
  await instance.merchantRules.put({
    normalizedMerchant: "架空カフェ",
    categoryId: "food",
    subcategoryId: "food-0",
    usageCount: 1,
    lastUsedAt: stamp.createdAt,
  });
}
async function rawRows(
  instance: PaceDatabase,
  table: string,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const transaction = instance.backendDB().transaction(table, "readonly");
    const request = transaction.objectStore(table).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const instance of databases.splice(0)) {
    instance.close();
    await PaceDatabase.delete(instance.name);
  }
});

describe("encrypted IndexedDB vault", () => {
  it("upgrades a real legacy version 2 database before configuring the vault", async () => {
    const name = `pace-vault-upgrade-${crypto.randomUUID()}`;
    const model = database();
    const legacyNames = new Set([
      "expenses",
      "incomes",
      "cards",
      "cardPayments",
      "debts",
      "repayments",
      "recurringExpenses",
      "recurringOccurrences",
      "savingsGoals",
      "savingsContributions",
      "budgets",
      "settings",
      "merchantRules",
      "categories",
      "balanceAdjustments",
      "dailyCheckIns",
      "favorites",
      "drafts",
    ]);
    const legacy = new Dexie(name);
    legacy
      .version(2)
      .stores(
        Object.fromEntries(
          model.tables
            .filter((table) => legacyNames.has(table.name))
            .map((table) => [
              table.name,
              [
                table.schema.primKey.src,
                ...table.schema.indexes.map((index) => index.src),
              ].join(","),
            ]),
        ),
      );
    await legacy.open();
    await legacy.table("expenses").put(expense);
    await legacy.table("settings").put(structuredClone(defaultSettings));
    await legacy
      .table("drafts")
      .put({ id: "expense", value: "fictional legacy draft" });
    legacy.close();
    const instance = database(name);
    await instance.open();
    expect(await getVaultStatus(instance)).toEqual({
      enabled: false,
      unlocked: false,
    });
    expect(await instance.expenses.get(expense.id)).toEqual(expense);
    await initializeVault(phrase, instance);
    expect(await instance.expenses.get(expense.id)).toEqual(expense);
    expect((await instance.drafts.get("expense"))?.value).toBe(
      "fictional legacy draft",
    );
  });
  it("atomically migrates legacy rows and drafts without plain values or index keys", async () => {
    const instance = database();
    await seed(instance);
    expect(await getVaultStatus(instance)).toEqual({
      enabled: false,
      unlocked: false,
    });
    await initializeVault(phrase, instance);
    expect(await getVaultStatus(instance)).toEqual({
      enabled: true,
      unlocked: true,
    });
    expect(await instance.expenses.get(expense.id)).toEqual(expense);
    expect((await instance.merchantRules.get("架空カフェ"))?.categoryId).toBe(
      "food",
    );
    expect((await instance.drafts.get("expense"))?.value).toContain("850");
    const persistent = JSON.stringify([
      ...(await rawRows(instance, "expenses")),
      ...(await rawRows(instance, "drafts")),
      ...(await rawRows(instance, "merchantRules")),
      ...(await rawRows(instance, "vaultMeta")),
    ]);
    for (const privateValue of [
      "架空カフェ",
      "架空の領収書",
      "expense-one",
      "2026-10-03",
      phrase,
    ])
      expect(persistent).not.toContain(privateValue);
    expect((await rawRows(instance, "expenses"))[0].__paceVault).toBe(1);
  });
  it("supports CRUD, blind equality indexes, compound uniqueness and transaction rollback", async () => {
    const instance = database();
    await seed(instance);
    await initializeVault(phrase, instance);
    await instance.expenses.update(expense.id, { amount: 910 });
    expect((await instance.expenses.get(expense.id))?.amount).toBe(910);
    const row = {
      ...expense,
      id: "second",
      creditCardId: "card",
      paymentMethod: "creditCard" as const,
    };
    expect(await instance.expenses.put(row)).toBe("second");
    expect(
      (
        await instance.expenses.where("creditCardId").equals("card").toArray()
      ).map((entry) => entry.id),
    ).toEqual(["second"]);
    await instance.externalTransactions.add({
      ...stamp,
      id: "import-1",
      providerId: "mock",
      connectionId: "link",
      externalTransactionId: "external-1",
      externalAccountId: "bank",
      accountId: "account",
      date: expense.date,
      amount: -850,
      description: "架空カフェ",
      currency: "JPY",
      pendingStatus: "posted",
      externalUpdatedAt: stamp.createdAt,
      kind: "expense",
    });
    await expect(
      instance.externalTransactions.add({
        ...stamp,
        id: "import-2",
        providerId: "mock",
        connectionId: "link",
        externalTransactionId: "external-1",
        externalAccountId: "bank",
        accountId: "account",
        date: expense.date,
        amount: -850,
        description: "架空カフェ",
        currency: "JPY",
        pendingStatus: "posted",
        externalUpdatedAt: stamp.createdAt,
        kind: "expense",
      }),
    ).rejects.toThrow();
    await expect(
      instance.transaction("rw", instance.expenses, async () => {
        await instance.expenses.delete(expense.id);
        await instance.expenses.put({ ...expense, id: "invalid", amount: -1 });
      }),
    ).rejects.toThrow();
    expect((await instance.expenses.get(expense.id))?.amount).toBe(910);
    await instance.expenses.delete("second");
    expect(await instance.expenses.count()).toBe(1);
    await instance.expenses.clear();
    expect(await instance.expenses.count()).toBe(0);
  });
  it("discards memory keys, rejects wrong passwords and rejects plain writes from another tab", async () => {
    const instance = database();
    await seed(instance);
    await initializeVault(phrase, instance);
    const other = database(instance.name);
    await other.open();
    await expect(other.expenses.get(expense.id)).rejects.toThrow(
      "パスフレーズ",
    );
    await expect(other.expenses.put(expense)).rejects.toThrow("パスフレーズ");
    lockVault(instance);
    expect(isVaultUnlocked(instance)).toBe(false);
    await expect(instance.expenses.toArray()).rejects.toThrow("パスフレーズ");
    await expect(unlockVault("wrong passphrase", instance)).rejects.toThrow(
      "開けません",
    );
    expect(isVaultUnlocked(instance)).toBe(false);
    await unlockVault(phrase, instance);
    expect(await instance.expenses.get(expense.id)).toEqual(expense);
    await unlockVault(phrase, other);
    expect(await other.expenses.get(expense.id)).toEqual(expense);
  }, 15_000);
  it("rolls back a failed migration and keeps original plain records recoverable", async () => {
    const instance = database();
    await seed(instance);
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let calls = 0;
    vi.spyOn(crypto.subtle, "encrypt").mockImplementation((...args) => {
      calls++;
      if (calls > 1)
        return Promise.reject(new Error("Simulated encryption failure"));
      return encrypt(...args);
    });
    await expect(initializeVault(phrase, instance)).rejects.toThrow();
    expect(await getVaultStatus(instance)).toEqual({
      enabled: false,
      unlocked: false,
    });
    expect(await instance.expenses.get(expense.id)).toEqual(expense);
    expect((await rawRows(instance, "expenses"))[0]).toEqual(expense);
  });
  it("requires encryption for provider secrets and persists them only inside ciphertext", async () => {
    const instance = database();
    await instance.open();
    await expect(
      instance.providerCredentials.put({
        id: "moneytree",
        value: "fake-token-for-testing",
      }),
    ).rejects.toThrow("暗号化");
    await initializeVault(phrase, instance);
    await instance.providerCredentials.put({
      id: "moneytree",
      value: "fake-token-for-testing",
    });
    expect((await instance.providerCredentials.get("moneytree"))?.value).toBe(
      "fake-token-for-testing",
    );
    expect(
      JSON.stringify(await rawRows(instance, "providerCredentials")),
    ).not.toContain("fake-token-for-testing");
    await instance.providerCredentials.delete("moneytree");
    expect(await instance.providerCredentials.count()).toBe(0);
  });
  it("rolls back all legacy rows when encrypted read-back verification fails", async () => {
    const instance = database();
    await seed(instance);
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let calls = 0;
    vi.spyOn(crypto.subtle, "decrypt").mockImplementation((...args) => {
      calls++;
      if (calls > 1)
        return Promise.reject(new Error("Simulated decryption failure"));
      return decrypt(...args);
    });
    await expect(initializeVault(phrase, instance)).rejects.toThrow();
    expect(await getVaultStatus(instance)).toEqual({
      enabled: false,
      unlocked: false,
    });
    expect(await instance.expenses.get(expense.id)).toEqual(expense);
    expect((await rawRows(instance, "expenses"))[0]).toEqual(expense);
    expect(await instance.drafts.get("expense")).toEqual({
      id: "expense",
      value: JSON.stringify({ amount: "850", merchant: "架空カフェ" }),
    });
  });
  it("keeps ciphertext unchanged when vault metadata is damaged or removed", async () => {
    const instance = database();
    await seed(instance);
    await initializeVault(phrase, instance);
    const persisted = await rawRows(instance, "expenses");
    lockVault(instance);
    await instance.vaultMeta.clear();
    await expect(initializeVault(phrase, instance)).rejects.toThrow(
      "暗号化設定が見つかりません",
    );
    expect(await rawRows(instance, "expenses")).toEqual(persisted);
    expect(isVaultUnlocked(instance)).toBe(false);
  });
  it("stores receipt images encrypted and uses a fresh IV for every write", async () => {
    const instance = database();
    await initializeVault(phrase, instance);
    const imageBase64 = btoa("fictional receipt bitmap for privacy tests");
    await instance.receipts.put({
      ...stamp,
      id: "receipt",
      mimeType: "image/jpeg",
      imageBase64,
    });
    const first = (await rawRows(instance, "receipts"))[0];
    await instance.receipts.put({
      ...stamp,
      id: "receipt",
      mimeType: "image/jpeg",
      imageBase64,
    });
    const second = (await rawRows(instance, "receipts"))[0];
    expect(second.__iv).not.toBe(first.__iv);
    expect(JSON.stringify(second)).not.toContain(imageBase64);
    expect((await instance.receipts.get("receipt"))?.imageBase64).toBe(
      imageBase64,
    );
  });
  it("continues emitting decrypted coherent snapshots through Dexie liveQuery", async () => {
    const instance = database();
    await seed(instance);
    await initializeVault(phrase, instance);
    const snapshots: number[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        subscription.unsubscribe();
        reject(new Error("liveQuery timeout"));
      }, 5000);
      const subscription = liveQuery(() =>
        instance.expenses.toArray(),
      ).subscribe({
        next(rows) {
          snapshots.push(rows[0].amount);
          if (snapshots.length === 1)
            void instance.expenses
              .update(expense.id, { amount: 999 })
              .catch(reject);
          else if (rows[0].amount === 999) {
            clearTimeout(timeout);
            subscription.unsubscribe();
            resolve();
          }
        },
        error: reject,
      });
    });
    expect(snapshots).toEqual([850, 999]);
  });
  it("authenticates ciphertext, rejects tampering and does not delete damaged records", async () => {
    const instance = database();
    await seed(instance);
    await initializeVault(phrase, instance);
    const record = (await rawRows(instance, "expenses"))[0];
    const encrypted = String(record.__ciphertext);
    record.__ciphertext =
      (encrypted[0] === "A" ? "B" : "A") + encrypted.slice(1);
    await new Promise<void>((resolve, reject) => {
      const transaction = instance
        .backendDB()
        .transaction("expenses", "readwrite");
      transaction.objectStore("expenses").put(record);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    await expect(instance.expenses.toArray()).rejects.toThrow("読み込めません");
    expect(await instance.expenses.count()).toBe(1);
  });
  it("rejects modified blind secondary indexes even when the encrypted payload is unchanged", async () => {
    const instance = database();
    await seed(instance);
    await initializeVault(phrase, instance);
    const record = (await rawRows(instance, "expenses"))[0];
    record.merchant = "A".repeat(43) + "=";
    await new Promise<void>((resolve, reject) => {
      const transaction = instance
        .backendDB()
        .transaction("expenses", "readwrite");
      transaction.objectStore("expenses").put(record);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    await expect(instance.expenses.toArray()).rejects.toThrow("読み込めません");
    expect(await instance.expenses.count()).toBe(1);
  });
});
