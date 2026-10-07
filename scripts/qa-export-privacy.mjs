/** Real Chromium export smoke test in an isolated profile with fictional records. */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import ExcelJS from "exceljs";
import { installVaultSupport } from "./qa-vault-support.mjs";
import { startQaServer } from "./qa-vite-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qa = await startQaServer("exports");
let browser;
try {
  const base = qa.baseURL;
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
  });
  const page = await context.newPage();
  const errors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  context.on("request", (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(base))
      external.push(request.url());
  });
  installVaultSupport(page);
  await page.goto(base);
  await page
    .getByRole("button", { name: "設定をあとで行う", exact: true })
    .click();
  await page.locator(".bottom-nav").waitFor();
  await page.evaluate(async () => {
    const { db } = await import("/src/db/index.ts");
    const createdAt = new Date().toISOString();
    const date = new Date(Date.now() + 9 * 60 * 60_000)
      .toISOString()
      .slice(0, 10);
    await db.expenses.put({
      id: "fictional-export-expense",
      createdAt,
      updatedAt: createdAt,
      amount: 850,
      date,
      merchant: "Fictional export cafe",
      description: "",
      categoryId: "food",
      subcategoryId: "food-0",
      paymentMethod: "cash",
      memo: "=FICTIONAL_FORMULA()",
      isFixedCost: false,
    });
  });
  await page.goto(`${base}#/settings`);
  await page.locator(".bottom-nav").waitFor();
  await page.getByRole("button", { name: "バックアップと書き出し" }).click();
  const summaries = [];
  for (const [label, extension] of [
    ["JSONバックアップを作成", ".json"],
    ["CSVを作成", ".csv"],
    ["Excelを作成", ".xlsx"],
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    try {
      await page
        .locator(".download-ready small")
        .filter({ hasText: extension })
        .waitFor({ timeout: 10_000 });
    } catch (error) {
      const diagnostic = await page.evaluate(async () => {
        try {
          const { buildExcel } = await import("/src/domain/backup/index.ts");
          const { readAppData } = await import("/src/db/index.ts");
          const blob = await buildExcel(await readAppData());
          return { bytes: blob.size };
        } catch (failure) {
          return {
            name: failure.name,
            message: failure.message,
            stack: failure.stack,
          };
        }
      });
      console.error(
        JSON.stringify({
          export: extension,
          diagnostic,
          browserErrors: errors,
        }),
      );
      throw error;
    }
    const pending = page.waitForEvent("download", { timeout: 10_000 });
    await page
      .getByRole("button", { name: "ファイルを保存", exact: true })
      .click();
    const download = await pending;
    assert.equal(await download.failure(), null);
    assert.ok(download.suggestedFilename().endsWith(extension));
    const file = await readFile(await download.path());
    assert.ok(file.length > 0);
    if (extension === ".json") {
      const data = JSON.parse(file.toString("utf8"));
      assert.equal(data.schemaVersion, 3);
      assert.equal(data.data.expenses[0].merchant, "Fictional export cafe");
      assert.ok(!file.includes(Buffer.from("providerCredentials")));
      await page.evaluate(async (text) => {
        const { parseBackup } = await import("/src/domain/backup/index.ts");
        const restored = await parseBackup(text);
        if (restored.expenses[0].amount !== 850)
          throw new Error("Backup round trip changed the amount");
      }, file.toString("utf8"));
    }
    if (extension === ".csv")
      assert.ok(file.toString("utf8").includes("'=FICTIONAL_FORMULA()"));
    if (extension === ".xlsx") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(file);
      assert.equal(workbook.worksheets.length, 12);
      assert.equal(workbook.getWorksheet("支出").getCell("D2").value, 850);
      assert.equal(
        workbook.getWorksheet("支出").getCell("I2").type,
        ExcelJS.ValueType.String,
      );
    }
    summaries.push({ extension, bytes: file.length, downloaded: true });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await mkdir(path.join(root, "test-results"), { recursive: true });
  await writeFile(
    path.join(root, "test-results/export-privacy-results.json"),
    JSON.stringify(
      {
        passed: true,
        browser: "Chromium",
        exports: summaries,
        schema3JsonRoundTrip: true,
        excelSheets: 12,
        numericAmountRetained: true,
        formulaCellsAreText: true,
        pageErrors: 0,
        externalRequests: 0,
        scope:
          "Isolated browser context with fictional records; no user profile or account was used.",
      },
      null,
      2,
    ),
  );
  console.log(
    "Export QA passed: JSON, CSV and Excel downloads; schema 3 restore; 12 Excel sheets; no external requests.",
  );
  await context.close();
} finally {
  try {
    await browser?.close();
  } finally {
    await qa.close();
  }
}
