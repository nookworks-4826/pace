import { installVaultSupport } from "./qa-vault-support.mjs";
import { chromium } from "playwright";
import fs from "node:fs/promises";
const baseURL = (
  process.env.PACE_QA_BASE_URL || "http://127.0.0.1:5173/"
).replace(/\/$/, "");
await fs.mkdir("test-results", { recursive: true });
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  headless: true,
});
try {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  installVaultSupport(page);
  const errors = [];
  const results = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await fs.mkdir("test-results", { recursive: true });
  await page.goto(baseURL + "/");
  await page.getByRole("button", { name: "設定をあとで行う" }).click();
  const go = async (path) => {
    await page.goto(baseURL + "/#" + path);
    await page.locator(".bottom-nav").waitFor();
  };
  const closeToast = async () => {
    const b = page.getByRole("button", { name: "通知を閉じる" });
    if (await b.isVisible()) await b.click();
  };
  const save = async () => {
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存する", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await closeToast();
  };
  const finance = async () =>
    await page.evaluate(async () => {
      const dbm = await import("/src/db/index.ts");
      const m = await import("/src/domain/finance.ts");
      return m.computeFinance(await dbm.readAppData());
    });
  // Confirm skipped onboarding then expenses before entering a real current balance.
  await page.getByRole("button", { name: "支出を記録", exact: true }).click();
  await page.getByLabel("支出金額", { exact: true }).fill("1000");
  await page.getByLabel("店名・内容", { exact: true }).fill("昼食");
  await page.getByRole("button", { name: "記録する", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await closeToast();
  await page
    .getByRole("button", { name: "現在残高を入力する", exact: true })
    .click();
  await page.getByLabel("実際の銀行＋現金残高").fill("30000");
  await save();
  assert.equal((await finance()).liquidBalance, 30000);
  results.push("残高未入力→支出→現在残高照合");
  await go("/manage/cards");
  await page.getByRole("button", { name: "最初のカードを追加" }).click();
  await page.getByLabel("カード名", { exact: true }).fill("Visa");
  await page.getByLabel("締め日（31＝月末）", { exact: true }).fill("31");
  await page.getByLabel("下4桁（任意）").fill("1234");
  await page.getByLabel("記録開始前からのカード未払い").fill("0");
  await save();
  await page.getByRole("button", { name: "支出を追加", exact: true }).click();
  await page.getByLabel("支出金額", { exact: true }).fill("5000");
  await page.getByLabel("店名・内容", { exact: true }).fill("サイゼリヤ");
  await page.getByRole("button", { name: "カード", exact: true }).click();
  await page.getByRole("button", { name: "記録する", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await closeToast();
  let f = await finance();
  assert.equal(f.liquidBalance, 30000);
  assert.equal(f.cardOutstanding, 5000);
  assert.equal(f.safeToSpend, 25000);
  await page.getByRole("button", { name: "引落を記録", exact: true }).click();
  await save();
  f = await finance();
  assert.equal(f.liquidBalance, 25000);
  assert.equal(f.cardOutstanding, 0);
  assert.equal(f.safeToSpend, 25000);
  assert.equal(f.monthlyExpenseTotal, 6000);
  results.push("カード購入5000→引落5000、二重計上なし");
  await go("/manage/debts");
  await page.getByRole("button", { name: "借入を追加", exact: true }).click();
  await page.getByLabel("貸してくれた人・会社").fill("親（検証用）");
  await page.getByLabel("借入の内容").fill("渡航費");
  await page.getByLabel("元の借入額", { exact: true }).fill("70000");
  await page.getByLabel("記録開始時の返済残高").fill("70000");
  await page.getByLabel("毎月の返済予定", { exact: true }).fill("5000");
  await page.getByLabel("返済開始・今期のお金を確保する").check();
  await save();
  assert.equal((await finance()).safeToSpend, 20000);
  await page.getByRole("button", { name: "返済を記録", exact: true }).click();
  await save();
  assert.equal((await finance()).safeToSpend, 20000);
  assert.equal((await finance()).liquidBalance, 20000);
  results.push("借入登録→返済、確保額を解放");
  await go("/manage/savings");
  await page.getByRole("button", { name: "目標を追加", exact: true }).click();
  await page.getByLabel("目標名", { exact: true }).fill("旅の準備（検証用）");
  await page.getByLabel("目標額", { exact: true }).fill("100000");
  await page.getByLabel("毎月の貯金予定", { exact: true }).fill("5000");
  await save();
  assert.equal((await finance()).safeToSpend, 15000);
  await page
    .getByRole("button", { name: "貯金への移動を記録", exact: true })
    .click();
  await save();
  assert.equal((await finance()).safeToSpend, 15000);
  assert.equal((await finance()).liquidBalance, 15000);
  results.push("貯金目標→移動、確保額を解放");
  await go("/manage/recurring");
  await page
    .getByRole("button", { name: "固定費を追加", exact: true })
    .first()
    .click();
  await page.getByLabel("名前", { exact: true }).fill("スマホ");
  await page.getByLabel("支払予定額").fill("5000");
  await page.getByLabel("支払日（31＝月末）").fill("27");
  await save();
  assert.equal((await finance()).safeToSpend, 10000);
  await page
    .getByRole("button", { name: "支払った・金額変更", exact: true })
    .click();
  await save();
  assert.equal((await finance()).safeToSpend, 10000);
  assert.equal((await finance()).liquidBalance, 10000);
  results.push("固定費登録→確定、二重計上なし");
  await go("/history");
  await page.getByRole("button", { name: "サイゼリヤを編集" }).click();
  await page.getByLabel("支出金額", { exact: true }).fill("4000");
  await page.getByRole("button", { name: "現金", exact: true }).click();
  await page.getByRole("button", { name: "変更を保存", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await closeToast();
  f = await finance();
  assert.equal(f.liquidBalance, 6000);
  assert.equal(f.cardOutstanding, 0);
  results.push("カード→現金・金額編集（支払超過表示対象）");
  page.on("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "サイゼリヤを削除" }).click();
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await page.getByRole("button", { name: "サイゼリヤを編集" }).waitFor();
  results.push("支出削除→Undo");
  await go("/settings");
  await page.getByRole("button", { name: "バックアップと書き出し" }).click();
  await page.getByRole("button", { name: "JSONバックアップを作成" }).click();
  try {
    await page.locator(".download-ready").waitFor();
  } catch (error) {
    const diagnostic = await page.evaluate(async () => {
      const storage = await import("/src/db/index.ts");
      const backup = await import("/src/domain/backup/index.ts");
      try {
        const data = await storage.readAppData();
        await backup.parseBackup(backup.createBackup(data));
        return {
          directRoundTrip: true,
          alert: document.querySelector('[role="alert"]')?.textContent ?? null,
        };
      } catch (failure) {
        return {
          directRoundTrip: false,
          name: failure.name,
          message: failure.message,
          alert: document.querySelector('[role="alert"]')?.textContent ?? null,
        };
      }
    });
    await fs.writeFile(
      "test-results/flow-backup-diagnostic.json",
      JSON.stringify(diagnostic, null, 2),
    );
    throw error;
  }
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "ファイルを保存", exact: true })
    .click();
  let download;
  try {
    download = await downloadPromise;
  } catch (error) {
    await fs.writeFile(
      "test-results/flow-download-diagnostic.json",
      JSON.stringify(
        {
          ready: await page.locator(".download-ready").innerText(),
          alerts: await page.locator('[role="alert"]').allTextContents(),
          errors,
        },
        null,
        2,
      ),
    );
    await page.screenshot({
      path: "test-results/flow-download-failure.png",
      fullPage: true,
    });
    throw error;
  }
  await download.saveAs("test-results/test-backup.json");
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await page
    .getByRole("button", { name: "バックアップを復元", exact: true })
    .click();
  await page
    .getByLabel("バックアップファイル", { exact: true })
    .setInputFiles("test-results/test-backup.json");
  await page.getByRole("button", { name: "内容を確認", exact: true }).click();
  await page
    .getByRole("button", { name: "確認した内容で置き換える", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal((await finance()).liquidBalance, 6000);
  results.push("JSON出力→検証プレビュー→復元");
  await closeToast();
  await page.getByRole("button", { name: "アプリロック", exact: true }).click();
  await page.getByRole("button", { name: "6桁PIN", exact: true }).click();
  await page.getByLabel("新しい6桁PIN").fill("926417");
  await page.getByLabel("PINをもう一度").fill("926417");
  await page.getByRole("button", { name: "PINを設定", exact: true }).click();
  await page.getByText("現在：6桁PIN").waitFor();
  await page.reload();
  await page.getByLabel("6桁のPIN", { exact: true }).fill("926417");
  await page.getByRole("button", { name: "ロックを解除", exact: true }).click();
  await page.locator(".bottom-nav").waitFor();
  results.push("PIN設定→再起動→認証解除");
  await go("/");
  await closeToast();
  await page.screenshot({
    path: "test-results/verified-home.png",
    fullPage: true,
  });
  console.log(
    JSON.stringify({ results, errors, finance: await finance() }, null, 2),
  );
  await fs.writeFile(
    "test-results/flow-results.json",
    JSON.stringify({ results, errors }, null, 2),
  );
  assert.deepEqual(errors, [], "ブラウザエラーがないこと");
} finally {
  await browser.close();
}
