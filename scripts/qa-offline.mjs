import { chromium } from "playwright";
import fs from "node:fs/promises";
await fs.mkdir("test-results", { recursive: true });
import assert from "node:assert/strict";
const base = (process.env.PACE_QA_BASE_URL || "http://127.0.0.1:4173/").replace(
  /\/$/,
  "",
);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const errors = [],
  externalRequests = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (!r.url().startsWith(base + "/") && !r.url().startsWith("data:"))
    externalRequests.push(r.url());
});
await page.goto(base + "/");
await page.getByRole("button", { name: "設定をあとで行う" }).click();
await page.locator(".hero-card").waitFor();
await page.evaluate(async () => {
  await navigator.serviceWorker.ready;
});
await page.reload();
await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
const caches = await page.evaluate(async () => {
  const names = await window.caches.keys();
  const total = await Promise.all(
    names.map(async (n) =>
      (await (await window.caches.open(n)).keys()).map((r) => r.url),
    ),
  );
  return total.flat();
});
assert(caches.some((url) => url.includes("exceljs")));
assert(caches.some((url) => url.includes("Analytics")));
await context.setOffline(true);
await page.reload();
await page
  .locator(".hero-card")
  .waitFor({ timeout: 12000 })
  .catch(async (e) => {
    console.log("OFFLINE BODY", await page.locator("body").innerText(), errors);
    await page.screenshot({ path: "test-results/offline-error.png" });
    throw e;
  });
await page
  .getByRole("button", { name: "現在残高を入力する", exact: true })
  .click();
await page.getByLabel("実際の銀行＋現金残高").fill("30000");
await page.getByRole("button", { name: "保存する", exact: true }).click();
await page.getByRole("dialog").waitFor({ state: "hidden" });
await page.getByRole("button", { name: "支出を記録", exact: true }).click();
await page.getByLabel("支出金額", { exact: true }).fill("1280");
await page.getByLabel("店名・内容", { exact: true }).fill("オフラインの昼食");
await page.getByRole("button", { name: "記録する", exact: true }).click();
await page.getByRole("dialog").waitFor({ state: "hidden" });
await page.reload();
await page.getByText("￥28,720", { exact: true }).first().waitFor();
for (const route of [
  "/history",
  "/analytics",
  "/manage/cards",
  "/manage/debts",
  "/manage/savings",
  "/manage/recurring",
  "/manage/incomes",
  "/settings",
]) {
  await page.goto(base + "/#" + route);
  await page.locator(".page").waitFor();
}
await page.getByRole("button", { name: "バックアップと書き出し" }).click();
await page.getByRole("button", { name: "Excelを作成", exact: true }).click();
await page.getByText("保存の準備ができました", { exact: true }).waitFor();
const downloadPromise = page.waitForEvent("download");
await page.getByRole("button", { name: "ファイルを保存", exact: true }).click();
const download = await downloadPromise;
await download.saveAs("test-results/offline.xlsx");
const stat = await fs.stat("test-results/offline.xlsx");
assert(stat.size > 5000);
const manifest = await page.evaluate(async () => {
  const cacheNames = await window.caches.keys();
  for (const name of cacheNames) {
    const cache = await window.caches.open(name);
    const requests = await cache.keys();
    const m = requests.find((r) => r.url.includes("manifest.webmanifest"));
    if (m) {
      const r = await cache.match(m);
      return r ? await r.text() : null;
    }
  }
  return null;
});
const result = {
  offlineReload: true,
  expensePersisted: true,
  allRoutes: true,
  excelExport: true,
  externalRequests,
  errors,
  cachedAssets: caches.length,
  manifestCached: manifest !== null,
};
await fs.writeFile(
  "test-results/offline-results.json",
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
await browser.close();
assert.deepEqual(errors, [], "オフライン中にブラウザエラーがないこと");
assert.deepEqual(externalRequests, [], "外部サービスへの通信がないこと");
assert(result.manifestCached, "manifestがキャッシュ済みであること");
