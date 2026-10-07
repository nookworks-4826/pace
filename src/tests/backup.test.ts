import { describe, expect, it } from "vitest";
import {
  createBackup,
  parseBackup,
  encryptBackup,
  buildCSV,
  buildExcel,
  bytesToBase64,
} from "../domain/backup";
import type { AppData } from "../types";
import { APP_VERSION, SCHEMA_VERSION } from "../types";

const now = "2026-09-24T04:00:00.000Z";
const stamp = { createdAt: now, updatedAt: now };
function fixture(): AppData {
  return {
    expenses: [
      {
        ...stamp,
        id: "e1",
        amount: 1280,
        date: "2026-09-24",
        merchant: "サイゼリヤ",
        description: "",
        categoryId: "food",
        subcategoryId: "food-0",
        paymentMethod: "creditCard",
        creditCardId: "c1",
        memo: "昼食",
        isFixedCost: false,
      },
    ],
    incomes: [
      {
        ...stamp,
        id: "i1",
        amount: 30000,
        date: "2026-09-20",
        source: "アルバイト",
        memo: "",
        type: "salary",
      },
    ],
    cards: [
      {
        ...stamp,
        id: "c1",
        name: "Visa",
        last4: "1234",
        closingDay: 31,
        paymentDay: 27,
        paymentMonthOffset: 1,
        openingOutstanding: 1000,
        isActive: true,
      },
    ],
    cardPayments: [],
    debts: [],
    repayments: [],
    recurringExpenses: [],
    recurringOccurrences: [],
    savingsGoals: [],
    savingsContributions: [],
    budgets: [],
    settings: {
      id: "main",
      openingLiquidBalance: 30000,
      salarySchedule: null,
      theme: "default",
      colorMode: "system",
      onboardingCompleted: true,
      setupReviewed: [],
      helpDismissed: false,
      lastBackupAt: null,
      lastSeenMonth: "2026-09",
      lockAfterSeconds: 60,
    },
    merchantRules: [],
    categories: [
      {
        id: "food",
        name: "食費",
        color: "#286a75",
        icon: "Utensils",
        subcategories: [{ id: "food-0", name: "外食" }],
      },
    ],
    balanceAdjustments: [],
    dailyCheckIns: [],
    favorites: [],
  };
}
function automatedFixture(): AppData {
  const data = fixture();
  data.financialConnections = [
    {
      ...stamp,
      id: "connection",
      providerId: "mock",
      status: "connected",
      institutionIds: ["fictional-bank"],
      consentedAt: now,
    },
  ];
  data.accounts = [
    {
      ...stamp,
      id: "bank",
      name: "架空銀行",
      kind: "BANK",
      institutionName: "架空銀行",
      currency: "JPY",
      snapshotBalance: 30000,
      balanceAsOf: "2026-09-24",
      snapshotRecordedAt: now,
      balanceSource: "provider",
      providerId: "mock",
      connectionId: "connection",
      externalAccountId: "ext-bank",
      isSpendable: true,
      isActive: true,
      automationLevel: "automatic",
    },
    {
      ...stamp,
      id: "cash",
      name: "現金",
      kind: "CASH",
      institutionName: "",
      currency: "JPY",
      snapshotBalance: 5000,
      balanceAsOf: "2026-09-24",
      snapshotRecordedAt: now,
      balanceSource: "manual",
      isSpendable: true,
      isActive: true,
      automationLevel: "semi",
    },
    {
      ...stamp,
      id: "credit",
      name: "架空カード",
      kind: "CREDIT_CARD",
      institutionName: "",
      currency: "JPY",
      snapshotBalance: 1000,
      balanceAsOf: "2026-09-24",
      snapshotRecordedAt: now,
      balanceSource: "manual",
      creditCardId: "c1",
      isSpendable: false,
      isActive: true,
      automationLevel: "manual",
    },
  ];
  data.expenses[0].sourceAccountId = "credit";
  data.expenses[0].paymentChannel = "applePay";
  data.expenses[0].receiptId = "receipt";
  data.transfers = [
    {
      ...stamp,
      id: "atm",
      fromAccountId: "bank",
      toAccountId: "cash",
      amount: 10000,
      date: "2026-09-24",
      memo: "ATM出金",
      fromBalanceEffect: "snapshot",
      toBalanceEffect: "ledger",
      status: "confirmed",
    },
  ];
  data.externalTransactions = [
    {
      ...stamp,
      id: "refund",
      providerId: "mock",
      connectionId: "connection",
      externalTransactionId: "refund-external",
      externalAccountId: "ext-bank",
      accountId: "bank",
      date: "2026-09-24",
      amount: 280,
      description: "返金",
      currency: "JPY",
      pendingStatus: "posted",
      externalUpdatedAt: now,
      kind: "refund",
      relatedExpenseId: "e1",
    },
  ];
  data.syncStates = [
    {
      id: "connection",
      lastAttemptAt: now,
      lastSuccessAt: now,
      nextRefreshAllowedAt: now,
      status: "idle",
      message: "",
    },
  ];
  data.receipts = [
    {
      ...stamp,
      id: "receipt",
      expenseId: "e1",
      mimeType: "image/jpeg",
      imageBase64: "AA==",
    },
  ];
  data.salaryRules = [
    {
      ...stamp,
      id: "salary-rule",
      accountId: "bank",
      normalizedDescription: "架空給与",
      enabled: true,
    },
  ];
  data.financialAudits = [
    {
      ...stamp,
      id: "audit",
      action: "match",
      recordId: "atm",
      detail: "振替として確認",
    },
  ];
  data.accountAdjustments = [
    {
      ...stamp,
      id: "adjustment",
      accountId: "cash",
      previousBalance: 5500,
      newBalance: 5000,
      date: "2026-09-24",
      memo: "現金確認",
    },
  ];
  data.settings.budgetCycle = { mode: "salary", startDay: 10 };
  return data;
}
describe("complete local backups", () => {
  it("round-trips account automation, receipts, transfers and salary rules without credentials", async () => {
    const data = automatedFixture();
    const backup = createBackup(data);
    expect(await parseBackup(backup)).toEqual(data);
    expect(
      await parseBackup(
        await encryptBackup(data, "safe independent backup password"),
        "safe independent backup password",
      ),
    ).toEqual(data);
    expect(backup).not.toContain("accessToken");
    expect(backup).not.toContain("providerCredentials");
    expect(() =>
      createBackup({
        ...data,
        providerCredentials: [{ id: "moneytree", value: "secret" }],
      } as AppData),
    ).toThrow();
  });
  it("rejects orphan account, receipt and external transaction references before any restore", () => {
    for (const mutate of [
      (data: AppData) => {
        data.transfers![0].toAccountId = "missing";
      },
      (data: AppData) => {
        data.externalTransactions![0].connectionId = "missing";
      },
      (data: AppData) => {
        data.expenses[0].receiptId = "missing";
      },
      (data: AppData) => {
        data.accounts![2].isSpendable = true;
      },
      (data: AppData) => {
        data.salaryRules![0].accountId = "missing";
      },
      (data: AppData) => {
        data.receipts![0].imageBase64 = "incomplete";
      },
      (data: AppData) => {
        data.externalTransactions!.push({
          ...data.externalTransactions![0],
          id: "duplicate",
        });
      },
    ]) {
      const data = automatedFixture();
      mutate(data);
      expect(() => createBackup(data)).toThrow();
    }
  });
  it("reads old 310,000-round encrypted backups while new exports use 600,000 rounds", async () => {
    const data = fixture();
    const envelope = JSON.parse(createBackup(data));
    envelope.schemaVersion = 1;
    envelope.metadata.schemaVersion = 1;
    const password = "fictional legacy backup password";
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: 310_000 },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode("pace-encrypted:v1"),
      },
      key,
      encoder.encode(JSON.stringify(envelope)),
    );
    const oldBackup = JSON.stringify({
      format: "pace-encrypted",
      version: 1,
      algorithm: "AES-GCM",
      kdf: "PBKDF2-SHA256",
      iterations: 310_000,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    });
    expect(await parseBackup(oldBackup, password)).toEqual(data);
    expect(JSON.parse(await encryptBackup(data, password)).iterations).toBe(
      600_000,
    );
  }, 15_000);
  it("round-trips all financial records and nullable settings with metadata", async () => {
    const data = fixture();
    data.settings.openingLiquidBalance = null;
    const json = createBackup(data);
    expect(JSON.parse(json)).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      metadata: { appVersion: APP_VERSION, schemaVersion: SCHEMA_VERSION },
    });
    expect(await parseBackup(json)).toEqual(data);
    expect(json).not.toContain("credentialId");
    expect(json).not.toContain("pinHash");
  });
  it("round-trips realistic linked records, historical events and a zero-yen budget", async () => {
    const data = fixture();
    data.cardPayments.push({
      ...stamp,
      id: "cp1",
      creditCardId: "c1",
      amount: 1000,
      date: "2026-09-24",
      memo: "初期請求分",
    });
    data.debts.push({
      ...stamp,
      id: "d1",
      lenderName: "親",
      title: "渡航費",
      originalAmount: 70000,
      openingBalance: 50000,
      currentBalance: 45000,
      startedAt: "2026-09-01",
      plannedMonthlyPayment: 5000,
      nextPaymentDate: "2026-10-10",
      note: "",
      isEstimated: true,
      cashReceived: false,
      status: "active",
    });
    data.repayments.push({
      id: "rp1",
      debtId: "d1",
      amount: 5000,
      date: "2026-09-10",
      memo: "",
    });
    data.savingsGoals.push({
      id: "s1",
      name: "旅行",
      targetAmount: 100000,
      openingAmount: 24000,
      currentAmount: 26000,
      targetDate: "2027-03-01",
      monthlyTarget: 5000,
      createdAt: now,
    });
    data.savingsContributions.push({
      id: "sc1",
      savingsGoalId: "s1",
      amount: 2000,
      date: "2026-09-24",
      memo: "",
    });
    data.recurringExpenses.push({
      id: "r1",
      name: "定期ランチ",
      amount: 1280,
      categoryId: "food",
      subcategoryId: "food-0",
      paymentMethod: "creditCard",
      creditCardId: "c1",
      frequency: "monthly",
      dueDay: 24,
      startDate: "2026-09-01",
      endDate: "",
      isActive: true,
      note: "",
    });
    data.recurringOccurrences.push({
      id: "r1:2026-09",
      recurringExpenseId: "r1",
      dueDate: "2026-09-24",
      status: "paid",
      expenseId: "e1",
    });
    data.expenses[0].isFixedCost = true;
    data.expenses[0].recurringOccurrenceId = "r1:2026-09";
    data.budgets.push({
      ...stamp,
      id: "b1",
      year: 2026,
      month: 9,
      totalBudget: 0,
      categoryBudgets: {},
    });
    data.merchantRules.push({
      normalizedMerchant: "サイゼリヤ",
      categoryId: "food",
      subcategoryId: "food-0",
      usageCount: 3,
      lastUsedAt: now,
    });
    data.favorites.push({
      id: "f1",
      name: "いつもの昼食",
      amount: 600,
      merchant: "学食",
      categoryId: "food",
      subcategoryId: "food-0",
      paymentMethod: "cash",
    });
    data.balanceAdjustments.push({
      id: "a1",
      previousBalance: 30000,
      newBalance: 29900,
      difference: -100,
      date: "2026-09-24",
      memo: "実残高に合わせた",
    });
    data.dailyCheckIns.push({
      date: "2026-09-23",
      noSpendingConfirmed: true,
      confirmedAt: now,
    });
    data.settings.salarySchedule = {
      payday: 5,
      expectedAmount: null,
      variableIncome: true,
    };
    expect(await parseBackup(createBackup(data))).toEqual(data);
    const broken = structuredClone(data);
    broken.recurringOccurrences[0].expenseId = "missing";
    expect(() => createBackup(broken)).toThrow();
    const brokenDebt = structuredClone(data);
    brokenDebt.repayments[0].debtId = "missing";
    expect(() => createBackup(brokenDebt)).toThrow();
    const brokenSavings = structuredClone(data);
    brokenSavings.savingsContributions[0].savingsGoalId = "missing";
    expect(() => createBackup(brokenSavings)).toThrow();
    // Legacy rows did not carry stamps; the current management UI adds them.
    data.repayments[0] = { ...data.repayments[0], ...stamp };
    data.savingsContributions[0] = { ...data.savingsContributions[0], ...stamp };
    expect(await parseBackup(createBackup(data))).toEqual(data);
  });
  it("rejects invalid and unsupported backups before restoration", async () => {
    await expect(parseBackup("{")).rejects.toThrow("読み込めません");
    const value = JSON.parse(createBackup(fixture())) as {
      schemaVersion: number;
    };
    value.schemaVersion = 999;
    await expect(parseBackup(JSON.stringify(value))).rejects.toThrow(
      "バージョン",
    );
  });
  it("normalizes imported civil dates to JST while preserving audit timestamps", async () => {
    const data = fixture();
    const boundary = "2026-09-30T16:00:00.000Z"; // October 1 in Japan.
    data.expenses[0].date = boundary;
    data.expenses[0].isFixedCost = true;
    data.expenses[0].recurringOccurrenceId = "r1:2026-10";
    data.incomes[0].date = boundary;
    data.cardPayments.push({
      ...stamp,
      id: "cp1",
      creditCardId: "c1",
      amount: 1000,
      date: boundary,
      memo: "",
    });
    data.debts.push({
      ...stamp,
      id: "d1",
      lenderName: "親",
      title: "渡航費",
      originalAmount: 70000,
      openingBalance: 50000,
      currentBalance: 45000,
      startedAt: boundary,
      plannedMonthlyPayment: 5000,
      nextPaymentDate: boundary,
      note: "",
      isEstimated: false,
      cashReceived: false,
      status: "active",
    });
    data.repayments.push({
      id: "rp1",
      debtId: "d1",
      amount: 5000,
      date: boundary,
      memo: "",
    });
    data.savingsGoals.push({
      id: "s1",
      name: "旅行",
      targetAmount: 100000,
      openingAmount: 24000,
      currentAmount: 26000,
      targetDate: boundary,
      monthlyTarget: 5000,
      createdAt: boundary,
    });
    data.savingsContributions.push({
      id: "sc1",
      savingsGoalId: "s1",
      amount: 2000,
      date: boundary,
      memo: "",
    });
    data.recurringExpenses.push({
      id: "r1",
      name: "定期ランチ",
      amount: 1280,
      categoryId: "food",
      subcategoryId: "food-0",
      paymentMethod: "creditCard",
      creditCardId: "c1",
      frequency: "monthly",
      dueDay: 1,
      startDate: boundary,
      endDate: boundary,
      isActive: true,
      note: "",
    });
    data.recurringOccurrences.push({
      id: "r1:2026-10",
      recurringExpenseId: "r1",
      dueDate: boundary,
      status: "paid",
      expenseId: "e1",
    });
    data.balanceAdjustments.push({
      id: "a1",
      previousBalance: 30000,
      newBalance: 29900,
      difference: -100,
      date: boundary,
      memo: "",
    });
    data.dailyCheckIns.push({
      date: boundary,
      noSpendingConfirmed: true,
      confirmedAt: boundary,
    });
    // Construct the envelope directly to prove normalization occurs during import.
    const envelope = {
      schemaVersion: 1,
      metadata: { appVersion: "1.0.0", schemaVersion: 1, exportedAt: now },
      data,
    };
    const imported = await parseBackup(JSON.stringify(envelope));
    for (const row of [
      ...imported.expenses,
      ...imported.incomes,
      ...imported.cardPayments,
      ...imported.repayments,
      ...imported.savingsContributions,
      ...imported.balanceAdjustments,
      ...imported.dailyCheckIns,
    ])
      expect(row.date).toBe("2026-10-01");
    expect(imported.debts[0]).toMatchObject({
      startedAt: "2026-10-01",
      nextPaymentDate: "2026-10-01",
      createdAt: now,
      updatedAt: now,
    });
    expect(imported.recurringExpenses[0]).toMatchObject({
      startDate: "2026-10-01",
      endDate: "2026-10-01",
    });
    expect(imported.recurringOccurrences[0]).toMatchObject({
      id: "r1:2026-10",
      dueDate: "2026-10-01",
    });
    expect(imported.savingsGoals[0]).toMatchObject({
      targetDate: "2026-10-01",
      createdAt: boundary,
    });
    expect(imported.dailyCheckIns[0].confirmedAt).toBe(boundary);
    expect(data.expenses[0].date).toBe(boundary);
    expect(await parseBackup(createBackup(imported))).toEqual(imported);

    envelope.data.recurringOccurrences[0].id = "r1:2026-09";
    envelope.data.expenses[0].recurringOccurrenceId = "r1:2026-09";
    await expect(parseBackup(JSON.stringify(envelope))).rejects.toThrow(
      "関連付け",
    );
  });
  it("rejects check-ins that collide only after Japan-date normalization", async () => {
    const data = fixture();
    data.dailyCheckIns = [
      {
        date: "2026-09-30T16:00:00Z",
        noSpendingConfirmed: true,
        confirmedAt: now,
      },
      { date: "2026-10-01", noSpendingConfirmed: true, confirmedAt: now },
    ];
    await expect(
      parseBackup(
        JSON.stringify({
          schemaVersion: 1,
          metadata: { appVersion: "1.0.0", schemaVersion: 1, exportedAt: now },
          data,
        }),
      ),
    ).rejects.toThrow("関連付け");
  });
  it("rejects injected settings, missing references, duplicate IDs and unsafe totals", async () => {
    const json = JSON.parse(createBackup(fixture())) as {
      data: AppData & { settings: AppData["settings"] & { endpoint?: string } };
    };
    json.data.settings.endpoint = "https://example.invalid/collect";
    await expect(parseBackup(JSON.stringify(json))).rejects.toThrow(
      "復元できません",
    );
    const missing = fixture();
    missing.cards = [];
    expect(() => createBackup(missing)).toThrow();
    const duplicate = fixture();
    duplicate.expenses.push({ ...duplicate.expenses[0] });
    expect(() => createBackup(duplicate)).toThrow();
    const overflow = fixture();
    overflow.expenses[0].amount = Number.MAX_SAFE_INTEGER;
    expect(() => createBackup(overflow)).toThrow();
  });
  it("rejects impossible dates and invalid amounts", () => {
    const invalid = fixture();
    invalid.expenses[0].date = "2026-02-30";
    expect(() => createBackup(invalid)).toThrow();
    invalid.expenses[0].date = "2026-09-24";
    invalid.expenses[0].amount = 0;
    expect(() => createBackup(invalid)).toThrow();
  });
  it("uses independent salts and IVs, authenticates content, and rejects wrong passwords", async () => {
    const data = fixture();
    const first = await encryptBackup(data, "correct horse battery");
    const second = await encryptBackup(data, "correct horse battery");
    expect(first).not.toEqual(second);
    expect(first).not.toContain("サイゼリヤ");
    expect(await parseBackup(first, "correct horse battery")).toEqual(data);
    await expect(parseBackup(first, "incorrect")).rejects.toThrow(
      "復号できません",
    );
    await expect(parseBackup(first)).rejects.toThrow("パスワード");
    const tampered = JSON.parse(first) as {
      ciphertext: string;
      iterations: number;
    };
    tampered.ciphertext =
      (tampered.ciphertext[0] === "A" ? "B" : "A") +
      tampered.ciphertext.slice(1);
    await expect(
      parseBackup(JSON.stringify(tampered), "correct horse battery"),
    ).rejects.toThrow("復号できません");
    tampered.iterations = 2_000_000_000;
    await expect(
      parseBackup(JSON.stringify(tampered), "correct horse battery"),
    ).rejects.toThrow("復号できません");
    await expect(encryptBackup(data, "123")).rejects.toThrow("8");
  }, 15_000);
});
describe("portable spreadsheet exports", () => {
  it("exports transfer and refunds independently from consumed expenses", async () => {
    const data = automatedFixture();
    const csv = buildCSV(data);
    expect(csv).toContain('"口座","取得元","取引種別","入力方法"');
    const lines = csv.split("\r\n");
    expect(lines.filter((line) => line.includes('"expense"'))).toHaveLength(1);
    expect(lines.find((line) => line.includes('"transfer"'))).toContain(
      '"振替"',
    );
    expect(lines.find((line) => line.includes('"refund"'))).toContain('"返金"');
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await (await buildExcel(data)).arrayBuffer());
    expect(workbook.getWorksheet("支出")?.rowCount).toBe(2);
    expect(workbook.getWorksheet("振替")?.getCell("D2").value).toBe(10000);
    expect(workbook.getWorksheet("返金・未分類")?.getCell("D2").value).toBe(
      280,
    );
    expect(workbook.getWorksheet("月別集計")?.getCell("C2").value).toBe(1000);
    expect(workbook.getWorksheet("月別集計")?.getCell("G2").value).toBe(280);
    expect(workbook.getWorksheet("カテゴリー別集計")?.getCell("C2").value).toBe(
      1000,
    );
    const summary = workbook.getWorksheet("概要")!;
    const rows: unknown[][] = [];
    summary.eachRow((row) => {
      rows.push(row.values as unknown[]);
    });
    expect(
      rows.find((row) => row.includes("生活支出（返金差引後）")),
    ).toContain(1000);
    // A refund remains a dated spending correction even after its original
    // expense was removed; category totals must still reconcile with the summary.
    data.externalTransactions![0].relatedExpenseId = undefined;
    expect(
      buildCSV(data)
        .split("\r\n")
        .find((line) => line.includes('"refund"')),
    ).toContain('"未分類"');
    const unlinked = new ExcelJS.Workbook();
    await unlinked.xlsx.load(await (await buildExcel(data)).arrayBuffer());
    expect(unlinked.getWorksheet("カテゴリー別集計")?.getCell("C2").value).toBe(
      1280,
    );
    expect(unlinked.getWorksheet("カテゴリー別集計")?.getCell("A3").value).toBe(
      "未分類",
    );
    expect(unlinked.getWorksheet("カテゴリー別集計")?.getCell("C3").value).toBe(
      -280,
    );
    expect(unlinked.getWorksheet("返金・未分類")?.getCell("E2").value).toBe(
      "未分類",
    );
  }, 30_000); // Cold ExcelJS import/XLSX decoding on Windows can exceed 5 seconds.
  it("writes BOM CSV with escaped text and protects spreadsheet formula injection", () => {
    const data = fixture();
    data.expenses[0].merchant = '=HYPERLINK("bad", "click")';
    data.expenses[0].memo = '一行目\n二行目,"メモ"';
    const csv = buildCSV(data);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"\'=HYPERLINK(""bad"", ""click"")"');
    expect(csv).toContain('"一行目\n二行目,""メモ"""');
    expect(csv).toContain('"カード"');
    expect(csv).toContain('"収入"');
  });
  it("produces a valid XLSX with financial detail sheets and typed numeric cells", async () => {
    const data = fixture();
    data.expenses[0].merchant = "=1+1";
    const blob = await buildExcel(data);
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await blob.arrayBuffer());
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "概要",
      "支出",
      "収入",
      "カード",
      "借金",
      "固定費",
      "月別集計",
      "カテゴリー別集計",
      "口座",
      "振替",
      "金融明細",
      "返金・未分類",
    ]);
    expect(workbook.getWorksheet("支出")?.getCell("D2").value).toBe(1280);
    expect(workbook.getWorksheet("支出")?.getCell("C2").value).toBe("=1+1");
    expect(workbook.getWorksheet("カード")?.getCell("H2").value).toBe(2280);
  }, 30_000);
});
