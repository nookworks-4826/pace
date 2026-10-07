import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import {
  PaceDatabase,
  db,
  defaultCategories,
  defaultSettings,
  inspectStoredData,
  readAppData,
} from "../db";
import { initializeVault, lockVault, unlockVault } from "../domain/vault";
import {
  balanceDrift,
  expenseInput,
  previousExpense,
  privacyFacts,
  recentAmountSuggestions,
  reviewReasons,
  verificationDays,
} from "../domain/practical";
import { orderedQuickActions } from "../domain/quickActions";
import {
  defaultPersonalization,
  payableAccounts,
  rankPaymentSources,
} from "../domain/personalization";
import { withUndo, undoChange, recentChanges } from "../domain/undo";
import {
  checkedEncryptedBackup,
  backupHealthLabel,
} from "../domain/backupHealth";
import { createBackup, parseBackup, validateData } from "../domain/backup";
import {
  applyNotificationIntensity,
  dueReminders,
  notificationConfig,
} from "../domain/notificationCenter";
import { computeFinance } from "../domain/finance";
import { getAccountBalances } from "../domain/accounts";
import type { Account, AppData, Expense, Favorite } from "../types";
const day = "2026-10-07",
  at = "2026-10-07T00:00:00+09:00";
function account(id = "cash", kind: Account["kind"] = "CASH"): Account {
  return {
    id,
    name: "架空" + id,
    kind,
    institutionName: "架空",
    currency: "JPY",
    snapshotBalance: 10000,
    balanceAsOf: day,
    snapshotRecordedAt: at,
    lastVerifiedAt: at,
    balanceSource: "manual",
    isSpendable: kind !== "CREDIT_CARD",
    isActive: true,
    automationLevel: "manual",
    createdAt: at,
    updatedAt: at,
  };
}
function expense(id = "e", overrides: Partial<Expense> = {}): Expense {
  return {
    id,
    amount: 500,
    date: day,
    merchant: "架空カフェ",
    description: "",
    categoryId: "food",
    subcategoryId: "food-0",
    paymentMethod: "cash",
    sourceAccountId: "cash",
    memo: "架空メモ",
    isFixedCost: false,
    createdAt: "2026-10-07T01:00:00+09:00",
    updatedAt: at,
    ...overrides,
  };
}
function fixture(): AppData {
  return {
    settings: {
      ...structuredClone(defaultSettings),
      financialAutomationEnabled: true,
      openingLiquidBalance: 30000,
    },
    categories: structuredClone(defaultCategories),
    accounts: [account(), account("bank", "BANK")],
    expenses: [],
    incomes: [],
    cards: [],
    cardPayments: [],
    debts: [],
    repayments: [],
    recurringExpenses: [],
    recurringOccurrences: [],
    savingsGoals: [],
    savingsContributions: [],
    budgets: [],
    merchantRules: [],
    balanceAdjustments: [],
    dailyCheckIns: [],
    favorites: [],
    expenseInbox: [],
    receipts: [],
  };
}
const databases: PaceDatabase[] = [];
async function database() {
  const d = new PaceDatabase("practical-" + crypto.randomUUID());
  databases.push(d);
  await d.settings.put(structuredClone(defaultSettings));
  await d.categories.bulkPut(structuredClone(defaultCategories));
  await d.accounts.bulkPut(fixture().accounts!);
  await initializeVault("fictional-only-passphrase", d);
  return d;
}
afterEach(async () => {
  for (const d of databases.splice(0)) {
    d.vaultSession.readOnly = false;
    d.close();
    await d.delete();
  }
});

