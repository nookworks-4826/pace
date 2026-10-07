import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import type { Account, AppData, Expense } from "../types";
import { defaultCategories, defaultSettings, PaceDatabase } from "../db";
import {
  detectReceipt,
  imageDimensions,
  imageQuality,
  receiptFraming,
  prepareReceipt,
  rectifyReceipt,
  validQuad,
  type Raster,
  type Quad,
} from "../domain/receiptImage";
import {
  defaultPersonalization,
  orderHomeCards,
  payableAccounts,
  rankPaymentSources,
  unusualAmount,
} from "../domain/personalization";
import {
  dueReminders,
  mergeReminderPreferences,
  isQuiet,
  notificationConfig,
  privateNotificationMessage,
} from "../domain/notificationCenter";
import { parseReceiptText, refineReceiptTotal } from "../domain/receipts";
import { getAccountBalances } from "../domain/accounts";
import { computeFinance } from "../domain/finance";
import { searchExpenses } from "../domain/smartSearch";
import { suggestLocalCategory } from "../domain/localAssistant";
import { createBackup, parseBackup } from "../domain/backup";
import { initializeVault, lockVault, unlockVault } from "../domain/vault";
const today = "2026-10-07",
  at = "2026-10-01T00:00:00+09:00";
const account = (id: string, kind: Account["kind"] = "CASH"): Account => ({
  id,
  name: id,
  kind,
  institutionName: "架空",
  currency: "JPY",
  snapshotBalance: 10000,
  balanceAsOf: "2026-10-01",
  snapshotRecordedAt: at,
  balanceSource: "manual",
  isSpendable: kind !== "CREDIT_CARD",
  isActive: true,
  automationLevel: "manual",
  createdAt: at,
  updatedAt: at,
});
const expense = (
  id: string,
  sourceAccountId = "cash",
  amount = 500,
): Expense => ({
  id,
  sourceAccountId,
  amount,
  date: today,
  merchant: "架空カフェ",
  description: "",
  categoryId: "food",
  subcategoryId: "food-0",
  paymentMethod: "cash",
  memo: "",
  isFixedCost: false,
  createdAt: at,
  updatedAt: at,
});
function fixture(): AppData {
  return {
    settings: {
      ...structuredClone(defaultSettings),
      openingLiquidBalance: 30000,
    },
    categories: structuredClone(defaultCategories),
    accounts: [
      account("cash"),
      account("bank", "BANK"),
      account("Suica", "EWALLET"),
      account("PayPay", "EWALLET"),
      account("bank2", "BANK"),
      account("card", "CREDIT_CARD"),
      account("savings", "SAVINGS"),
    ],
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
  };
}
function raster(w = 400, h = 600, v = 60): Raster {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}
function fill(
  r: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  v: number,
) {
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * r.width + x) * 4;
      r.data[i] = r.data[i + 1] = r.data[i + 2] = v;
    }
}
describe("receipt image pipeline with fictional backgrounds", () => {
  it("detects centered paper despite disconnected light background information", () => {
    const r = raster();
    fill(r, 100, 30, 300, 570, 245);
    fill(r, 5, 100, 55, 115, 250);
    for (let y = 90; y < 500; y += 40) fill(r, 125, y, 265, y + 6, 20);
    const q = detectReceipt(r);
    expect(q).not.toBeNull();
    expect(q![0].x).toBeGreaterThan(0.2);
    expect(q![1].x).toBeLessThan(0.8);
  });
  it("excludes all background pixels before OCR, rather than merely hiding them", () => {
    const r = raster();
    fill(r, 100, 30, 300, 570, 240);
    const crop = rectifyReceipt(r, [
      { x: 0.27, y: 0.07 },
      { x: 0.72, y: 0.07 },
      { x: 0.72, y: 0.92 },
      { x: 0.27, y: 0.92 },
    ]);
    expect(Math.min(...crop.data.filter((_, i) => i % 4 === 0))).toBe(240);
    expect(crop.width).toBeLessThan(r.width);
  });
  it("rectifies a perspective quad with bounded output", () => {
    const r = raster(600, 800, 220);
    const q: Quad = [
      { x: 0.3, y: 0.08 },
      { x: 0.85, y: 0.18 },
      { x: 0.75, y: 0.9 },
      { x: 0.12, y: 0.8 },
    ];
    expect(validQuad(q)).toBe(true);
    const corrected = rectifyReceipt(r, q, 400);
    expect(Math.max(corrected.width, corrected.height)).toBeLessThanOrEqual(
      400,
    );
    expect(corrected.data[0]).toBe(220);
  });
  it("rejects crossed, tiny or out-of-image corner selections", () => {
    for (const q of [
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ],
      [
        { x: -0.1, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
    ])
      expect(() => rectifyReceipt(raster(), q as Quad)).toThrow();
  });
  it("warns about blur, darkness, tiny images and whiteout", () => {
    expect(imageQuality(raster(400, 600, 120)).join()).toContain("ぶれ");
    expect(imageQuality(raster(400, 600, 20)).join()).toContain("暗い");
    expect(imageQuality(raster(40, 60, 100)).join()).toContain("小さ");
    expect(imageQuality(raster(400, 600, 255)).join()).toContain("白飛び");
  });
  it("produces local binarization and retains a grayscale fallback", () => {
    const r = raster(400, 600, 200);
    fill(r, 50, 50, 100, 90, 40);
    const binary = prepareReceipt(r);
    expect(new Set(binary.data.filter((_, i) => i % 4 === 0))).toEqual(
      new Set([0, 255]),
    );
    const gray = prepareReceipt(r, false);
    expect(gray.data[0]).toBe(gray.data[1]);
  });
  it("does not call a uniformly bright photo a detected receipt", () =>
    expect(detectReceipt(raster(400, 600, 255))).toBeNull());
});
describe("additional review safeguards", () => {
  it("warns when the suggested frame is small, tilted or touches the photo edge", () => {
    const q: Quad = [
      { x: 0, y: 0.1 },
      { x: 0.4, y: 0.3 },
      { x: 0.35, y: 0.7 },
      { x: 0.05, y: 0.6 },
    ];
    expect(receiptFraming(q, 400, 600).join()).toMatch(/近づ|全体|傾/);
    expect(
      receiptFraming(
        [
          { x: 0.2, y: 0.1 },
          { x: 0.8, y: 0.1 },
          { x: 0.8, y: 0.9 },
          { x: 0.2, y: 0.9 },
        ],
        400,
        600,
      ),
    ).toEqual([]);
  });
  it("rejects malformed backup card permutations instead of dropping cards", async () => {
    const d = fixture();
    d.accounts = [];
    const backup = JSON.parse(createBackup(d));
    backup.data.settings.personalization = {
      enabled: true,
      pinnedCards: [],
      homeCardOrder: ["recent", "recent", "balances"],
      featureUses: {},
    };
    await expect(parseBackup(JSON.stringify(backup))).rejects.toThrow();
  });
  it("returns the most visited merchant in the recent period", () => {
    const d = fixture();
    d.expenses = [
      expense("a"),
      expense("b"),
      { ...expense("c"), merchant: "別の架空店" },
    ];
    expect(
      searchExpenses(d, "最近一番使っている店", today).map((e) => e.id),
    ).toEqual(["a", "b"]);
  });
});

describe("receipt confidence and multiple amounts", () => {
  it("never mistakes subtotal/tender/tax/points for total", () => {
    const r = parseReceiptText(
      "架空マート\n2026/10/07\nSUBTOTAL 900\nTAX 90\nTOTAL 990\nCHANGE 10\nPOINTS 99999\nお預り 1000",
    );
    expect(r.amount).toBe(990);
    expect(r.amountCandidates).toHaveLength(1);
  });
  it("returns all labeled candidates and lowers confidence on conflicts", () => {
    const r = parseReceiptText("架空店\n合計 800\n総合計 880");
    expect(r.amountCandidates?.map((c) => c.amount).sort()).toEqual([800, 880]);
    expect(r.confidence!.amount).toBeLessThan(0.75);
  });
  it("leaves a low engine-confidence total for user confirmation", () =>
    expect(parseReceiptText("合計 810", 40).confidence!.amount).toBeLessThan(
      0.75,
    ));
  it("does not use an invoice number, phone or product price as an unlabeled total", () =>
    expect(
      parseReceiptText("TEL 0451234567\n伝票 9000\nパン 800").amount,
    ).toBeUndefined());
});
describe("dynamic accounts and local personalization", () => {
  it("includes every available source without a hardcoded two-source limit", () => {
    const d = fixture();
    expect(new Set(payableAccounts(d).map((a) => a.id))).toEqual(
      new Set(["cash", "bank", "Suica", "PayPay", "bank2", "card"]),
    );
  });
  it("ranks by recent local use without removing the rest of the sources", () => {
    const d = fixture();
    d.expenses = [
      expense("1", "PayPay"),
      expense("2", "cash"),
      expense("3", "PayPay"),
    ];
    expect(rankPaymentSources(d, today)[0].id).toBe("PayPay");
    expect(rankPaymentSources(d, today)).toHaveLength(6);
  });
  it("ignores future/old records and restores stable ordering with personalization OFF", () => {
    const d = fixture();
    d.expenses = [
      { ...expense("1", "PayPay"), date: "2025-01-01" },
      { ...expense("2", "PayPay"), date: "2027-01-01" },
    ];
    expect(rankPaymentSources(d, today)[0].id).toBe("cash");
    d.settings.personalization = { ...defaultPersonalization, enabled: false };
    d.expenses = [expense("3", "PayPay")];
    expect(rankPaymentSources(d, today)[0].id).toBe("cash");
  });
  it("retains a pinned card at its chosen slot while moving other cards", () => {
    const d = fixture();
    d.settings.personalization = {
      enabled: true,
      pinnedCards: ["recent"],
      homeCardOrder: ["insight", "recent", "balances"],
      featureUses: { balance: 100 },
    };
    expect(orderHomeCards(d, today)).toEqual(["balances", "recent", "insight"]);
    d.settings.personalization.enabled = false;
    expect(orderHomeCards(d, today)).toEqual(["insight", "recent", "balances"]);
  });
  it("flags possible input errors only after enough same-merchant history", () => {
    const d = fixture();
    d.expenses = Array.from({ length: 5 }, (_, i) =>
      expense(String(i), "cash", 600),
    );
    expect(unusualAmount(d.expenses, "架空カフェ", 10000)).toBe(true);
    expect(unusualAmount(d.expenses, "架空カフェ", 900)).toBe(false);
    expect(unusualAmount(d.expenses.slice(0, 2), "架空カフェ", 10000)).toBe(
      false,
    );
  });
  it("marks stale manual cash while respecting a recent verification", () => {
    const d = fixture();
    expect(
      getAccountBalances(d, today, "2026-10-07T12:00:00+09:00")[0].isStale,
    ).toBe(true);
    d.accounts![0].lastVerifiedAt = "2026-10-07T11:00:00+09:00";
    expect(
      getAccountBalances(d, today, "2026-10-07T12:00:00+09:00")[0].isStale,
    ).toBe(false);
  });
});
describe("actual private reminder evaluation", () => {
  it("defaults to generic content and quiet hours overnight", () => {
    const d = fixture(),
      c = notificationConfig(d);
    expect(c.rules.daily.showAmount).toBe(false);
    expect(isQuiet("23:10", c)).toBe(true);
    expect(isQuiet("06:59", c)).toBe(true);
    expect(isQuiet("07:00", c)).toBe(false);
    d.settings.notificationCenter = c;
    c.rules.daily.enabled = true;
    expect(dueReminders(d, today, "08:00")[0].message).toBe(
      "Paceを確認してください",
    );
  });
  it("keeps OS previews generic even when app-only amounts are explicitly enabled", () => {
    const d = fixture(),
      c = notificationConfig(d);
    d.settings.notificationCenter = c;
    c.rules.daily.enabled = true;
    c.rules.daily.showAmount = true;
    expect(dueReminders(d, today, "08:00")[0].message).toContain("¥");
    expect(privateNotificationMessage("daily")).not.toContain("¥");
  });
  it("applies weekday, snooze and acknowledgement without fake notifications", () => {
    const d = fixture(),
      c = notificationConfig(d);
    d.settings.notificationCenter = c;
    c.rules.daily.enabled = true;
    c.rules.daily.days = [3];
    expect(dueReminders(d, today, "08:00")).toHaveLength(1);
    c.rules.daily.snoozedUntil = "2026-10-07T12:00:00+09:00";
    expect(
      dueReminders(d, today, "08:00", Date.parse("2026-10-07T08:00:00+09:00")),
    ).toHaveLength(0);
    c.rules.daily.snoozedUntil = undefined;
    c.rules.daily.lastAcknowledged = "daily:" + today;
    expect(dueReminders(d, today, "08:00")).toHaveLength(0);
  });
  it("uses the salary schedule, avoids assuming an actual salary deposit", () => {
    const d = fixture(),
      c = notificationConfig(d);
    d.settings.notificationCenter = c;
    d.settings.salarySchedule = {
      payday: 10,
      expectedAmount: 90000,
      variableIncome: true,
    };
    c.rules.payday.enabled = true;
    expect(dueReminders(d, "2026-10-10", "12:00").map((r) => r.kind)).toEqual([
      "payday",
    ]);
    expect(dueReminders(d, today, "12:00")).toHaveLength(0);
    expect(computeFinance(d, "2026-10-10").liquidBalance).toBe(30000);
  });
  it("shows a backup reminder only after 30 days with the requested frequency", () => {
    const d = fixture(),
      c = notificationConfig(d);
    d.settings.notificationCenter = c;
    c.rules.backup.enabled = true;
    c.rules.backup.frequency = "daily";
    d.settings.lastBackupAt = "2026-10-06T00:00:00+09:00";
    expect(dueReminders(d, today, "20:00")).toHaveLength(0);
    d.settings.lastBackupAt = "2026-09-01T00:00:00+09:00";
    expect(dueReminders(d, today, "20:00")[0].kind).toBe("backup");
  });
});
describe("rules/history search without a cloud/GPU fallback", () => {
  it.each(["AI unavailable", "WebGPU unavailable", "low memory"])(
    "works with %s",
    () => {
      vi.stubGlobal("navigator", { deviceMemory: 1 });
      try {
        const d = fixture();
        d.expenses = [expense("a", "Suica", 600), expense("b", "cash", 400)];
        expect(
          searchExpenses(d, "Suicaで使ったもの", today).map((e) => e.id),
        ).toEqual(["a"]);
        expect(
          searchExpenses(d, "500円以上 外食", today).map((e) => e.id),
        ).toEqual(["a"]);
        expect(suggestLocalCategory("セブン", d).categoryId).toBe("food");
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
  it("searches last month and uses exact historical categories after existing rules", () => {
    const d = fixture();
    d.expenses = [{ ...expense("a"), date: "2026-09-20" }, expense("b")];
    expect(searchExpenses(d, "先月の外食", today).map((e) => e.id)).toEqual([
      "a",
    ]);
    expect(suggestLocalCategory("架空カフェ", d).categoryId).toBe("food");
  });
  it("does not execute query syntax", () => {
    expect(
      searchExpenses(fixture(), "__proto__ OR 1=1; fetch()", today),
    ).toEqual([]);
  });
});
describe("calculation and preservation", () => {
  it("keeps the same morning allowance after an ordinary payment, consuming it once", () => {
    const d = fixture();
    d.accounts = [];
    const before = computeFinance(d, today);
    d.expenses = [expense("a", "cash", 500)];
    const after = computeFinance(d, today);
    expect(after.dailyAllowance).toBe(before.dailyAllowance);
    expect(after.todayRemaining).toBe(before.dailyAllowance! - 500);
    expect(after.safeToSpend).toBe(29500);
  });
  it("retains negative safeToSpend and never shows a positive allowance during shortage", () => {
    const d = fixture();
    d.accounts = [];
    d.expenses = [expense("a", "cash", 35000)];
    expect(computeFinance(d, today)).toMatchObject({
      safeToSpend: -5000,
      dailyAllowance: 0,
      todayRemaining: 0,
    });
  });
  it("round-trips new encrypted preferences with schemas 1/2/3 accepted", async () => {
    const d = fixture();
    d.accounts = [];
    d.settings.personalization = {
      ...defaultPersonalization,
      featureUses: { receipt: 4 },
    };
    d.settings.notificationCenter = notificationConfig(d);
    const json = createBackup(d);
    expect(JSON.parse(json).schemaVersion).toBe(4);
    expect(await parseBackup(json)).toEqual(d);
    for (const schemaVersion of [1, 2, 3]) {
      const old = JSON.parse(json);
      old.schemaVersion = schemaVersion;
      old.metadata.schemaVersion = schemaVersion;
      delete old.data.settings.personalization;
      delete old.data.settings.notificationCenter;
      expect((await parseBackup(JSON.stringify(old))).expenses).toEqual([]);
    }
  });
  it("encrypts personalization/notification records and reads them after locking/unlocking", async () => {
    const db = new PaceDatabase("pace-experience-" + crypto.randomUUID());
    try {
      const s = {
        ...structuredClone(defaultSettings),
        personalization: {
          ...defaultPersonalization,
          featureUses: { "FICTIONAL-PRIVATE-USAGE": 4 },
        },
      };
      await db.settings.put(s);
      await initializeVault("fictional local secure phrase", db);
      const raw = await new Promise<unknown[]>((resolve) => {
        const req = db
          .backendDB()
          .transaction("settings")
          .objectStore("settings")
          .getAll();
        req.onsuccess = () => resolve(req.result);
      });
      expect(JSON.stringify(raw)).not.toContain("FICTIONAL-PRIVATE-USAGE");
      lockVault(db);
      await expect(db.settings.get("main")).rejects.toThrow();
      await unlockVault("fictional local secure phrase", db);
      expect((await db.settings.get("main"))?.personalization).toEqual(
        s.personalization,
      );
    } finally {
      db.close();
      await PaceDatabase.delete(db.name);
    }
  }, 30_000); // Real PBKDF2 initialization + unlock must retain 600,000 iterations under CPU contention.
});

describe("bounded image decode headers", () => {
  it("reads PNG dimensions before decoding a compressed large photo", () => {
    const b = new Uint8Array(24);
    b.set([137, 80, 78, 71]);
    b.set([73, 72, 68, 82], 12);
    const v = new DataView(b.buffer);
    v.setUint32(16, 10000);
    v.setUint32(20, 10000);
    expect(imageDimensions(b)).toEqual({ width: 10000, height: 10000 });
  });
  it("reads JPEG dimensions and rejects truncated segments safely", () => {
    const b = new Uint8Array([255, 216, 255, 192, 0, 8, 8, 4, 176, 3, 32, 0]);
    expect(imageDimensions(b)).toEqual({ width: 800, height: 1200 });
    expect(imageDimensions(b.slice(0, 9))).toBeNull();
    expect(imageDimensions(new Uint8Array(24))).toBeNull();
  });
  it("reads WebP extended dimensions without allocating pixels", () => {
    const b = new Uint8Array(30);
    for (const [at, value] of [
      [0, "RIFF"],
      [8, "WEBP"],
      [12, "VP8X"],
    ] as const)
      b.set(
        [...value].map((c) => c.charCodeAt(0)),
        at,
      );
    b[24] = 31;
    b[25] = 3;
    b[27] = 175;
    b[28] = 4;
    expect(imageDimensions(b)).toEqual({ width: 800, height: 1200 });
  });
});

describe("focused OCR cannot erase ambiguity", () => {
  it("keeps conflicting labeled totals low confidence even when a crop repeats one", () => {
    const first = parseReceiptText("架空店\n合計 800\n総合計 880");
    const next = refineReceiptTotal(first, parseReceiptText("総合計 880"));
    expect(next.confidence!.amount).toBeLessThan(0.75);
    expect(next.amountCandidates?.map((x) => x.amount).sort()).toEqual([
      800, 880,
    ]);
  });
  it("does not invent certainty when the first pass found equally ranked totals", () => {
    const next = refineReceiptTotal(
      parseReceiptText("合計 800\n合計 880"),
      parseReceiptText("合計 880"),
    );
    expect(next.amount).toBeUndefined();
    expect(next.confidence!.amount).toBeLessThan(0.75);
  });
  it("strengthens a single matching total while preserving the original merchant/date", () => {
    const first = parseReceiptText("架空店\n2026/10/07\n合計 880", 50);
    const next = refineReceiptTotal(first, parseReceiptText("合計 880", 95));
    expect(next.amount).toBe(880);
    expect(next.confidence!.amount).toBeGreaterThan(0.75);
    expect(next.merchant).toBe("架空店");
    expect(next.date).toBe("2026-10-07");
  });
});

describe("notification settings preserve live acknowledgement state", () => {
  it("does not undo a confirmation/snooze when an older settings form is saved", () => {
    const pref = notificationConfig(fixture()),
      live = structuredClone(pref);
    live.rules.daily.lastAcknowledged = "daily:" + today;
    live.rules.daily.lastDelivered = "daily:" + today;
    live.rules.daily.snoozedUntil = "2026-10-07T22:00:00+09:00";
    pref.rules.daily.time = "09:00";
    const next = mergeReminderPreferences(pref, live);
    expect(next.rules.daily).toMatchObject({
      time: "09:00",
      lastAcknowledged: "daily:" + today,
      lastDelivered: "daily:" + today,
      snoozedUntil: "2026-10-07T22:00:00+09:00",
    });
  });
});

describe("English optional receipt metadata", () => {
  it("keeps TAX separate from TOTAL", () => {
    expect(
      parseReceiptText("FICTIONAL MARKET\nTAX 32\nTOTAL 432"),
    ).toMatchObject({ amount: 432, tax: 32 });
  });
});
