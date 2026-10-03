import { chromium } from "playwright";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const baseURL = (
  process.env.PACE_QA_BASE_URL || "http://localhost:5193/"
).replace(/\/$/, "");
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const errors = [],
  foreignRequests = [],
  checks = [],
  overflows = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("request", (request) => {
  const url = new URL(request.url());
  if (
    ["http:", "https:"].includes(url.protocol) &&
    url.origin !== new URL(baseURL).origin
  )
    foreignRequests.push(url.origin);
});
await fs.mkdir("test-results/screenshots", { recursive: true });
try {
  await page.goto(baseURL + "/");
  await page
    .getByLabel("パスフレーズ（12文字以上）")
    .fill("Pace fictional QA only 2026!");
  await page
    .getByLabel("もう一度入力", { exact: true })
    .fill("Pace fictional QA only 2026!");
  await page.getByRole("button", { name: "暗号化して始める" }).click();
  await page.locator(".onboarding").waitFor();
  const initial = await page.evaluate(async () => {
    const { db, updateSettings } = await import("/src/db/index.ts");
    const { todayJST, addDaysDate } = await import("/src/domain/dates.ts");
    const { computeFinance } = await import("/src/domain/finance.ts");
    const today = todayJST(),
      prior = addDaysDate(today, -1),
      at = `${prior}T00:00:00+09:00`;
    const stamp = (id) => ({ id, createdAt: at, updatedAt: at });
    await updateSettings({
      onboardingCompleted: true,
      openingLiquidBalance: 99999,
      financialAutomationEnabled: true,
      budgetCycle: { mode: "salary", startDay: 10 },
      salarySchedule: {
        payday: 10,
        expectedAmount: 20000,
        variableIncome: true,
      },
      colorMode: "light",
      helpDismissed: true,
      setupReviewed: ["balance", "salary", "cards", "debts", "recurring"],
      lockAfterSeconds: 900,
    });
    const account = (id, name, kind, balance, extra = {}) => ({
      ...stamp(id),
      name,
      kind,
      institutionName: kind === "BANK" ? name : "",
      currency: "JPY",
      snapshotBalance: balance,
      balanceAsOf: prior,
      snapshotRecordedAt: at,
      balanceSource: "manual",
      isSpendable: kind !== "CREDIT_CARD" && kind !== "SAVINGS",
      isActive: true,
      automationLevel: "manual",
      ...extra,
    });
    await db.accounts.bulkAdd([
      account("bank-a", "検証用の銀行A", "BANK", 50000),
      account("bank-b", "検証用の銀行B", "BANK", 0),
      account("cash", "検証用の現金", "CASH", 0),
      account("suica", "Suica（検証用）", "EWALLET", 0),
      account("wallet", "PayPay（検証用）", "EWALLET", 0),
      account("card", "検証用のカード", "CREDIT_CARD", 0, {
        creditCardId: "legacy-card",
      }),
    ]);
    await db.cards.add({
      ...stamp("legacy-card"),
      name: "検証用のカード",
      last4: "",
      closingDay: 31,
      paymentDay: 10,
      paymentMonthOffset: 1,
      openingOutstanding: 0,
      isActive: true,
    });
    return {
      today,
      prior,
      initialSafe: computeFinance(
        await import("/src/db/index.ts").then((m) => m.readAppData()),
        today,
      ).safeToSpend,
    };
  });
  assert.equal(initial.initialSafe, 50000);
  await page.locator(".hero-card").waitFor();
  checks.push(
    "Encrypted vault starts with fictional data and preserves account source of truth",
  );

  const accounting = await page.evaluate(async () => {
    const { db, readAppData, saveExpense } = await import("/src/db/index.ts");
    const { todayJST } = await import("/src/domain/dates.ts");
    const { computeFinance } = await import("/src/domain/finance.ts");
    const { saveTransfer } = await import("/src/domain/financialActions.ts");
    const { calculateAccountBalance } = await import("/src/domain/accounts.ts");
    const today = todayJST(),
      stamp = (id) => ({
        id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    const move = (id, from, to, amount) =>
      saveTransfer({
        ...stamp(id),
        fromAccountId: from,
        toAccountId: to,
        amount,
        date: today,
        memo: "架空の検証",
        status: "confirmed",
        fromBalanceEffect: "ledger",
        toBalanceEffect: "ledger",
      });
    const expense = (id, account, amount, merchant = "検証用の店舗") => ({
      ...stamp(id),
      sourceAccountId: account,
      amount,
      date: today,
      merchant,
      description: "",
      categoryId: "food",
      subcategoryId: "food-0",
      paymentMethod: account === "cash" ? "cash" : "other",
      memo: "架空の検証",
      isFixedCost: false,
      balanceEffect: "ledger",
    });
    await db.incomes.add({
      ...stamp("actual-salary"),
      sourceAccountId: "bank-a",
      amount: 19842,
      date: today,
      source: "検証用の給与",
      memo: "架空の実入金",
      type: "salary",
      balanceEffect: "ledger",
    });
    await move("bank-move", "bank-a", "bank-b", 19000);
    const afterSalary = computeFinance(await readAppData(), today);
    await move("atm", "bank-a", "cash", 10000);
    const afterATM = computeFinance(await readAppData(), today);
    await saveExpense(expense("cash-lunch", "cash", 850));
    const cashAfter = calculateAccountBalance(
      await readAppData(),
      "cash",
      today,
    );
    await move("card-charge", "card", "suica", 3000);
    const afterCardCharge = computeFinance(await readAppData(), today);
    await saveExpense(expense("suica-store", "suica", 500));
    await move("paypay-charge", "bank-a", "wallet", 5000);
    await saveExpense(expense("wallet-store", "wallet", 800));
    const beforeSettlement = computeFinance(await readAppData(), today);
    await move("card-settlement", "bank-b", "card", 3000);
    const afterSettlement = computeFinance(await readAppData(), today);
    await db.debts.add({
      ...stamp("family-debt"),
      lenderName: "検証用の家族",
      title: "検証用の借入",
      originalAmount: 70000,
      openingBalance: 70000,
      currentBalance: 70000,
      startedAt: today,
      plannedMonthlyPayment: 5000,
      nextPaymentDate: today,
      note: "架空の検証",
      isEstimated: false,
      cashReceived: false,
      status: "active",
      reserveForCurrentBudget: false,
    });
    const withDebtOff = computeFinance(await readAppData(), today);
    await db.debts.update("family-debt", { reserveForCurrentBudget: true });
    const withDebtOn = computeFinance(await readAppData(), today);
    await db.debts.update("family-debt", { reserveForCurrentBudget: false });
    return {
      afterSalary,
      afterATM,
      cashAfter,
      afterCardCharge,
      beforeSettlement,
      afterSettlement,
      withDebtOff,
      withDebtOn,
    };
  });
  assert.equal(accounting.afterSalary.liquidBalance, 69842);
  assert.equal(accounting.afterSalary.periodIncomeTotal, 19842);
  assert.equal(accounting.afterSalary.periodExpenseTotal, 0);
  assert.equal(accounting.afterATM.liquidBalance, 69842);
  assert.equal(accounting.afterATM.periodExpenseTotal, 0);
  assert.equal(accounting.cashAfter, 9150);
  assert.equal(accounting.afterCardCharge.cardOutstanding, 3000);
  assert.equal(accounting.afterCardCharge.safeToSpend, 68992);
  assert.equal(accounting.beforeSettlement.safeToSpend, 67692);
  assert.equal(
    accounting.afterSettlement.safeToSpend,
    accounting.beforeSettlement.safeToSpend,
  );
  assert.equal(accounting.afterSettlement.cardOutstanding, 0);
  assert.equal(accounting.afterSettlement.periodExpenseTotal, 2150);
  assert.equal(accounting.withDebtOff.debtReserve, 0);
  assert.equal(accounting.withDebtOn.debtReserve, 5000);
  checks.push(
    "Actual salary, bank transfer, ATM, cash, Suica, PayPay, card top-up and settlement avoid double counting",
  );
  checks.push(
    "Forecast salary is not money; deferred family debt becomes reserved only after repayment is enabled",
  );

  const importCheck = await page.evaluate(async () => {
    const { db, readAppData } = await import("/src/db/index.ts");
    const { planFinancialImport } =
      await import("/src/domain/financialImport.ts");
    const { todayJST } = await import("/src/domain/dates.ts");
    const today = todayJST(),
      now = new Date().toISOString();
    await db.financialConnections.add({
      id: "fictional-link",
      createdAt: now,
      updatedAt: now,
      providerId: "mock",
      status: "disconnected",
      institutionIds: [],
      consentedAt: now,
    });
    await db.accounts.update("card", {
      balanceSource: "provider",
      snapshotBalance: 3000,
      balanceAsOf: today,
      snapshotRecordedAt: now,
      providerId: "mock",
      connectionId: "fictional-link",
      externalAccountId: "test-remote-card",
    });
    const apply = async (rows) => {
      const app = await readAppData(),
        account = app.accounts.find((row) => row.id === "card");
      const plan = planFinancialImport(
        app,
        account,
        rows,
        "fictional-link",
        new Date().toISOString(),
      );
      await db.transaction(
        "rw",
        db.externalTransactions,
        db.expenses,
        db.incomes,
        db.recurringOccurrences,
        async () => {
          await db.externalTransactions.bulkPut(plan.external);
          await db.expenses.bulkPut(plan.expenses);
          await db.incomes.bulkPut(plan.incomes);
          await db.recurringOccurrences.bulkPut(plan.occurrences);
        },
      );
    };
    const pending = {
      externalTransactionId: "fictional-pending",
      externalAccountId: "test-remote-card",
      externalUpdatedAt: now,
      date: today,
      amount: -1000,
      description: "架空の書店",
      currency: "JPY",
      pendingStatus: "pending",
    };
    await apply([pending]);
    await apply([pending]);
    const afterTwice = (await db.expenses.toArray()).filter(
      (row) => row.externalTransactionId === pending.externalTransactionId,
    );
    await apply([{ ...pending, pendingStatus: "posted", amount: -1120 }]);
    const afterPosted = (await db.expenses.toArray()).filter(
      (row) => row.externalTransactionId === pending.externalTransactionId,
    );
    await db.recurringExpenses.add({
      id: "test-service",
      name: "架空の月額サービス",
      amount: 1000,
      categoryId: "fixed",
      subcategoryId: "fixed-1",
      paymentMethod: "creditCard",
      creditCardId: "legacy-card",
      sourceAccountId: "card",
      frequency: "monthly",
      dueDay: Number(today.slice(8)),
      startDate: today,
      isActive: true,
      note: "架空の検証",
    });
    await apply([
      {
        ...pending,
        externalTransactionId: "fictional-service",
        description: "架空の月額サービス",
        amount: -1000,
        pendingStatus: "posted",
      },
    ]);
    const service = (await db.expenses.toArray()).find(
      (row) => row.externalTransactionId === "fictional-service",
    );
    const manual = {
      id: "fictional-manual-duplicate",
      createdAt: now,
      updatedAt: now,
      amount: 500,
      date: today,
      merchant: "架空食堂",
      description: "",
      categoryId: "food",
      subcategoryId: "food-0",
      paymentMethod: "creditCard",
      creditCardId: "legacy-card",
      sourceAccountId: "card",
      memo: "分類・メモを保持する検証",
      isFixedCost: false,
      balanceEffect: "ledger",
    };
    await db.expenses.add(manual);
    await apply([
      {
        ...pending,
        externalTransactionId: "fictional-duplicate",
        description: manual.merchant,
        amount: -500,
        pendingStatus: "posted",
      },
    ]);
    const duplicateRows = (await db.expenses.toArray()).filter(
      (row) => row.merchant === manual.merchant,
    );
    const candidate = (await db.externalTransactions.toArray()).find(
      (row) => row.externalTransactionId === "fictional-duplicate",
    );
    return {
      pendingCount: afterTwice.length,
      postedCount: afterPosted.length,
      postedAmount: afterPosted[0]?.amount,
      serviceFixed: service?.isFixedCost,
      occurrence: service?.recurringOccurrenceId,
      duplicateCount: duplicateRows.length,
      candidateKind: candidate?.kind,
    };
  });
  assert.equal(importCheck.pendingCount, 1);
  assert.equal(importCheck.postedCount, 1);
  assert.equal(importCheck.postedAmount, 1120);
  assert.equal(importCheck.serviceFixed, true);
  assert.ok(importCheck.occurrence);
  assert.equal(importCheck.duplicateCount, 1);
  assert.equal(importCheck.candidateKind, "unclassified");
  checks.push(
    "Repeated import and pending-to-posted update keep one expense; recurring costs release their reserve",
  );

  await page.evaluate(() => {
    location.hash = "#/money";
  });
  await page.getByRole("button", { name: /架空食堂/ }).click();
  await page.getByRole("button", { name: "1件に統合する" }).click();
  await page.waitForFunction(async () => {
    const { db } = await import("/src/db/index.ts");
    return (
      (await db.expenses.get("fictional-manual-duplicate"))
        ?.externalTransactionId === "fictional-duplicate"
    );
  });
  const merged = await page.evaluate(async () => {
    const { db } = await import("/src/db/index.ts");
    return {
      count: (await db.expenses.toArray()).filter(
        (row) => row.merchant === "架空食堂",
      ).length,
      memo: (await db.expenses.get("fictional-manual-duplicate"))?.memo,
    };
  });
  assert.equal(merged.count, 1);
  assert.equal(merged.memo, "分類・メモを保持する検証");
  checks.push(
    "A manual duplicate remains until the user explicitly merges it; category and memo survive",
  );

  await page.evaluate(() => {
    location.hash = "#/";
  });
  await page.getByRole("button", { name: "支出を記録", exact: true }).click();
  await page.getByRole("button", { name: "レシートから入力" }).click();
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 500;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 500, 300);
    ctx.fillStyle = "black";
    ctx.font = "32px sans-serif";
    ctx.fillText("Fictional receipt", 35, 70);
    ctx.fillText("Total 850 JPY", 35, 150);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page
    .locator('.receipt-capture input[type="file"]')
    .last()
    .setInputFiles({
      name: "fictional-receipt.png",
      mimeType: "image/png",
      buffer: Buffer.from(image, "base64"),
    });
  await page.getByRole("button", { name: "手入力する", exact: true }).click();
  await page.getByLabel("お店", { exact: true }).fill("架空レシート食堂");
  await page.getByLabel("合計（円）", { exact: true }).fill("850");
  await page.locator('.receipt-capture input[type="date"]').fill(initial.today);
  await page.locator(".receipt-capture select").selectOption("cash");
  assert.equal(
    await page.getByLabel("レシート画像も端末内に保存").isChecked(),
    false,
  );
  await page.getByRole("button", { name: "入力に反映" }).click();
  await page.getByRole("combobox", { name: /^支払元/ }).selectOption("cash");
  await page.getByRole("button", { name: "記録する", exact: true }).click();
  await page.waitForFunction(async () => {
    const { db } = await import("/src/db/index.ts");
    return (await db.expenses.toArray()).some(
      (row) => row.merchant === "架空レシート食堂",
    );
  });
  const receiptCheck = await page.evaluate(async () => {
    const { db } = await import("/src/db/index.ts");
    const record = (await db.expenses.toArray()).find(
      (row) => row.merchant === "架空レシート食堂",
    );
    return {
      amount: record?.amount,
      sourceAccountId: record?.sourceAccountId,
      savedImage: !!record?.receiptId,
      imageCount: await db.receipts.count(),
    };
  });
  assert.deepEqual(receiptCheck, {
    amount: 850,
    sourceAccountId: "cash",
    savedImage: false,
    imageCount: 0,
  });
  checks.push(
    "Receipt image review fallback creates one cash expense and stores no image by default",
  );

  const closeNotice = page.getByRole("button", {
    name: "通知を閉じる",
    exact: true,
  });
  if (await closeNotice.isVisible()) await closeNotice.click();
  await page.evaluate(() => {
    location.hash = "#/manage/cards";
  });
  await page
    .getByRole("button", { name: "カードを追加", exact: true })
    .first()
    .click();
  assert.equal(
    await page.getByLabel("締め日（31＝月末）", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await page.getByLabel("支払日", { exact: true }).inputValue(),
    "10",
  );
  assert.equal(
    await page
      .getByLabel("締め日（31＝月末）", { exact: true })
      .evaluate((input) => input.validity.valueMissing),
    true,
  );
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  checks.push(
    "A new card suggests payment day 10 and requires its real closing day",
  );

  await page.evaluate(async () => {
    const { db } = await import("/src/db/index.ts");
    const now = new Date().toISOString();
    await db.cards.add({
      id: "guard-card",
      name: "参照整合の検証カード",
      last4: "",
      closingDay: 20,
      paymentDay: 10,
      paymentMonthOffset: 1,
      openingOutstanding: 0,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    const source = await db.accounts.get("card");
    await db.accounts.add({
      ...source,
      id: "guard-account",
      name: "参照整合の検証口座",
      creditCardId: "guard-card",
      snapshotBalance: 0,
      balanceSource: "manual",
      isActive: false,
      providerId: undefined,
      connectionId: undefined,
      externalAccountId: undefined,
    });
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator(".entity-card")
    .filter({
      has: page.getByRole("heading", {
        name: "参照整合の検証カード",
        exact: true,
      }),
    })
    .getByRole("button", { name: "削除", exact: true })
    .click();
  await page
    .locator(".toast")
    .filter({ hasText: "お金の置き場所と関連付けたカードは削除できません" })
    .waitFor();
  assert.equal(
    await page.evaluate(async () => {
      const { db } = await import("/src/db/index.ts");
      return !!(await db.cards.get("guard-card"));
    }),
    true,
  );
  await page.getByRole("button", { name: "通知を閉じる", exact: true }).click();
  await page.evaluate(async () => {
    const { db } = await import("/src/db/index.ts");
    await db.transaction("rw", db.accounts, db.cards, async () => {
      await db.accounts.delete("guard-account");
      await db.cards.delete("guard-card");
    });
  });
  checks.push(
    "An archived account still protects its linked card against deletion and broken backup references",
  );

  await page.evaluate(() => {
    location.hash = "#/";
  });
  const beforePreview = await page.evaluate(async () => {
    const { readAppData } = await import("/src/db/index.ts");
    return JSON.stringify(await readAppData());
  });
  await page.getByRole("button", { name: /これ、買ったら？/ }).click();
  await page.getByLabel("使う予定の金額", { exact: true }).fill("3000");
  await page.locator(".preview-change strong").waitFor();
  const afterPreview = await page.evaluate(async () => {
    const { readAppData } = await import("/src/db/index.ts");
    return JSON.stringify(await readAppData());
  });
  assert.equal(afterPreview, beforePreview);
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  checks.push(
    "Purchase preview changes only the displayed result and never books a transaction",
  );

  await page.evaluate(() => {
    location.hash = "#/analytics";
  });
  const cycle = await page.evaluate(async () => {
    const { getBudgetCycle } = await import("/src/domain/budgetCycle.ts");
    const { todayJST } = await import("/src/domain/dates.ts");
    return getBudgetCycle(todayJST(), { mode: "salary", startDay: 10 });
  });
  assert.equal(
    await page.getByLabel("表示月", { exact: true }).inputValue(),
    cycle.start.slice(0, 7),
  );
  assert.ok(
    (await page.locator(".analytics-range-label").textContent()).includes(
      cycle.start.replaceAll("-", "/"),
    ),
  );
  await page.getByRole("button", { name: "カレンダー月", exact: true }).click();
  assert.equal(
    await page.getByLabel("表示月", { exact: true }).inputValue(),
    initial.today.slice(0, 7),
  );
  await page.getByRole("button", { name: "給与サイクル", exact: true }).click();
  assert.equal(
    await page.getByLabel("表示月", { exact: true }).inputValue(),
    cycle.start.slice(0, 7),
  );
  checks.push(
    "Analysis toggles between the true calendar month and the current salary cycle",
  );

  for (const mode of ["light", "dark"]) {
    await page.evaluate(async (colorMode) => {
      const { updateSettings } = await import("/src/db/index.ts");
      await updateSettings({ colorMode });
    }, mode);
    for (const width of [375, 390, 430, 768]) {
      await page.setViewportSize({ width, height: 844 });
      for (const route of [
        "/",
        "/money",
        "/financial",
        "/history",
        "/analytics",
        "/timeline",
        "/manage/debts",
        "/manage/incomes",
      ]) {
        await page.evaluate((path) => {
          location.hash = "#" + path;
        }, route);
        await page.locator(".page").first().waitFor();
        await page.waitForTimeout(120);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 2,
        );
        if (overflow) overflows.push({ route, width, mode });
        if (
          width === 390 &&
          ["/", "/money", "/analytics", "/financial"].includes(route)
        )
          await page.screenshot({
            path: `test-results/screenshots/financial-${route === "/" ? "home" : route.slice(1)}-${mode}-390.png`,
            fullPage: true,
          });
      }
    }
  }
  assert.deepEqual(overflows, []);
  checks.push(
    "Home, money, sync, analysis, history, timeline, debt and income fit 375/390/430/768px in light and dark modes",
  );

  const privacy = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("pace");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stores = Array.from(database.objectStoreNames);
    const raw = await Promise.all(
      stores.map(
        (name) =>
          new Promise((resolve, reject) => {
            const request = database
              .transaction(name, "readonly")
              .objectStore(name)
              .getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          }),
      ),
    );
    database.close();
    const wire = JSON.stringify(raw),
      local = JSON.stringify({ ...localStorage }),
      session = JSON.stringify({ ...sessionStorage });
    const markers = [
      "架空食堂",
      "架空レシート食堂",
      "検証用の銀行A",
      "actual-salary",
      "sourceAccountId",
      "snapshotBalance",
      "Pace fictional QA only 2026!",
    ];
    const leaks = markers.filter(
      (marker) =>
        wire.includes(marker) ||
        local.includes(marker) ||
        session.includes(marker),
    );
    return {
      leaks,
      vaultMetadataPresent: stores.includes("vaultMeta"),
      externalTransactionStorePresent: stores.includes("externalTransactions"),
    };
  });
  assert.deepEqual(privacy.leaks, []);
  assert.equal(privacy.vaultMetadataPresent, true);
  assert.equal(privacy.externalTransactionStorePresent, true);
  assert.deepEqual(foreignRequests, []);
  assert.deepEqual(errors, []);
  checks.push(
    "Account, financial transaction, receipt and salary data are absent from plaintext IndexedDB/localStorage/sessionStorage; no external requests",
  );
  await fs.writeFile(
    "test-results/financial-results.json",
    JSON.stringify(
      {
        checks,
        errors,
        overflows,
        foreignRequests,
        privacy,
        screenshots: "screenshots/financial-*",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: checks.length,
      errors: errors.length,
      overflows: overflows.length,
      externalRequests: foreignRequests.length,
    }),
  );
} finally {
  await browser.close();
}