describe("practical input and review", () => {
  it("copies previous input without any ledger, receipt or recurring identity", () => {
    const d = fixture(),
      e = expense("original", {
        receiptId: "receipt",
        externalTransactionId: "external",
        recurringOccurrenceId: "fixed:2026-10",
        balanceEffect: "snapshot",
      });
    d.expenses = [e];
    const copy = expenseInput(previousExpense(d)!);
    expect(copy).toMatchObject({
      amount: 500,
      merchant: e.merchant,
      memo: e.memo,
    });
    for (const key of [
      "id",
      "date",
      "receiptId",
      "externalTransactionId",
      "recurringOccurrenceId",
      "balanceEffect",
      "createdAt",
    ])
      expect(copy).not.toHaveProperty(key);
    expect(d.expenses).toHaveLength(1);
  });
  it("allows a favorite without fixed amount and copies its source and memo", () => {
    const d = fixture();
    const f: Favorite = {
      id: "fav",
      name: "いつもの店",
      amount: 0,
      merchant: "架空店",
      memo: "メモ",
      categoryId: "food",
      subcategoryId: "",
      paymentMethod: "bank",
      sourceAccountId: "bank",
    };
    d.favorites = [f];
    expect(validateData(d).favorites[0].amount).toBe(0);
    expect(expenseInput(f)).toMatchObject({
      amount: undefined,
      sourceAccountId: "bank",
      memo: "メモ",
    });
  });
  it("ranks recent amounts by merchant then account, excluding future and old amounts", () => {
    const d = fixture();
    d.expenses = [
      expense("a", { amount: 100 }),
      expense("b", {
        merchant: "別の店",
        sourceAccountId: "bank",
        amount: 200,
      }),
      expense("old", { date: "2025-01-01", amount: 300 }),
      expense("future", { date: "2026-10-08", amount: 400 }),
    ];
    expect(recentAmountSuggestions(d, "架空カフェ", "bank", day)).toEqual([
      100,
    ]);
    expect(recentAmountSuggestions(d, "", "bank", day)).toEqual([200]);
  });
  it("requires three merchant records for a meaningful source ranking and respects OFF", () => {
    const d = fixture();
    d.expenses = [
      expense("a", { sourceAccountId: "bank" }),
      expense("b", { sourceAccountId: "bank" }),
      expense("c", { sourceAccountId: "bank" }),
    ];
    expect(rankPaymentSources(d, day, undefined, "架空カフェ")[0].id).toBe(
      "bank",
    );
    d.settings.personalization = { ...defaultPersonalization, enabled: false };
    expect(rankPaymentSources(d, day, undefined, "架空カフェ")[0].id).toBe(
      "cash",
    );
  });
  it("keeps missing merchant/category and partial OCR in review without losing the amount", () => {
    const e = expense("partial", {
      merchant: "支出",
      categoryId: "uncategorized",
      subcategoryId: "",
      ocrNeedsReview: true,
    });
    expect(reviewReasons(e)).toEqual(["merchant", "category", "ocr"]);
    const d = fixture();
    d.expenses = [e];
    expect(
      computeFinance(d, day).accountBalances.find(
        (b) => b.account.id === "cash",
      )?.balance,
    ).toBe(9500);
    expect(reviewReasons({ ...e, reviewed: true })).toEqual([]);
  });
  it("rejects dangling or mismatched Inbox links", () => {
    const d = fixture();
    d.expenseInbox = [
      { id: "missing", expenseId: "missing", reasons: ["ocr"] },
    ];
    expect(() => validateData(d)).toThrow();
    d.expenses = [expense()];
    d.expenseInbox = [{ id: "wrong", expenseId: "e", reasons: ["category"] }];
    expect(() => validateData(d)).toThrow();
  });
});
describe("balance, archive and reminders", () => {
  it("defaults cash/e-wallet to three days and bank/card to seven", () => {
    expect(verificationDays(account())).toBe(3);
    expect(verificationDays(account("wallet", "EWALLET"))).toBe(3);
    expect(verificationDays(account("bank", "BANK"))).toBe(7);
    expect(verificationDays(account("card", "CREDIT_CARD"))).toBe(7);
  });
  it("supports every interval and OFF suppresses reminders while retaining finance", () => {
    for (const n of [0, 1, 3, 7, 14, 30] as const) {
      const d = fixture();
      d.accounts![0] = {
        ...account(),
        verificationDays: n,
        lastVerifiedAt: "2026-09-01T00:00:00+09:00",
      };
      d.settings.notificationCenter = notificationConfig(d);
      d.settings.notificationCenter.quietEnabled = false;
      d.settings.notificationCenter.rules.balance = {
        ...d.settings.notificationCenter.rules.balance,
        enabled: true,
        frequency: "daily",
        time: "00:00",
      };
      expect(getAccountBalances(d, day)[0].isStale).toBe(n !== 0);
      expect(
        dueReminders(d, day, "12:00").some((r) => r.kind === "balance"),
      ).toBe(n !== 0);
      expect(computeFinance(d, day).liquidBalance).toBe(20000);
    }
  });
  it("archive removes new candidates without changing historical balances or restoring bad source defaults", () => {
    const d = fixture();
    d.expenses = [expense()];
    const total = computeFinance(d, day).liquidBalance;
    d.accounts![0].archivedAt = at;
    expect(payableAccounts(d).map((a) => a.id)).not.toContain("cash");
    expect(payableAccounts(d, "cash").map((a) => a.id)).toContain("cash");
    expect(computeFinance(d, day).liquidBalance).toBe(total);
    delete d.accounts![0].archivedAt;
    expect(payableAccounts(d).map((a) => a.id)).toContain("cash");
  });
  it("drift does not create expenses and keeps unknown distinct from zero", () => {
    const d = fixture();
    expect(balanceDrift(1000, 700)).toBe(-300);
    expect(balanceDrift(1000, 1300)).toBe(300);
    expect(balanceDrift(null, 0)).toBeNull();
    expect(balanceDrift(0, 0)).toBe(0);
    expect(() => balanceDrift(0, -1)).toThrow();
    expect(d.expenses).toEqual([]);
  });
  it("pins exact action positions and leaves order unchanged when optimization is OFF", () => {
    const p = {
      ...defaultPersonalization,
      quickActions: ["receipt", "balance", "history", "transfer"] as const,
      pinnedQuickActions: ["balance"] as const,
      featureUses: { transfer: 20, receipt: 1 },
    };
    expect(
      orderedQuickActions({
        ...p,
        quickActions: [...p.quickActions],
        pinnedQuickActions: [...p.pinnedQuickActions],
      }),
    ).toEqual(["transfer", "balance", "receipt", "history"]);
    expect(
      orderedQuickActions({
        ...p,
        enabled: false,
        quickActions: [...p.quickActions],
        pinnedQuickActions: [...p.pinnedQuickActions],
      }),
    ).toEqual(p.quickActions);
  });
  it("quiet intensity reduces default prompts and explicit individual ON/OFF wins", () => {
    const d = fixture(),
      c = notificationConfig(d);
    c.quietEnabled = false;
    c.rules.daily = { ...c.rules.daily, enabled: true, time: "00:00" };
    d.settings.notificationCenter = applyNotificationIntensity(c, "quiet");
    expect(dueReminders(d, day, "12:00")).toEqual([]);
    d.settings.notificationCenter.rules.daily.explicitlyConfigured = true;
    expect(dueReminders(d, day, "12:00")).toHaveLength(1);
    d.settings.notificationCenter.rules.daily.enabled = false;
    d.settings.notificationCenter = applyNotificationIntensity(
      d.settings.notificationCenter,
      "active",
    );
    expect(dueReminders(d, day, "12:00")).toEqual([]);
  });
  it("active frequency never overrides explicitly configured frequency or enables disabled notifications", () => {
    const c = notificationConfig(fixture());
    c.rules.balance.explicitlyConfigured = true;
    c.rules.balance.frequency = "monthly";
    const active = applyNotificationIntensity(c, "active");
    expect(active.rules.balance.frequency).toBe("monthly");
    expect(active.rules.backup.frequency).toBe("daily");
    expect(active.rules.backup.enabled).toBe(false);
  });
  it("acknowledged same-day notices stay gone and zero-spending confirmation removes evening reminder", () => {
    const d = fixture(),
      c = notificationConfig(d);
    c.quietEnabled = false;
    c.rules.evening = { ...c.rules.evening, enabled: true, time: "00:00" };
    d.settings.notificationCenter = c;
    expect(dueReminders(d, day, "12:00")).toHaveLength(1);
    c.rules.evening.lastAcknowledged = "evening:" + day;
    expect(dueReminders(d, day, "20:00")).toHaveLength(0);
    delete c.rules.evening.lastAcknowledged;
    d.dailyCheckIns = [
      { date: day, noSpendingConfirmed: true, confirmedAt: at },
    ];
    expect(dueReminders(d, day, "20:00")).toHaveLength(0);
  });
});
describe("encrypted undo and safe update", () => {
  it("undoes transfers and restores both account balances without creating expense", async () => {
    const d = await database(),
      before = computeFinance(await readAppData(true, d), day);
    const change = await withUndo(
      "振替",
      async () => {
        await d.transfers.add({
          id: "move",
          createdAt: "2026-10-07T02:00:00+09:00",
          updatedAt: at,
          fromAccountId: "bank",
          toAccountId: "cash",
          amount: 800,
          date: day,
          status: "confirmed",
          memo: "架空",
          fromBalanceEffect: "ledger",
          toBalanceEffect: "ledger",
        });
      },
      d,
    );
    const during = computeFinance(await readAppData(true, d), day);
    expect(
      during.accountBalances.find((b) => b.account.id === "cash")?.balance,
    ).toBe(10800);
    expect(
      during.accountBalances.find((b) => b.account.id === "bank")?.balance,
    ).toBe(9200);
    expect(during.liquidBalance).toBe(before.liquidBalance);
    await undoChange(change.id, d);
    expect(computeFinance(await readAppData(true, d), day).liquidBalance).toBe(
      before.liquidBalance,
    );
    expect(await d.transfers.count()).toBe(0);
  });
  it("expense Undo restores card pending liability along with its ledger", async () => {
    const d = await database();
    await d.cards.put({
      id: "card",
      createdAt: at,
      updatedAt: at,
      name: "架空カード",
      last4: "1234",
      closingDay: 31,
      paymentDay: 10,
      paymentMonthOffset: 1,
      openingOutstanding: 0,
      isActive: true,
    });
    await d.accounts.put({
      ...account("credit", "CREDIT_CARD"),
      snapshotBalance: 0,
      creditCardId: "card",
    });
    const change = await withUndo(
      "カード支出",
      async () => {
        await d.expenses.add(
          expense("card-expense", {
            sourceAccountId: "credit",
            paymentMethod: "creditCard",
            creditCardId: "card",
            pendingStatus: "pending",
            balanceEffect: "ledger",
          }),
        );
      },
      d,
    );
    expect(
      computeFinance(await readAppData(true, d), day).accountBalances.find(
        (b) => b.account.id === "credit",
      )?.balance,
    ).toBe(500);
    await undoChange(change.id, d);
    expect(
      computeFinance(await readAppData(true, d), day).accountBalances.find(
        (b) => b.account.id === "credit",
      )?.balance,
    ).toBe(0);
  });
  it("schema three encrypted records migrate to four without rewriting their ciphertext", async () => {
    const original = await database();
    await original.expenses.add(expense());
    const name = "old-practical-" + crypto.randomUUID(),
      stores: Record<string, string> = {},
      raw: Record<string, unknown[]> = {};
    for (const table of original.tables.filter(
      (t) => t.name !== "expenseInbox",
    )) {
      stores[table.name] = [
        table.schema.primKey.src,
        ...table.schema.indexes.map((i) => i.src),
      ].join(",");
      raw[table.name] = await new Promise((resolve, reject) => {
        const r = original
          .backendDB()
          .transaction(table.name)
          .objectStore(table.name)
          .getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    const old = new Dexie(name);
    old.version(3).stores(stores);
    await old.open();
    for (const table of old.tables) await table.bulkPut(raw[table.name]);
    old.close();
    const migrated = new PaceDatabase(name);
    databases.push(migrated);
    await migrated.open();
    await unlockVault("fictional-only-passphrase", migrated);
    expect(await migrated.expenses.toArray()).toEqual(
      await original.expenses.toArray(),
    );
    expect(await migrated.expenseInbox.count()).toBe(0);
    await inspectStoredData(migrated);
    const ciphertext = await new Promise((resolve, reject) => {
      const r = migrated
        .backendDB()
        .transaction("expenses")
        .objectStore("expenses")
        .getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    expect(ciphertext).toEqual(raw.expenses);
  });
  it("does not offer an unusable Undo when every balance check is deferred", async () => {
    const d = await database();
    const result = await withUndo("残高確認を保留", async () => undefined, d);
    expect(result.id).toBe("");
    expect(await recentChanges(d)).toHaveLength(0);
  });
  it("undoes new expense, Inbox and merchant rule as a single encrypted operation", async () => {
    const d = await database();
    const e = expense();
    const change = await withUndo(
      "支出を追加",
      async () => {
        await d.expenses.add(e);
        await d.expenseInbox.add({
          id: e.id,
          expenseId: e.id,
          reasons: ["category"],
        });
        await d.merchantRules.put({
          normalizedMerchant: "架空カフェ",
          categoryId: "food",
          subcategoryId: "food-0",
          usageCount: 1,
          lastUsedAt: at,
        });
      },
      d,
    );
    expect(await d.expenses.count()).toBe(1);
    await undoChange(change.id, d);
    expect(await d.expenses.count()).toBe(0);
    expect(await d.expenseInbox.count()).toBe(0);
    expect(await d.merchantRules.count()).toBe(0);
  });
  it("restores deleted expense, related receipt and review queue", async () => {
    const d = await database();
    await d.expenses.add(expense("e", { receiptId: "r" }));
    await d.receipts.add({
      id: "r",
      createdAt: at,
      updatedAt: at,
      mimeType: "image/jpeg",
      imageBase64: "YWJj",
      expenseId: "e",
    });
    await d.expenseInbox.add({
      id: "e",
      expenseId: "e",
      reasons: ["merchant"],
    });
    const change = await withUndo(
      "支出を削除",
      async () => {
        await d.expenses.delete("e");
        await d.expenseInbox.delete("e");
        await d.receipts.update("r", { expenseId: undefined });
      },
      d,
    );
    await undoChange(change.id, d);
    expect((await d.expenses.get("e"))?.receiptId).toBe("r");
    expect((await d.receipts.get("r"))?.expenseId).toBe("e");
    expect(await d.expenseInbox.count()).toBe(1);
    expect((await d.drafts.get(change.id))?.value).not.toContain("YWJj");
  });
  it("rejects a conflicting Undo without partial restoration or repeated cancellation", async () => {
    const d = await database();
    await d.expenses.add(expense());
    const change = await withUndo(
      "編集",
      async () => {
        await d.expenses.update("e", { amount: 800 });
      },
      d,
    );
    await d.expenses.update("e", { amount: 900 });
    await expect(undoChange(change.id, d)).rejects.toThrow("変わりました");
    expect((await d.expenses.get("e"))?.amount).toBe(900);
  });
  it("restores snapshot balance and its adjustment together", async () => {
    const d = await database();
    const before = await d.accounts.get("cash");
    const change = await withUndo(
      "残高調整",
      async () => {
        await d.accounts.update("cash", {
          snapshotBalance: 7000,
          lastVerifiedAt: "2026-10-08T00:00:00+09:00",
        });
        await d.accountAdjustments.add({
          id: "adjust",
          createdAt: at,
          updatedAt: at,
          accountId: "cash",
          date: day,
          previousBalance: 10000,
          newBalance: 7000,
          memo: "",
        });
      },
      d,
    );
    await undoChange(change.id, d);
    expect(await d.accounts.get("cash")).toEqual(before);
    expect(await d.accountAdjustments.count()).toBe(0);
  });
  it("bounds Undo to twenty encrypted records and excludes images", async () => {
    const d = await database();
    for (let i = 0; i < 24; i++)
      await withUndo(
        "架空" + i,
        async () => {
          await d.expenses.put(expense("e" + i));
        },
        d,
      );
    expect(await recentChanges(d)).toHaveLength(20);
    const raw = await new Promise<unknown[]>((resolve, reject) => {
      const r = d
        .backendDB()
        .transaction("drafts")
        .objectStore("drafts")
        .getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    expect(JSON.stringify(raw)).not.toContain("架空");
    expect(JSON.stringify(raw)).not.toContain("架空メモ");
  });
  it("detects broken references before writing and enables storage-level read-only protection", async () => {
    const d = await database();
    await d.expenseInbox.add({
      id: "gone",
      expenseId: "gone",
      reasons: ["ocr"],
    });
    await expect(inspectStoredData(d)).rejects.toThrow();
    expect(d.vaultSession.readOnly).toBe(true);
    await expect(d.expenses.put(expense())).rejects.toThrow("書き込み");
    expect(await d.expenseInbox.count()).toBe(1);
  });
  it("missing settings do not silently reinitialize a ledger", async () => {
    const d = await database();
    await d.settings.delete("main");
    await expect(inspectStoredData(d)).rejects.toThrow();
    expect(await d.accounts.count()).toBe(2);
    expect(await d.settings.count()).toBe(0);
  });
  it("validates decrypted stores without changing normal financial data", async () => {
    const d = await database();
    await d.expenses.add(expense());
    const before = await readAppData(true, d);
    await inspectStoredData(d);
    expect(await readAppData(true, d)).toEqual(before);
    lockVault(d);
    await expect(inspectStoredData(d)).rejects.toThrow();
    d.vaultSession.readOnly = false;
    await unlockVault("fictional-only-passphrase", d);
    expect(await d.expenses.count()).toBe(1);
  });
});
describe("backup and privacy truth", () => {
  it("rejects a claimed normal backup without encryption, file confirmation or content", () => {
    for (const extra of [
      { encrypted: false },
      { savedConfirmed: false },
      { bytes: 0 },
    ]) {
      const d = fixture();
      d.settings.practical = {
        backupHealth: {
          status: "normal",
          checkedAt: at,
          encrypted: true,
          schemaVersion: 4,
          bytes: 100,
          savedConfirmed: true,
          ...extra,
        },
      };
      expect(() => validateData(d)).toThrow();
    }
  });
  it("round-trips schema four, new optional fields, Inbox and normal legacy schema three", async () => {
    const d = fixture();
    d.expenses = [expense()];
    d.expenseInbox = [{ id: "e", expenseId: "e", reasons: ["ocr"] }];
    d.accounts![0].verificationDays = 14;
    const text = createBackup(d);
    expect(JSON.parse(text).schemaVersion).toBe(4);
    expect(await parseBackup(text)).toEqual(d);
    const old = JSON.parse(text);
    old.schemaVersion = old.metadata.schemaVersion = 3;
    delete old.data.expenseInbox;
    delete old.data.settings.practical;
    expect((await parseBackup(JSON.stringify(old))).expenses).toEqual(
      d.expenses,
    );
  });
  it("checks actual encrypted bytes and decryptability but leaves OS file state unconfirmed", async () => {
    const result = await checkedEncryptedBackup(
      fixture(),
      "fictional-backup-password",
    );
    expect(result.health).toMatchObject({
      status: "review",
      encrypted: true,
      schemaVersion: 4,
      savedConfirmed: false,
    });
    expect(result.health.bytes).toBeGreaterThan(0);
    expect(backupHealthLabel(result.health)).toBe("要確認");
    expect(backupHealthLabel({ ...result.health, status: "failed" })).toBe(
      "失敗",
    );
    expect(backupHealthLabel()).toBe("未確認");
  });
  it("rejects invalid references before claiming backup success", async () => {
    const d = fixture();
    d.expenses = [expense("invalid", { sourceAccountId: "missing" })];
    await expect(
      checkedEncryptedBackup(d, "fictional-backup-password"),
    ).rejects.toThrow();
  });
  it("privacy center describes actual optional receipt and backup state", () => {
    const d = fixture();
    expect(privacyFacts(d)).toMatchObject({
      externalAI: "未使用",
      externalOCR: "未使用",
      financialAPI: "未接続",
      receipts: 0,
      backup: null,
    });
    expect(db.name).toBeTruthy();
  });
});
