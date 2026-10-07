// Real service-worker update and encrypted storage checks, in a fresh fictional profile.
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { installVaultSupport, QA_VAULT_PHRASE } from "./qa-vault-support.mjs";
const previous = path.resolve(
    process.env.PACE_QA_PREVIOUS_DIST || "../qa-baseline-2.2.0/pace/dist",
  ),
  current = path.resolve("dist");
await fs.readFile(path.join(previous, "sw.js"));
await fs.readFile(path.join(current, "sw.js"));
let release = 0;
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (!pathname.startsWith("/pace/")) throw Error();
    const root = release ? current : previous,
      target = path.resolve(
        root,
        decodeURIComponent(pathname.slice(6)) || "index.html",
      );
    if (!target.startsWith(root + path.sep)) throw Error();
    const content = await fs.readFile(target);
    res
      .writeHead(200, {
        "Content-Type":
          mime[path.extname(target)] || "application/octet-stream",
        "Cache-Control": "no-store",
      })
      .end(content);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://localhost:${server.address().port}/pace/`;
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  headless: true,
});
const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  }),
  page = await context.newPage();
installVaultSupport(page);
const errors = [],
  external = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (/^https?:/.test(r.url()) && !r.url().startsWith(base))
    external.push(r.url());
});
async function snapshot() {
  return page.evaluate(async (phrase) => {
    const database = await new Promise((resolve, reject) => {
      const r = indexedDB.open("pace");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      const names = [...database.objectStoreNames],
        tx = database.transaction(names, "readonly"),
        tables = Object.fromEntries(
          await Promise.all(
            names.map(
              (name) =>
                new Promise((resolve) => {
                  const r = tx.objectStore(name).getAll();
                  r.onsuccess = () =>
                    resolve([
                      name,
                      { keyPath: tx.objectStore(name).keyPath, rows: r.result },
                    ]);
                }),
            ),
          ),
        );
      const metadata = tables.vaultMeta.rows[0],
        bytes = (x) => Uint8Array.from(atob(x), (c) => c.charCodeAt(0)),
        enc = new TextEncoder(),
        material = await crypto.subtle.importKey(
          "raw",
          enc.encode(phrase),
          "PBKDF2",
          false,
          ["deriveBits"],
        );
      const bits = new Uint8Array(
          await crypto.subtle.deriveBits(
            {
              name: "PBKDF2",
              hash: "SHA-256",
              salt: bytes(metadata.salt),
              iterations: metadata.iterations,
            },
            material,
            512,
          ),
        ),
        key = await crypto.subtle.importKey(
          "raw",
          bits.slice(0, 32),
          "AES-GCM",
          false,
          ["decrypt"],
        );
      bits.fill(0);
      const logical = {};
      for (const [name, table] of Object.entries(tables)) {
        if (name === "vaultMeta") continue;
        logical[name] = [];
        for (const row of table.rows) {
          if (row.__paceVault !== 1) throw Error("Plaintext");
          const primary = Array.isArray(table.keyPath)
            ? table.keyPath.map((k) => row[k])
            : row[table.keyPath];
          const p = await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: bytes(row.__iv),
              additionalData: enc.encode(
                JSON.stringify(["pace-vault-row:v1", name, primary]),
              ),
            },
            key,
            bytes(row.__ciphertext),
          );
          logical[name].push(JSON.parse(new TextDecoder().decode(p)));
        }
        logical[name].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        );
      }
      return { version: database.version, logical, raw: tables };
    } finally {
      database.close();
    }
  }, QA_VAULT_PHRASE);
}
try {
  await page.goto(base);
  await page
    .getByRole("button", { name: "設定をあとで行う", exact: true })
    .click();
  await page.locator(".hero-card").waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page
    .getByRole("button", { name: "現在残高を入力する", exact: true })
    .click();
  await page.getByLabel("実際の銀行＋現金残高").fill("30000");
  await page.getByRole("button", { name: "保存する", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "支出を記録", exact: true }).click();
  await page.getByLabel("支出金額", { exact: true }).fill("1280");
  await page.locator(".optional-expense>summary").click();
  await page
    .getByLabel("店名・内容", { exact: true })
    .fill("FICTIONAL UPGRADE CAFE");
  await page.getByRole("button", { name: "記録する", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.evaluate(async () => {
    const c = await caches.open("pace-ocr-static-v7");
    await c.put(
      new URL("ocr/worker.min.js", location.href).href,
      new Response("FICTIONAL OLD STATIC WORKER"),
    );
  });
  const before = await snapshot();
  assert.equal(before.logical.expenses.length, 1);
  assert(!JSON.stringify(before.raw).includes("FICTIONAL UPGRADE CAFE"));
  release = 1;
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration()).update();
  });
  await page.locator(".update-banner").waitFor({ timeout: 30000 });
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator(".update-banner")
    .getByRole("button", { name: "更新する", exact: true })
    .click();
  await page.waitForTimeout(1500);
  await page.reload();
  await page.locator(".hero-card").waitFor();
  const after = await snapshot();
  assert.equal(after.version, before.version + 10);
  for (const [name, rows] of Object.entries(before.logical)) {
    if (name === "settings") {
      for (const row of rows) {
        const current = after.logical.settings.find((s) => s.id === row.id);
        for (const [key, value] of Object.entries(row)) {
          if (key === "practical") continue;
          assert.deepEqual(current[key], value);
        }
      }
    } else assert.deepEqual(after.logical[name], rows, name);
  }
  assert(Array.isArray(after.logical.expenseInbox));
  console.log(
    "✓ 2.2.0 → 2.2.1 preserves every financial table through schema 3 → 4",
  );
  const assets = await page.evaluate(async () => {
    const result = [];
    for (const name of await caches.keys())
      for (const r of await (await caches.open(name)).keys())
        result.push(r.url);
    return result;
  });
  assert(assets.some((x) => x.includes("Analytics")));
  assert(
    !(await page.evaluate(() => caches.keys())).includes("pace-ocr-static-v7"),
    "Old OCR code cache must retire on update",
  );
  assert(
    !assets.some((x) => x.includes("/ocr/")),
    "OCR assets must not load/cache at ordinary startup",
  );
  await context.setOffline(true);
  await page.reload();
  await page.locator(".hero-card").waitFor();
  assert.deepEqual((await snapshot()).logical, after.logical);
  await page.getByRole("button", { name: "支出を記録", exact: true }).click();
  await page.getByLabel("支出金額", { exact: true }).fill("620");
  await page.getByRole("button", { name: "記録する", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.reload();
  assert.equal((await snapshot()).logical.expenses.length, 2);
  console.log("✓ Offline restart, vault unlock, input and persistence");
  for (const route of [
    "history",
    "analytics",
    "manage/cards",
    "manage/incomes",
    "manage/recurring",
    "money",
    "privacy",
    "notifications",
    "settings",
  ]) {
    await page.goto(base + "#/" + route);
    await page.locator(".page").first().waitFor();
  }
  await page
    .getByRole("button", { name: "バックアップと書き出し", exact: false })
    .click();
  await page.getByRole("button", { name: "Excelを作成", exact: true }).click();
  await page.getByText("保存の準備ができました", { exact: true }).waitFor();
  console.log("✓ Offline routes and actual Excel creation");
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await fs.writeFile(
    "test-results/preservation-ui.json",
    JSON.stringify(
      {
        passed: true,
        previous: "2.2.0",
        current: "2.2.1",
        encryptedTablesPreserved: Object.keys(before.logical),
        schemaMigrationPreserved: true,
        offlineRestartAndWrite: true,
        offlineRoutesAndExport: true,
        ocrLazy: true,
        cachedStaticAssets: assets.length,
        externalRequests: external,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
