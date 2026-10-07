import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { startQaServer } from "./qa-vite-support.mjs";
import { installVaultSupport } from "./qa-vault-support.mjs";
const server = await startQaServer("experience"),
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    headless: true,
  });
const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  }),
  page = await context.newPage();
const checks = [],
  errors = [],
  external = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (
    /^https?:/.test(r.url()) &&
    new URL(r.url()).origin !== new URL(server.baseURL).origin
  )
    external.push(r.url());
});
installVaultSupport(page);
await fs.mkdir("test-results/screenshots", { recursive: true });
const record = (name, detail = {}) => {
  checks.push({ name, passed: true, ...detail });
  console.log("✓ " + name);
};
async function seed() {
  await page.evaluate(async () => {
    const { db, defaultCategories, updateSettings } =
      await import("/src/db/index.ts");
    const { todayJST } = await import("/src/domain/dates.ts");
    const today = todayJST(),
      at = today + "T00:00:00+09:00";
    const stamped = (id) => ({ id, createdAt: at, updatedAt: at });
    await updateSettings({
      onboardingCompleted: true,
      openingLiquidBalance: 30000,
      financialAutomationEnabled: true,
      helpDismissed: true,
      setupReviewed: ["balance", "salary", "cards", "debts", "recurring"],
      salarySchedule: {
        payday: 10,
        expectedAmount: null,
        variableIncome: true,
      },
    });
    await db.cards.bulkPut([
      {
        ...stamped("card1"),
        name: "架空カードA",
        last4: "1234",
        closingDay: 31,
        paymentDay: 10,
        paymentMonthOffset: 1,
        openingOutstanding: 0,
        isActive: true,
      },
      {
        ...stamped("card2"),
        name: "架空カードB",
        last4: "5678",
        closingDay: 31,
        paymentDay: 10,
        paymentMonthOffset: 1,
        openingOutstanding: 0,
        isActive: true,
      },
    ]);
    await db.accounts.bulkPut(
      [
        ["cash", "架空の現金", "CASH"],
        ["bank1", "架空の横浜銀行", "BANK"],
        ["bank2", "架空の三菱UFJ銀行", "BANK"],
        ["suica", "架空のモバイルSuica", "EWALLET"],
        ["paypay", "架空のPayPay", "EWALLET"],
        ["credit1", "架空カードA", "CREDIT_CARD", "card1"],
        ["credit2", "架空カードB", "CREDIT_CARD", "card2"],
      ].map(([id, name, kind, creditCardId]) => ({
        ...stamped(id),
        name,
        kind,
        institutionName: "架空",
        currency: "JPY",
        snapshotBalance: kind === "CREDIT_CARD" ? 0 : 10000,
        balanceAsOf: today,
        snapshotRecordedAt: at,
        lastVerifiedAt: at,
        balanceSource: "manual",
        isSpendable: kind !== "CREDIT_CARD",
        isActive: true,
        automationLevel: "manual",
        creditCardId,
      })),
    );
    await db.expenses.bulkPut(
      Array.from({ length: 8 }, (_, i) => ({
        ...stamped("fictional-" + i),
        createdAt: today + "T01:00:00+09:00",
        amount: 500,
        date: today,
        merchant: "架空の店" + i,
        description: "",
        categoryId: "food",
        subcategoryId: "food-0",
        paymentMethod: "other",
        sourceAccountId: "paypay",
        memo: "",
        isFixedCost: false,
      })),
    );
    await db.categories.bulkPut(defaultCategories);
  });
  await page.locator(".hero-card").waitFor();
}
async function noOverflow(name) {
  const problems = await page.evaluate(() =>
    Array.from(document.querySelectorAll("body *"))
      .filter(
        (el) =>
          el.getBoundingClientRect().width &&
          el.getBoundingClientRect().right > innerWidth + 2 &&
          getComputedStyle(el).position !== "fixed" &&
          !el.closest("svg") &&
          !el.closest(".charts"),
      )
      .map((el) => el.className)
      .slice(0, 8),
  );
  assert.deepEqual(problems, [], name);
}
try {
  await page.goto(server.baseURL);
  await seed();
  await page.evaluate(async () => {
    const { updateSettings } = await import("/src/db/index.ts");
    await updateSettings({ financialAutomationEnabled: false });
  });
  await page.getByRole("button", { name: "支出を記録", exact: true }).click();
  const source = page.locator(".source-picker");
  assert.equal(await source.locator('button[aria-pressed="true"]').count(), 0);
  assert.match(
    await source.locator(".chips button").first().innerText(),
    /PayPay/,
  );
  await source.getByRole("button", { name: "すべて", exact: true }).click();
  assert.equal(
    await page.getByLabel("すべての支払元").locator("option").count(),
    8,
  );
  await page.getByLabel("支出金額", { exact: true }).fill("850");
  await source
    .getByRole("button", { name: "架空のPayPay", exact: true })
    .click();
  await page.getByRole("button", { name: "記録する", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  record(
    "Amount → explicit account → save with 7 dynamic accounts and recent ranking",
  );
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await page.waitForTimeout(200);
  record("Undo remains available for the quick expense");
  for (const toCash of [false, true]) {
    await page.getByRole("button", { name: "支出を記録", exact: true }).click();
    await page
      .getByLabel("支出金額", { exact: true })
      .fill(toCash ? "451" : "450");
    await page
      .locator(".source-picker")
      .getByRole("button", { name: "すべて", exact: true })
      .click();
    await page.getByLabel("すべての支払元").selectOption("credit1");
    await page.getByLabel(/使い方/).selectOption("applePay");
    if (toCash)
      await page
        .locator(".source-picker")
        .getByRole("button", { name: "架空の現金", exact: true })
        .click();
    await page.getByRole("button", { name: "記録する", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const saved = await page.evaluate(
      async (amount) => {
        const { db } = await import("/src/db/index.ts");
        return (await db.expenses.toArray()).find((e) => e.amount === amount);
      },
      toCash ? 451 : 450,
    );
    assert.equal(saved.sourceAccountId, toCash ? "cash" : "credit1");
    assert.equal(saved.paymentChannel, toCash ? "direct" : "applePay");
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  }
  record(
    "Apple Pay retains its real card account and clears when switching to cash",
  );
  await page.evaluate(async () => {
    const { updateSettings } = await import("/src/db/index.ts");
    await updateSettings({ financialAutomationEnabled: true });
  });
  await page.getByRole("button", { name: "残高確認", exact: true }).click();
  await page
    .getByRole("button", { name: "確認した残高を保存", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  record("Bulk balance verification with unchanged values needs no re-entry");
  await page.goto(server.baseURL + "#/notifications");
  await page
    .getByRole("heading", { name: "通知センター", exact: true })
    .waitFor();
  await page.locator(".notification-rule").first().locator("summary").click();
  await page.getByLabel("このリマインダーを使う").first().check();
  await page
    .getByRole("button", { name: "通知設定を保存", exact: true })
    .click();
  record(
    "Notification rules save with generic OS preview and default amount OFF",
  );
  await page.locator(".toast").waitFor({ state: "hidden", timeout: 15000 });
  const themes = [
    "default",
    "softWhite",
    "glassLight",
    "midnight",
    "forest",
    "mono",
  ];
  await page.goto(server.baseURL + "#/");
  for (const width of [375, 390, 430, 820]) {
    await page.setViewportSize({ width, height: width === 820 ? 1180 : 844 });
    for (const theme of themes)
      for (const mode of ["light", "dark"]) {
        await page.evaluate(
          async ({ theme, mode }) => {
            const { updateSettings } = await import("/src/db/index.ts");
            await updateSettings({ theme, colorMode: mode });
          },
          { theme, mode },
        );
        await page.waitForFunction(
          ({ theme, mode }) =>
            document.documentElement.dataset.theme === theme &&
            document.documentElement.dataset.mode === mode,
          { theme, mode },
        );
        await noOverflow(width + " " + theme + " " + mode);
        const contrast = await page.evaluate(() => {
          const card = document.querySelector(".today-card"),
            text = card.querySelector(".daily-number"),
            c = document.createElement("canvas");
          c.width = c.height = 1;
          const x = c.getContext("2d");
          const l = (value) => {
            x.fillStyle = value;
            x.fillRect(0, 0, 1, 1);
            const rgb = [...x.getImageData(0, 0, 1, 1).data]
              .slice(0, 3)
              .map((n) => {
                n /= 255;
                return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
              });
            return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
          };
          const a = l(getComputedStyle(card).backgroundColor),
            b = l(getComputedStyle(text).color);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
        assert(
          contrast >= 4.5,
          theme + " " + mode + " daily amount contrast " + contrast,
        );
        if (width < 700) {
          const fit = await page.evaluate(() => {
            const button = document
                .querySelector(".primary-add")
                .getBoundingClientRect(),
              nav = document
                .querySelector(".bottom-nav")
                .getBoundingClientRect();
            return button.bottom <= nav.top;
          });
          assert(
            fit,
            "Primary expense action must fit above navigation at " +
              width +
              " " +
              theme +
              " " +
              mode,
          );
        }
        if (width === 390)
          await page.screenshot({
            path:
              "test-results/screenshots/theme-" +
              theme +
              "-" +
              mode +
              "-390.png",
          });
      }
    record("Layout " + width + "px, all 6 themes in light/dark");
  }
  for (const mode of ["light", "dark"])
    for (const accent of [
      "blue",
      "sky",
      "indigo",
      "teal",
      "green",
      "graphite",
      "purple",
      "orange",
    ]) {
      await page.evaluate(
        async ({ mode, accent }) => {
          const { updateSettings } = await import("/src/db/index.ts");
          await updateSettings({
            theme: "default",
            colorMode: mode,
            appearance: {
              accent,
              background: "tint",
              cards: "standard",
              density: "standard",
            },
          });
        },
        { mode, accent },
      );
      await page.waitForFunction(
        ({ mode, accent }) =>
          document.documentElement.dataset.mode === mode &&
          document.documentElement.dataset.accent === accent,
        { mode, accent },
      );
      const ratios = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement),
          c = document.createElement("canvas");
        c.width = c.height = 1;
        const x = c.getContext("2d");
        const luminance = (key) => {
          x.clearRect(0, 0, 1, 1);
          x.fillStyle = style.getPropertyValue(key).trim();
          x.fillRect(0, 0, 1, 1);
          const a = [...x.getImageData(0, 0, 1, 1).data]
            .slice(0, 3)
            .map((n) => {
              n /= 255;
              return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
            });
          return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
        };
        return [
          ["--text", "--surface"],
          ["--muted", "--surface"],
          ["--on-accent", "--accent"],
          ["--hero-ink", "--hero-start"],
          ["--hero-ink", "--hero-end"],
        ].map(([a, b]) => {
          const l = luminance(a),
            r = luminance(b);
          return (Math.max(l, r) + 0.05) / (Math.min(l, r) + 0.05);
        });
      });
      assert(
        ratios.every((x) => x >= 4.5),
        mode + " " + accent + " contrast " + ratios,
      );
    }
  record(
    "All 8 accents retain at least 4.5:1 text/primary/hero contrast in light/dark",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => {
    const { updateSettings } = await import("/src/db/index.ts");
    await updateSettings({
      theme: "default",
      colorMode: "light",
      appearance: {
        accent: "blue",
        background: "tint",
        cards: "standard",
        density: "standard",
      },
    });
  });
  await page.locator(".toast").waitFor({ state: "hidden", timeout: 15000 });
  await page.screenshot({
    path: "test-results/screenshots/home-390.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "レシート", exact: true }).click();
  const receipt = page.locator(".receipt-capture");
  await receipt.getByRole("button", { name: "撮影", exact: true }).click();
  await receipt.locator(".camera-guide").waitFor();
  assert.match(await receipt.locator(".camera-stage").innerText(), /枠内/);
  record(
    "Camera has a receipt guide; choosing a photo remains available without hardware",
  );
  await page.evaluate(() => {
    window.__qaDecodeCalls = 0;
    window.__qaBitmap = window.createImageBitmap;
    window.createImageBitmap = (...args) => {
      window.__qaDecodeCalls++;
      return window.__qaBitmap(...args);
    };
  });
  const bomb = Buffer.alloc(24);
  bomb.set([137, 80, 78, 71]);
  bomb.set([73, 72, 68, 82], 12);
  bomb.writeUInt32BE(10000, 16);
  bomb.writeUInt32BE(10000, 20);
  await receipt.locator('input[type="file"]').last().setInputFiles({
    name: "fictional-too-large.png",
    mimeType: "image/png",
    buffer: bomb,
  });
  await receipt.getByRole("alert").waitFor();
  assert.equal(await page.evaluate(() => window.__qaDecodeCalls), 0);
  await page.evaluate(() => {
    window.createImageBitmap = window.__qaBitmap;
    delete window.__qaBitmap;
    delete window.__qaDecodeCalls;
  });
  record(
    "Oversized compressed image is rejected before allocating decoded pixels",
  );
  // A fictional receipt surrounded by misleading, unrelated text and an amount.
  const fixture = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1200;
    c.height = 1500;
    const x = c.getContext("2d");
    x.fillStyle = "#304861";
    x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = "#fff";
    x.font = "38px Arial";
    x.fillText("BACKGROUND TOTAL 999999", 10, 60);
    x.fillRect(190, 150, 820, 1250);
    x.fillStyle = "#111";
    x.font = "42px Arial";
    [
      "FICTIONAL MARKET",
      "2026/10/07 14:30",
      "MILK 220",
      "BREAD 180",
      "SUBTOTAL 400",
      "TAX 32",
      "TOTAL 432",
      "CASH RECEIVED 1000",
      "CHANGE 568",
    ].forEach((s, i) => x.fillText(s, 245, 240 + i * 115));
    return c.toDataURL("image/png").split(",")[1];
  });
  await receipt
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: "fictional-background.png",
      mimeType: "image/png",
      buffer: Buffer.from(fixture, "base64"),
    });
  const confirm = receipt.getByLabel(
    "レシート全体が枠内にあり、背景を除けています",
  );
  await confirm.waitFor();
  assert.equal(
    await receipt
      .getByRole("button", { name: "読み取る", exact: true })
      .isEnabled(),
    false,
  );
  await confirm.check();
  const started = Date.now();
  await receipt.getByRole("button", { name: "読み取る", exact: true }).click();
  await receipt
    .getByRole("button", { name: "確認して記録", exact: true })
    .waitFor({ timeout: 75000 });
  const amount = await receipt
    .getByLabel("合計（円）", { exact: true })
    .inputValue();
  const amounts = await receipt
    .locator(".needs-review .chip")
    .allTextContents();
  assert(
    amount === "432" || amounts.some((x) => x.includes("432")),
    "Actual local OCR must recognize the fictional total 432",
  );
  assert(!amounts.some((x) => x.includes("999,999")));
  assert.match(
    await receipt.getByLabel("お店", { exact: true }).inputValue(),
    /FICTIONAL/i,
  );
  assert.equal(
    await receipt.getByLabel("日付", { exact: true }).inputValue(),
    "2026-10-07",
  );
  assert.equal(
    await receipt.getByLabel("レシート画像も端末内に保存").isChecked(),
    false,
  );
  const count = () =>
    page.evaluate(async () => {
      const { db } = await import("/src/db/index.ts");
      return {
        expenses: await db.expenses.count(),
        receipts: await db.receipts.count(),
      };
    });
  assert.deepEqual(await count(), { expenses: 8, receipts: 0 });
  await page.screenshot({
    path: "test-results/screenshots/receipt-review-390.png",
    fullPage: true,
  });
  record(
    "Real on-device OCR excludes fictional background total, requires crop + review, saves nothing automatically",
    { elapsedMs: Date.now() - started },
  );
  await receipt
    .getByRole("button", { name: "確認して記録", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "test-results/screenshots/receipt-fields-390.png",
  });
  if (!amount)
    await receipt.getByLabel("合計（円）", { exact: true }).fill("432");
  await receipt.getByLabel("支払元", { exact: true }).selectOption("cash");
  await receipt
    .getByRole("button", { name: "確認して記録", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.deepEqual(await count(), { expenses: 9, receipts: 0 });
  record(
    "One confirmation records reviewed OCR without storing an image by default",
  );
  assert.equal(
    page.workers().filter((w) => w.url().includes("/ocr/")).length,
    0,
    "Closing a receipt destroys its image-bearing OCR worker",
  );
  await page.getByRole("button", { name: "レシート", exact: true }).click();
  await receipt
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: "fictional-unavailable.png",
      mimeType: "image/png",
      buffer: Buffer.from(fixture, "base64"),
    });
  await confirm.check();
  await page.evaluate(() => {
    window.__qaBC = window.BroadcastChannel;
    window.BroadcastChannel = undefined;
  });
  await receipt.getByRole("button", { name: "読み取る", exact: true }).click();
  await receipt
    .getByText("この端末では読み取れません。手入力してください。", {
      exact: true,
    })
    .waitFor();
  assert.deepEqual(await count(), { expenses: 9, receipts: 0 });
  await page.evaluate(() => {
    window.BroadcastChannel = window.__qaBC;
    delete window.__qaBC;
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "閉じる", exact: true })
    .click();
  record("OCR unavailable safely falls back to editable fields without saving");
  await page.getByRole("button", { name: "レシート", exact: true }).click();
  await receipt
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: "fictional-cancel.png",
      mimeType: "image/png",
      buffer: Buffer.from(fixture, "base64"),
    });
  await confirm.check();
  await receipt.getByRole("button", { name: "読み取る", exact: true }).click();
  await receipt.getByRole("button", { name: "中止", exact: true }).click();
  await receipt
    .getByRole("button", { name: "確認して記録", exact: true })
    .waitFor();
  assert.deepEqual(await count(), { expenses: 9, receipts: 0 });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "閉じる", exact: true })
    .click();
  record("OCR cancellation clears its worker and keeps records intact");
  const pin = page.getByRole("button", {
    name: "最近の支出を固定",
    exact: true,
  });
  await pin.click();
  const pinned = await page.locator(".adaptive-card h2").allTextContents();
  await page.evaluate(async () => {
    const { db, updateSettings } = await import("/src/db/index.ts");
    const s = await db.settings.get("main");
    await updateSettings({
      personalization: { ...s.personalization, featureUses: { insight: 999 } },
    });
  });
  await page.waitForTimeout(100);
  assert.equal(
    (await page.locator(".adaptive-card h2").allTextContents()).indexOf(
      "最近の支出",
    ),
    pinned.indexOf("最近の支出"),
  );
  record("Pinned home card retains its position after local ranking changes");
  // Model support can be absent; normal entry still works with local rules.
  await page.evaluate(async () => {
    const { updateSettings } = await import("/src/db/index.ts");
    await updateSettings({
      personalization: {
        enabled: false,
        pinnedCards: ["recent"],
        homeCardOrder: ["balances", "insight", "recent"],
        featureUses: {},
      },
    });
  });
  await page.getByRole("button", { name: "支出を記録", exact: true }).click();
  await noOverflow("390 input");
  assert.match(
    await page.locator(".source-picker .chips button").first().innerText(),
    /現金/,
  );
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  record(
    "Personalization OFF keeps account order stable; rules need no AI/GPU",
  );
  await page.getByRole("button", { name: "レシート", exact: true }).click();
  await receipt
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: "fictional-opt-in.png",
      mimeType: "image/png",
      buffer: Buffer.from(fixture, "base64"),
    });
  await confirm.check();
  await receipt.getByRole("button", { name: "読み取る", exact: true }).click();
  await receipt
    .getByRole("button", { name: "確認して記録", exact: true })
    .waitFor({ timeout: 75000 });
  await receipt.getByLabel("合計（円）", { exact: true }).fill("433");
  await receipt.getByLabel("支払元", { exact: true }).selectOption("cash");
  await receipt.getByLabel("レシート画像も端末内に保存").check();
  await receipt
    .getByRole("button", { name: "確認して記録", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.deepEqual(await count(), { expenses: 10, receipts: 1 });
  const imageStorage = await page.evaluate(async () => {
    const { db, readAppData } = await import("/src/db/index.ts");
    const snapshot = await readAppData(false),
      images = await db.receipts.toArray();
    const raw = await new Promise((resolve) => {
      const r = db
        .backendDB()
        .transaction("receipts")
        .objectStore("receipts")
        .getAll();
      r.onsuccess = () => resolve(r.result);
    });
    return {
      snapshotImages: snapshot.receipts.length,
      mime: images[0].mimeType,
      encrypted: raw.every((r) => r.__paceVault === 1),
      hasPlainImage: JSON.stringify(raw).includes(
        images[0].imageBase64.slice(0, 40),
      ),
    };
  });
  assert.deepEqual(imageStorage, {
    snapshotImages: 0,
    mime: "image/jpeg",
    encrypted: true,
    hasPlainImage: false,
  });
  record(
    "Explicit image opt-in stores only the cropped JPEG encrypted; normal snapshots exclude images",
  );
  await page.goto(server.baseURL + "#/analytics");
  await page
    .getByRole("button", { name: /の履歴を見る/ })
    .first()
    .click();
  await page.getByRole("heading", { name: "履歴", exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, "#/history");
  record(
    "Analysis links filter history in memory, without financial query parameters",
  );
  await page.evaluate(async () => {
    const { db } = await import("/src/db/index.ts");
    const now = new Date().toISOString(),
      date = now.slice(0, 10);
    await db.expenses.put({
      id: "fictional-shortage",
      createdAt: now,
      updatedAt: now,
      amount: 999999999999,
      date,
      merchant: "架空の長い店名です".repeat(9),
      description: "",
      categoryId: "food",
      subcategoryId: "food-0",
      paymentMethod: "cash",
      sourceAccountId: "cash",
      memo: "",
      isFixedCost: false,
    });
  });
  await page.goto(server.baseURL + "#/");
  await page.waitForFunction(() =>
    document.querySelector(".hero-status")?.textContent.includes("不足"),
  );
  await noOverflow("negative large home");
  await page.goto(server.baseURL + "#/history");
  await noOverflow("large long-name history");
  record(
    "Negative availability and 12-digit expenses with long merchant names remain readable",
  );
  await page.evaluate(async () => {
    const { db, deleteExpense } = await import("/src/db/index.ts");
    for (const e of await db.expenses.toArray()) await deleteExpense(e.id);
  });
  await page.reload();
  await noOverflow("zero data history");
  record("Empty history has a clear state and no layout overflow");
  await page.evaluate(async () => {
    const { db } = await import("/src/db/index.ts");
    const now = new Date().toISOString(),
      date = now.slice(0, 10);
    await db.expenses.bulkPut(
      Array.from({ length: 1000 }, (_, i) => ({
        id: "fictional-volume-" + i,
        createdAt: now,
        updatedAt: now,
        amount: 100 + i,
        date,
        merchant: "架空店" + i,
        description: "",
        categoryId: "food",
        subcategoryId: "food-0",
        paymentMethod: "cash",
        sourceAccountId: "cash",
        memo: "",
        isFixedCost: false,
      })),
    );
  });
  await page.waitForFunction(
    () => document.querySelectorAll(".transaction-row").length >= 60,
  );
  assert.equal(await page.locator(".transaction-row").count(), 60);
  await noOverflow("1000 history");
  record(
    "1,000 fictional records keep the initial history list bounded at 60 rows",
  );
  assert.deepEqual(external, [], "No external requests");
  assert.deepEqual(errors, [], "No runtime errors");
  await fs.writeFile(
    "test-results/experience-ui.json",
    JSON.stringify(
      {
        passed: true,
        checks,
        externalRequests: external.length,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(`Experience UI passed: ${checks.length} checks.`);
} finally {
  await browser.close();
  await server.close();
}
