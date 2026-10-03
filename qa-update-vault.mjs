import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const previous = path.resolve(process.env.PACE_QA_PREVIOUS_DIST || "../../work/automation-baseline-1.3.0-dist");
const current = path.resolve("dist");
const version = JSON.parse(await readFile("package.json", "utf8")).version;
await readFile(path.join(previous, "sw.js")); await readFile(path.join(current, "sw.js"));
let release = 0;
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (!url.pathname.startsWith("/pace/")) { response.writeHead(404).end(); return; }
    const root = release === 0 ? previous : current;
    const relative = decodeURIComponent(url.pathname.slice(6)) || "index.html";
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    let contents = await readFile(target);
    if (relative === "sw.js") contents = Buffer.concat([contents, Buffer.from(`\n// Isolated migration QA release ${release}\n`)]);
    response.writeHead(200, { "Content-Type": mime[path.extname(target)] || "application/octet-stream", "Cache-Control": "no-store" }).end(contents);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://localhost:${server.address().port}/pace/`;
const phrase = "fictional-update-vault-only";
const pin = "926417";
function ordered(rows, keyPath) {
  const key = (row) => JSON.stringify(Array.isArray(keyPath) ? keyPath.map((part) => row[part]) : row[keyPath]);
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
}
let browser;
let inspectedPage;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  inspectedPage = page;
  await page.addInitScript(() => {
    window.__paceQACaughtErrors = [];
    const original = Promise.prototype.catch;
    Promise.prototype.catch = function (handler) {
      return original.call(this, (error) => { window.__paceQACaughtErrors.push({ name: error?.name, message: error?.message, stack: error?.stack }); return handler ? handler(error) : Promise.reject(error); });
    };
  });
  const errors = []; const external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  context.on("request", (request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith(base)) external.push(request.url()); });
  async function snapshot() {
    return page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => { const request = indexedDB.open("pace"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        const names = [...database.objectStoreNames]; const tx = database.transaction(names, "readonly");
        const tables = await Promise.all(names.map((name) => new Promise((resolve, reject) => { const store = tx.objectStore(name); const request = store.getAll(); request.onsuccess = () => resolve([name, { keyPath: store.keyPath, rows: request.result }]); request.onerror = () => reject(request.error); })));
        return { version: database.version, tables: Object.fromEntries(tables), storage: Object.fromEntries(Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)])) };
      } finally { database.close(); }
    });
  }
  async function unlockPin() { await page.getByLabel("6桁のPIN", { exact: true }).fill(pin); await page.getByRole("button", { name: "ロックを解除", exact: true }).click(); }
  async function unlockCurrent() {
    await page.getByLabel("パスフレーズ（12文字以上）").fill(phrase); await page.getByRole("button", { name: "開く", exact: true }).click();
    await unlockPin(); await page.locator(".bottom-nav").waitFor();
  }
  async function logicalSnapshot(raw) {
    return page.evaluate(async ({ raw, phrase }) => {
      const metadata = raw.tables.vaultMeta.rows[0];
      const bytes = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
      const enc = new TextEncoder();
      const material = await crypto.subtle.importKey("raw", enc.encode(phrase), "PBKDF2", false, ["deriveBits"]);
      const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: bytes(metadata.salt), iterations: metadata.iterations }, material, 512));
      const key = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["decrypt"]); bits.fill(0);
      const tables = {};
      for (const [name, table] of Object.entries(raw.tables)) {
        if (name === "vaultMeta") continue;
        tables[name] = [];
        for (const row of table.rows) {
          if (row.__paceVault !== 1 || !row.__iv || !row.__ciphertext) throw new Error(`Plaintext row remains in ${name}`);
          const primary = Array.isArray(table.keyPath) ? table.keyPath.map((part) => row[part]) : row[table.keyPath];
          const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(row.__iv), additionalData: enc.encode(JSON.stringify(["pace-vault-row:v1", name, primary])) }, key, bytes(row.__ciphertext));
          tables[name].push(JSON.parse(new TextDecoder().decode(plain)));
        }
      }
      return tables;
    }, { raw, phrase });
  }
  await page.goto(base); await page.getByRole("button", { name: "設定をあとで行う", exact: true }).click();
  await page.locator(".hero-card").waitFor(); await page.evaluate(async () => navigator.serviceWorker.ready); await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  // Every record is fictional; raw seeding gives coverage of all legacy table types.
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open("pace"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const now = "2026-10-02T04:00:00.000Z"; const date = "2026-10-02"; const stamp = { createdAt: now, updatedAt: now };
    const rows = {
      expenses: [{ ...stamp, id: "qa-cash-expense", amount: 432, date, merchant: "FICTIONAL MARKET", description: "", categoryId: "food", subcategoryId: "food-2", paymentMethod: "cash", memo: "fictional cash record", isFixedCost: false }, { ...stamp, id: "qa-card-expense", amount: 6000, date, merchant: "FICTIONAL CARD PURCHASE", description: "", categoryId: "shopping", subcategoryId: "shopping-0", paymentMethod: "creditCard", creditCardId: "qa-card", memo: "fictional card record", isFixedCost: false }],
      cards: [{ ...stamp, id: "qa-card", name: "Fictional card", last4: "0000", closingDay: 30, paymentDay: 10, paymentMonthOffset: 1, openingOutstanding: 800, isActive: true }],
      incomes: [{ ...stamp, id: "qa-income", amount: 20000, date, type: "salary", source: "Fictional salary", memo: "" }],
      cardPayments: [{ ...stamp, id: "qa-card-pay", creditCardId: "qa-card", amount: 100, date, memo: "fictional payment" }],
      debts: [{ ...stamp, id: "qa-debt", lenderName: "Fictional lender", title: "Fictional loan", originalAmount: 75000, openingBalance: 75000, currentBalance: 74900, startedAt: date, plannedMonthlyPayment: 1000, nextPaymentDate: "2026-11-10", note: "fictional", isEstimated: false, cashReceived: false, status: "active" }],
      repayments: [{ id: "qa-repayment", debtId: "qa-debt", amount: 100, date, memo: "fictional" }],
      recurringExpenses: [{ id: "qa-fixed", name: "Fictional subscription", amount: 870, categoryId: "fixed", subcategoryId: "fixed-1", paymentMethod: "bank", frequency: "monthly", dueDay: 20, startDate: "2026-11-01", isActive: true, note: "fictional" }],
      recurringOccurrences: [{ id: "qa-fixed:2026-09", recurringExpenseId: "qa-fixed", dueDate: "2026-09-20", status: "skipped" }],
      savingsGoals: [{ id: "qa-goal", name: "Fictional savings", targetAmount: 20000, openingAmount: 1000, currentAmount: 1300, targetDate: "2027-10-02", monthlyTarget: 300, createdAt: now }],
      savingsContributions: [{ id: "qa-savings", savingsGoalId: "qa-goal", amount: 300, date, memo: "fictional" }],
      budgets: [{ ...stamp, id: "qa-budget", year: 2026, month: 10, totalBudget: 20000, categoryBudgets: { food: 5000 } }],
      merchantRules: [{ normalizedMerchant: "fictionalmarket", categoryId: "food", subcategoryId: "food-2", usageCount: 2, lastUsedAt: now }],
      categories: [{ id: "qa-custom-category", name: "Fictional category", color: "#4488aa", icon: "Circle", subcategories: [{ id: "qa-sub", name: "Fictional item" }] }],
      balanceAdjustments: [{ id: "qa-balance", previousBalance: 50000, newBalance: 51000, difference: 1000, date, memo: "fictional" }],
      dailyCheckIns: [{ date, noSpendingConfirmed: false, confirmedAt: now }],
      favorites: [{ id: "qa-favorite", name: "Fictional lunch", amount: 432, merchant: "FICTIONAL MARKET", categoryId: "food", subcategoryId: "food-2", paymentMethod: "cash" }],
      drafts: [{ id: "expense", value: JSON.stringify({ amount: "690", merchant: "Fictional draft", date, categoryId: "food", subcategoryId: "food-0", paymentMethod: "cash", creditCardId: "", memo: "fictional draft note" }) }],
    };
    try {
      await new Promise((resolve, reject) => {
        const tx = database.transaction([...Object.keys(rows), "settings"], "readwrite");
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
        for (const [name, records] of Object.entries(rows)) for (const row of records) tx.objectStore(name).put(row);
        const get = tx.objectStore("settings").get("main"); get.onsuccess = () => tx.objectStore("settings").put({ ...get.result, openingLiquidBalance: 50000, onboardingCompleted: true, lockAfterSeconds: 300 });
      });
    } finally { database.close(); }
  });
  await page.goto(`${base}#/settings`); await page.getByRole("button", { name: "アプリロック", exact: true }).click();
  await page.getByRole("button", { name: "6桁PIN", exact: true }).click();
  await page.getByLabel("新しい6桁PIN").fill(pin); await page.getByLabel("PINをもう一度").fill(pin);
  await page.getByRole("button", { name: "PINを設定", exact: true }).click(); await page.getByText("現在：6桁PIN", { exact: true }).waitFor();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  const before = await snapshot(); assert.equal(before.tables.expenses.rows.length, 2); assert(before.tables.drafts.rows[0].value.includes("690"));
  release = 1;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.locator(".update-banner").waitFor(); assert.deepEqual(await snapshot(), before);
  await page.locator(".update-banner").getByRole("button", { name: "更新する", exact: true }).click();
  await unlockPin(); // Prove possession of the existing lock before migrating its plaintext data.
  await page.getByLabel("パスフレーズ（12文字以上）").fill(phrase); await page.getByLabel("もう一度入力").fill(phrase);
  await page.getByRole("button", { name: "暗号化して始める", exact: true }).click();
  await unlockPin(); await page.locator(".bottom-nav").waitFor();
  const migrated = await snapshot(); assert(migrated.version > before.version); assert.equal(migrated.tables.vaultMeta.rows.length, 1);
  const logical = await logicalSnapshot(migrated);
  for (const [name, table] of Object.entries(before.tables)) assert.deepEqual(ordered(logical[name], table.keyPath), ordered(table.rows, table.keyPath), `${name} legacy rows must survive migration`);
  assert.deepEqual(migrated.storage, before.storage, "Existing PIN configuration must survive");
  assert.equal(JSON.stringify(migrated.tables).includes("FICTIONAL MARKET"), false); assert.equal(JSON.stringify(migrated.tables).includes("Fictional draft"), false);
  await page.getByRole("button", { name: "支出を追加", exact: true }).click(); assert.equal(await page.getByLabel("支出金額", { exact: true }).inputValue(), "690");
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  const afterEditor = await logicalSnapshot(await snapshot());
  const reopenedDraft = JSON.parse(afterEditor.drafts[0].value);
  for (const [key, value] of Object.entries(JSON.parse(before.tables.drafts.rows[0].value))) assert.equal(reopenedDraft[key], value, `Draft ${key} remains unchanged`);
  await context.setOffline(true); await page.reload(); await unlockCurrent();
  const offline = await logicalSnapshot(await snapshot());
  for (const [name, table] of Object.entries(before.tables)) assert.deepEqual(ordered(offline[name], table.keyPath), ordered(afterEditor[name], table.keyPath), `${name} must survive offline restart`);
  await context.setOffline(false);
  await page.getByRole("link", { name: "設定", exact: true }).click();
  release = 2; await page.getByRole("button", { name: "更新を確認", exact: false }).click();
  await page.getByRole("button", { name: "更新を適用", exact: false }).waitFor();
  await page.getByRole("button", { name: "支出を追加", exact: true }).click();
  await page.getByRole("button", { name: "更新を適用", exact: false }).evaluate((button) => button.click());
  await page.getByText("入力・設定画面を保存して閉じてから、更新してください。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.getByRole("button", { name: "更新を適用", exact: false }).click(); await unlockCurrent();
  const updatedAgain = await logicalSnapshot(await snapshot());
  for (const [name, table] of Object.entries(before.tables)) assert.deepEqual(ordered(updatedAgain[name], table.keyPath), ordered(afterEditor[name], table.keyPath), `${name} must survive encrypted-app update`);
  assert.equal(errors.length, 0); assert.equal(external.length, 0);
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/update-vault-results.json", JSON.stringify({ previous: "1.3.0", current: version, projectBase: "/pace/", legacyPinVerifiedBeforeMigration: true, allLegacyTablesEqualAfterIndependentDecryption: true, plaintextAbsent: true, pinConfigurationPreserved: true, draftPreserved: true, offlineVaultAndPinUnlock: true, encryptedAppUpdatePreservesData: true, updateGuardWhileEditing: true, externalRequests: 0, pageErrors: 0 }, null, 2));
  console.log(`Vault update QA passed: 1.3.0 → ${version}, all legacy records preserved, independent AES-GCM verification, PIN/draft/offline and update guard.`);
  await context.close();
} catch (error) {
  await mkdir("test-results", { recursive: true });
  if (inspectedPage) { await inspectedPage.screenshot({ path: "test-results/update-vault-error.png", fullPage: true }); await writeFile("test-results/update-vault-error.txt", await inspectedPage.locator("body").innerText()); await writeFile("test-results/update-vault-caught-errors.json", JSON.stringify(await inspectedPage.evaluate(() => window.__paceQACaughtErrors), null, 2)); }
  throw error;
} finally { if (browser) await browser.close(); await new Promise((resolve) => server.close(resolve)); }
