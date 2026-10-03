import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";

let server;
let base = (process.env.PACE_QA_BASE_URL || "http://localhost:5193/").replace(/\/$/, "");
if (process.env.PACE_QA_RECEIPTS_PROJECT === "1" || !process.env.PACE_QA_BASE_URL) {
  const root = path.resolve("dist");
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (!url.pathname.startsWith("/pace/")) { response.writeHead(404).end(); return; }
      const target = path.resolve(root, decodeURIComponent(url.pathname.slice(6)) || "index.html");
      if (!target.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      const content = await fs.readFile(target);
      response.writeHead(200, { "Content-Type": mime[path.extname(target)] || "application/octet-stream", "Cache-Control": "no-store" }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://localhost:${server.address().port}/pace`;
}
const origin = new URL(base).origin;
const appPath = `${new URL(base).pathname.replace(/\/$/, "")}/`;
const requireServiceWorker = process.env.PACE_QA_RECEIPTS_SW === "1";
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [];
const external = [];
const ocrRequests = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request.url());
  if (request.url().includes("/ocr/")) ocrRequests.push({ url: request.url(), method: request.method() });
});
await fs.mkdir("test-results", { recursive: true });
try {
  await page.goto(`${base}/`);
  await page.getByLabel("パスフレーズ（12文字以上）").fill("fictional-receipt-qa-only");
  await page.getByLabel("もう一度入力").fill("fictional-receipt-qa-only");
  await page.getByRole("button", { name: "暗号化して始める", exact: true }).click();
  await page.getByRole("button", { name: "設定をあとで行う", exact: true }).click();
  await page.locator(".hero-card").waitFor();
  if (requireServiceWorker) {
    await page.evaluate(async () => navigator.serviceWorker.ready);
    await page.reload();
    await page.getByLabel("パスフレーズ（12文字以上）").fill("fictional-receipt-qa-only");
    await page.getByRole("button", { name: "開く", exact: true }).click();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  }
  const fixture = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 1100; canvas.height = 1150;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1100, 1150);
    ctx.fillStyle = "#111"; ctx.font = '48px "Arial", "Yu Gothic", sans-serif';
    const lines = ["FICTIONAL MARKET", "2026/10/03 14:30", "ミルク       220", "パン         180", "小計         400", "消費税        32", "合計         432", "現金        1000", "お釣り       568"];
    lines.forEach((line, index) => ctx.fillText(line, 60, 100 + index * 105));
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const fixtureFile = { name: "fictional-receipt.png", mimeType: "image/png", buffer: Buffer.from(fixture, "base64") };
  await page.getByRole("button", { name: "支出を記録", exact: true }).click();
  await page.getByRole("button", { name: "レシートから入力", exact: true }).click();
  const receipt = page.locator(".receipt-capture");
  const choose = async () => receipt.locator('input[type="file"]').last().setInputFiles(fixtureFile);
  await choose();
  await receipt.getByRole("button", { name: "読み取る", exact: true }).click();
  await receipt.getByRole("button", { name: "入力に反映", exact: true }).waitFor({ timeout: 70_000 });
  assert.equal(await receipt.getByLabel("合計（円）", { exact: true }).inputValue(), "432");
  assert.match(await receipt.getByLabel("お店", { exact: true }).inputValue(), /FICTIONAL/i);
  assert.equal(await receipt.getByLabel("日付", { exact: true }).inputValue(), "2026-10-03");
  assert.equal(await receipt.getByLabel("時刻（任意）", { exact: true }).inputValue(), "14:30");
  assert.equal(await receipt.getByLabel("レシート画像も端末内に保存").isChecked(), false);
  await receipt.getByLabel("合計（円）", { exact: true }).fill("450");
  await receipt.getByRole("button", { name: "入力に反映", exact: true }).click();
  assert.equal(await page.getByLabel("支出金額", { exact: true }).inputValue(), "450");
  assert.equal(await page.getByRole("dialog").isVisible(), true); // Applying candidates does not book an expense.
  const rawCounts = () => page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open("pace"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await Promise.all(["expenses", "receipts"].map((table) => new Promise((resolve, reject) => { const request = database.transaction(table, "readonly").objectStore(table).count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }))); }
    finally { database.close(); }
  });
  assert.deepEqual(await rawCounts(), [0, 0]);

  // Cancelling while loading/initializing must release the worker, without a saved record.
  await page.getByRole("button", { name: "レシートから入力", exact: true }).click();
  await choose();
  const workerStarting = page.waitForEvent("worker");
  await receipt.getByRole("button", { name: "読み取る", exact: true }).click();
  await workerStarting;
  await receipt.getByRole("button", { name: "中止", exact: true }).click();
  await receipt.getByRole("button", { name: "入力に反映", exact: true }).waitFor();
  assert.equal(await receipt.getByLabel("合計（円）", { exact: true }).inputValue(), "");

  // Block initialization and advance only the page clock to exercise the one-minute UI timeout.
  await page.clock.install();
  await page.route("**/ocr/*.traineddata.gz", (route) => new Promise((resolve) => { setTimeout(() => { void route.abort().then(resolve); }, 4000); }));
  await choose();
  await receipt.getByRole("button", { name: "読み取る", exact: true }).click();
  await receipt.getByRole("button", { name: "中止", exact: true }).waitFor();
  await page.clock.fastForward(61_000);
  await receipt.getByText("時間がかかっているため中止しました。撮影し直すか、下に入力してください。", { exact: true }).waitFor();
  await page.unroute("**/ocr/*.traineddata.gz");
  await page.clock.resume();

  if (requireServiceWorker) {
    const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async (name) => (await (await caches.open(name)).keys()).map((request) => request.url)))).flat());
    assert(cached.some((url) => url.endsWith("/ocr/jpn.traineddata.gz")));
    assert(cached.some((url) => url.endsWith("/ocr/eng.traineddata.gz")));
    assert(cached.every((url) => !url.startsWith("blob:") && !url.startsWith("data:") && !url.includes("fictional-receipt")));
    await context.setOffline(true);
    await choose();
    await receipt.getByRole("button", { name: "読み取る", exact: true }).click();
    await receipt.getByRole("button", { name: "入力に反映", exact: true }).waitFor({ timeout: 70_000 });
    assert.equal(await receipt.getByLabel("合計（円）", { exact: true }).inputValue(), "432");
    await context.setOffline(false);
  }
  // Opting in saves a resized JPEG only when the expense itself is explicitly saved.
  if (!requireServiceWorker) {
    await choose(); await receipt.getByRole("button", { name: "読み取る", exact: true }).click();
    await receipt.getByRole("button", { name: "入力に反映", exact: true }).waitFor({ timeout: 70_000 });
  }
  await receipt.getByLabel("レシート画像も端末内に保存").check();
  await receipt.getByRole("button", { name: "入力に反映", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.receipt-capture > button')?.getAttribute("aria-expanded") === "false");
  assert.deepEqual(await rawCounts(), [0, 0]);
  await page.getByRole("button", { name: "記録する", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.deepEqual(await rawCounts(), [1, 1]);
  const receiptStorage = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open("pace"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    let row, metadata;
    try {
      [row, metadata] = await Promise.all(["receipts", "vaultMeta"].map((table) => new Promise((resolve, reject) => { const request = database.transaction(table, "readonly").objectStore(table).getAll(); request.onsuccess = () => resolve(request.result[0]); request.onerror = () => reject(request.error); })));
    } finally { database.close(); }
    const bytes = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); const enc = new TextEncoder();
    const material = await crypto.subtle.importKey("raw", enc.encode("fictional-receipt-qa-only"), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: bytes(metadata.salt), iterations: metadata.iterations }, material, 512));
    const key = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["decrypt"]); bits.fill(0);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(row.__iv), additionalData: enc.encode(JSON.stringify(["pace-vault-row:v1", "receipts", row.id])) }, key, bytes(row.__ciphertext));
    const decoded = JSON.parse(new TextDecoder().decode(plain));
    return { encrypted: row.__paceVault === 1 && !JSON.stringify(row).includes("data:image"), jpeg: decoded.mimeType === "image/jpeg" && atob(decoded.imageBase64).slice(0, 3) === "\xff\xd8\xff", sizeOK: decoded.imageBase64.length < 8 * 1024 * 1024 * 4 / 3, linkedExpense: !!decoded.expenseId };
  });
  assert.deepEqual(receiptStorage, { encrypted: true, jpeg: true, sizeOK: true, linkedExpense: true });
  assert.equal(external.length, 0, "OCR must make no external requests");
  assert(ocrRequests.every((request) => request.method === "GET"));
  assert(ocrRequests.every((request) => new URL(request.url).pathname.startsWith(`${appPath}ocr/`)), "OCR assets must respect project base path");
  assert.equal(errors.length, 0, "OCR must not produce page errors");
  await page.screenshot({ path: "test-results/receipt-review-390.png", fullPage: true });
  await fs.writeFile("test-results/receipts-results.json", JSON.stringify({ realOCR: true, japaneseAndEnglish: true, editableCandidate: true, explicitApplyNoAutoBooking: true, imageDefaultOff: true, imageExplicitOptInEncryptedJPEG: true, cancellation: true, timeout: true, offlineWithCachedModels: requireServiceWorker ? true : "requires production SW run", noExternalRequests: true, basePath: appPath, pageErrors: errors.length }, null, 2));
  console.log("Receipt QA passed: real Japanese/English OCR, editable review, cancellation, timeout, privacy and base path" + (requireServiceWorker ? ", cached models offline." : ". Offline OCR requires a production SW run."));
} finally { await context.close(); await browser.close(); if (server) await new Promise((resolve) => server.close(resolve)); }
