// Disposable browser profile and fictional finance only; never targets GitHub or live storage.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { startQaServer } from "./qa-vite-support.mjs";
import { installVaultSupport } from "./qa-vault-support.mjs";
const server = await startQaServer("practical"),
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
  }),
  page = await context.newPage();
installVaultSupport(page);
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
const record = (name) => {
  checks.push(name);
  console.log("✓ " + name);
};
async function count() {
  return page.evaluate(async () => {
    const { db } = await import("/src/db/index.ts");
    return db.expenses.count();
  });
}
async function close() {
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "閉じる", exact: true })
    .click();
}
async function noOverflow() {
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Horizontal overflow",
  );
}
try {
  await page.goto(server.baseURL);
  await page
    .getByRole("button", { name: "設定をあとで行う", exact: true })
    .click();
  await page.evaluate(async () => {
    const { db, updateSettings } = await import("/src/db/index.ts");
    const { todayJST } = await import("/src/domain/dates.ts");
    const today = todayJST(),
      at = today + "T00:00:00+09:00";
    await updateSettings({
      financialAutomationEnabled: true,
      helpDismissed: true,
      setupReviewed: ["balance", "salary", "cards", "debts", "recurring"],
      practical: undefined,
    });
    await db.accounts.bulkPut(
      ["cash", "bank"].map((id, i) => ({
        id,
        name: i ? "架空銀行" : "架空現金",
        kind: i ? "BANK" : "CASH",
        institutionName: "架空",
        currency: "JPY",
        snapshotBalance: 10000,
        balanceAsOf: today,
        snapshotRecordedAt: at,
        lastVerifiedAt: at,
        balanceSource: "manual",
        isSpendable: true,
        isActive: true,
        automationLevel: "manual",
        createdAt: at,
        updatedAt: at,
      })),
    );
    await db.expenses.put({
      id: "previous",
      createdAt: today + "T01:00:00+09:00",
      updatedAt: at,
      amount: 450,
      date: today,
      merchant: "架空カフェ",
      description: "",
      categoryId: "food",
      subcategoryId: "food-0",
      paymentMethod: "cash",
      sourceAccountId: "cash",
      memo: "架空メモ",
      isFixedCost: false,
    });
  });
  await page.reload();
  await page.getByRole("button", { name: "使い始める", exact: true }).click();
  await page.waitForFunction(async () => {
    const { db } = await import("/src/db/index.ts");
    return (
      (await db.settings.get("main")).practical?.welcomedVersion === "2.2.1"
    );
  });
  await page.reload();
  assert.equal(
    await page.getByRole("button", { name: "使い始める", exact: true }).count(),
    0,
  );
  record("One-time upgrade welcome can be dismissed without forcing backup");
  await page.getByRole("button", { name: "支出を記録", exact: true }).click();
  await page.getByRole("button", { name: "前回と同じ", exact: true }).click();
  assert.equal(await count(), 1);
  assert.equal(
    await page.getByLabel("支出金額", { exact: true }).inputValue(),
    "450",
  );
  await page.getByRole("button", { name: "記録する", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await count(), 2);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await page.waitForFunction(async () => {
    const { db } = await import("/src/db/index.ts");
    return (await db.expenses.count()) === 1;
  });
  record(
    "Previous expense copies safe fields only; explicit save and encrypted Undo",
  );
  await page.goto(server.baseURL + "#/settings");
  await page.getByRole("button", { name: "お気に入り", exact: true }).click();
  await page
    .getByRole("button", { name: "お気に入りを追加", exact: true })
    .click();
  const favorite = page.getByRole("dialog").last();
  await favorite.getByLabel("名前", { exact: true }).fill("架空の定番");
  await favorite.getByLabel("店名（任意）").fill("架空お気に入り店");
  await favorite.locator("select[name=category]").selectOption("food");
  await favorite.getByLabel("支払元（任意）").selectOption("bank");
  await favorite.getByLabel("メモ（任意）").fill("架空メモ");
  await favorite
    .getByRole("button", { name: "お気に入りを保存", exact: true })
    .click();
  await page.waitForFunction(async () => {
    const { db } = await import("/src/db/index.ts");
    return (await db.favorites.count()) === 1;
  });
  await close();
  await page.goto(server.baseURL + "#/");
  await page.getByRole("button", { name: "支出を記録", exact: true }).click();
  await page
    .getByRole("button", { name: "架空の定番", exact: true })
    .first()
    .click();
  assert.equal(
    await page.getByLabel("支出金額", { exact: true }).inputValue(),
    "0",
  );
  await page.getByLabel("支出金額", { exact: true }).fill("700");
  await page.getByRole("button", { name: "記録する", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  record("Favorite with optional amount reuses its bank source and memo");
  await page.getByRole("button", { name: "支出を記録", exact: true }).click();
  await page.getByLabel("支出金額", { exact: true }).fill("333");
  await page.getByRole("button", { name: "架空現金", exact: true }).click();
  await page.getByRole("button", { name: "記録する", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("link", { name: /あとで整理 ·/ }).click();
  await page.getByRole("heading", { name: /^あとで整理/ }).waitFor();
  assert.match(await page.locator("h1").innerText(), /1件/);
  await page
    .getByRole("button", { name: "100件まで選ぶ", exact: true })
    .click();
  await page.getByLabel("まとめて分類").selectOption("food");
  await page
    .getByRole("button", { name: "分類して確認済み", exact: true })
    .click();
  await page.waitForFunction(async () => {
    const { db } = await import("/src/db/index.ts");
    return (await db.expenseInbox.count()) === 0;
  });
  record(
    "Amount-only input is accounted for immediately and reviewed in Inbox",
  );
  await page.goto(server.baseURL + "#/money");
  await page
    .getByRole("button", { name: "残高をまとめて確認", exact: true })
    .click();
  await page.getByLabel("架空現金の確認残高").fill("9000");
  for (const label of [
    "支出として記録",
    "収入として記録",
    "残高だけ調整",
    "あとで確認",
  ])
    assert.equal(
      await page.getByRole("button", { name: label, exact: true }).count(),
      1,
    );
  await page.getByRole("button", { name: "あとで確認", exact: true }).click();
  await page
    .getByRole("button", { name: "確認した残高を保存", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(async () => {
      const { db } = await import("/src/db/index.ts");
      return (await db.accounts.get("cash")).snapshotBalance;
    }),
    10000,
  );
  record(
    "Balance drift offers four explicit choices; defer does not alter the ledger",
  );
  await page
    .getByRole("button", { name: "残高をまとめて確認", exact: true })
    .click();
  await page.getByLabel("架空現金の確認残高").fill("9700");
  await page
    .getByRole("button", { name: "収入として記録", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "差額を収入として記録", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(async () => {
      const { db } = await import("/src/db/index.ts");
      return db.incomes.count();
    }),
    0,
  );
  await page.getByRole("button", { name: "収入を記録", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  record(
    "Income drift opens confirmation and does not save on choosing the option",
  );
  await page.goto(server.baseURL + "#/");
  await page.getByRole("button", { name: "レシート", exact: true }).click();
  await page.getByRole("button", { name: "手入力する", exact: true }).click();
  for (const label of [
    "撮影し直す",
    "切り抜きを調整",
    "金額だけで登録",
    "手入力に切り替え",
  ])
    assert.equal(
      await page.getByRole("button", { name: label, exact: true }).count(),
      1,
    );
  await page.locator(".receipt-review").getByLabel("合計（円）").fill("222");
  const beforeManual = await count();
  await page
    .getByRole("button", { name: "手入力に切り替え", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector("#expense-amount")?.value === "222",
  );
  assert.equal(await count(), beforeManual);
  await close();
  record(
    "Four OCR exits remain obvious; manual handoff preserves amount without saving",
  );
  await page.goto(server.baseURL + "#/money");
  await page.locator(".account-card").filter({ hasText: "架空現金" }).click();
  assert.equal(await page.getByLabel("残高確認の間隔").inputValue(), "3");
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", {
      name: "使わなくなった口座をアーカイブ",
      exact: true,
    })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.goto(server.baseURL + "#/");
  await page.getByRole("button", { name: "支出を記録", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "架空現金", exact: true }).count(),
    0,
  );
  await close();
  await page.goto(server.baseURL + "#/money");
  await page.getByText("アーカイブ済みの口座", { exact: true }).click();
  await page.getByRole("button", { name: "再表示", exact: true }).click();
  await page.waitForFunction(async () => {
    const { db } = await import("/src/db/index.ts");
    return !(await db.accounts.get("cash")).archivedAt;
  });
  record(
    "Archive retains account and finances while removing entry candidates, then restores",
  );
  await page.goto(server.baseURL + "#/settings");
  await page
    .getByText("ホームの操作を選ぶ（最大5つ）", { exact: true })
    .click();
  await page.getByLabel("収入", { exact: true }).check();
  await page.getByLabel("あとで整理", { exact: true }).check();
  await page.waitForFunction(async () => {
    const { db } = await import("/src/db/index.ts");
    return (
      (await db.settings.get("main")).personalization?.quickActions?.length ===
      5
    );
  });
  await page.goto(server.baseURL + "#/");
  assert.equal(await page.locator(".home-quick-actions button").count(), 5);
  await noOverflow();
  record("Five configurable home actions stay within mobile width");
  await page.goto(server.baseURL + "#/settings?panel=data");
  await page.getByText("暗号化バックアップを作成", { exact: true }).click();
  await page
    .getByLabel("パスワード（8文字以上）", { exact: true })
    .fill("fictional-backup-password");
  await page
    .getByLabel("もう一度入力", { exact: true })
    .fill("fictional-backup-password");
  await page
    .getByRole("button", { name: "暗号化ファイルを作成", exact: true })
    .click();
  await page.getByText("保存の準備ができました", { exact: true }).waitFor();
  assert.match(await page.locator(".download-ready").innerText(), /要確認/);
  assert.equal(
    await page.evaluate(async () => {
      const { db } = await import("/src/db/index.ts");
      return (await db.settings.get("main")).lastBackupAt;
    }),
    null,
  );
  record(
    "Backup health verifies decryptability and does not claim a saved OS file",
  );
  await close();
  await page.goto(server.baseURL + "#/privacy");
  assert.match(await page.locator(".page").innerText(), /レシート：0件/);
  await noOverflow();
  await fs.mkdir("test-results/screenshots", { recursive: true });
  await page.screenshot({
    path: "test-results/screenshots/practical-privacy-390.png",
    fullPage: true,
  });
  record("Privacy center reflects real receipt count and backup status");
  await page.evaluate(async () => {
    const { db } = await import("/src/db/index.ts");
    await db.expenseInbox.put({
      id: "fictional-missing",
      expenseId: "fictional-missing",
      reasons: ["ocr"],
    });
  });
  await page.reload();
  await page
    .getByRole("heading", { name: "データを保護して停止しました", exact: true })
    .waitFor();
  const blocked = await page.evaluate(async () => {
    const { db } = await import("/src/db/index.ts");
    try {
      await db.expenses.delete("previous");
      return false;
    } catch {
      return true;
    }
  });
  assert(blocked);
  record(
    "Invalid references stop startup, preserve data and block database writes",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await fs.writeFile(
    "test-results/practical-ui.json",
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
} finally {
  await browser.close();
  await server.close();
}
