/** Uses only a disposable local browser profile and fictional financial data. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startQaServer } from "./qa-vite-support.mjs";
import { ensureVaultGate } from "./qa-vault-support.mjs";

// Former connection variables must never re-enable bank linking in this release.
const fictionalBankEnvironment = {
  VITE_MONEYTREE_CLIENT_ID: "fictional-disabled-public-client",
  VITE_MONEYTREE_REDIRECT_URI: "https://pace.example.test/pace/",
  VITE_MONEYTREE_ENVIRONMENT: "production",
  VITE_MONEYTREE_BROWSER_ACCESS_CONFIRMED: "true",
};
const previousBankEnvironment = Object.fromEntries(
  Object.keys(fictionalBankEnvironment).map((key) => [key, process.env[key]]),
);
let qa;
try {
  Object.assign(process.env, fictionalBankEnvironment);
  qa = await startQaServer("settings");
} finally {
  for (const [key, value] of Object.entries(previousBankEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
const resultDir = path.join(qa.root, "test-results");
const screenshotsDir = path.join(resultDir, "screenshots");
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
  reducedMotion: "reduce",
  acceptDownloads: true,
});
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.setDefaultNavigationTimeout(60_000);
const checks = [],
  errors = [],
  foreignRequests = [],
  bankRequests = [],
  overflows = [];
let phase = "initialize";
page.on("pageerror", (error) => errors.push(error.message));
context.on("request", (request) => {
  const url = new URL(request.url());
  if (/\.(?:getmoneytree\.com|moneytree\.jp)$/.test(url.hostname))
    bankRequests.push(`${url.origin}${url.pathname}`);
  if (
    ["http:", "https:"].includes(url.protocol) &&
    url.origin !== new URL(qa.baseURL).origin
  )
    foreignRequests.push(url.origin);
});
// A regression may attempt a provider request; observe and block it locally.
await context.route(/^https?:\/\//, async (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== new URL(qa.baseURL).origin)
    await route.abort("blockedbyclient");
  else await route.continue();
});
const headings = {
  "/settings": "設定",
  "/financial": "口座・カードの管理",
  "/notifications": "通知とリマインダー",
  "/salary": "給料日と予算の期間",
  "/privacy": "プライバシー",
  "/money": "お金の置き場所",
  "/manage/cards": "カード",
};
async function route(target) {
  await page.evaluate((value) => {
    location.hash = "#" + value;
  }, target);
  await expect(
    page.getByRole("heading", {
      name: headings[target.split("?")[0]],
      exact: true,
    }),
  ).toBeVisible();
}
async function data() {
  return page.evaluate(async () => {
    const { readAppData } = await import("/src/db/index.ts");
    return readAppData();
  });
}
async function closed() {
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function mobileFits(details) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth > innerWidth + 2,
    dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).some(
      (dialog) => {
        const rect = dialog.getBoundingClientRect();
        return (
          rect.left < -2 ||
          rect.right > innerWidth + 2 ||
          dialog.scrollWidth > dialog.clientWidth + 2
        );
      },
    ),
  }));
  if (overflow.document || overflow.dialogs)
    overflows.push({ ...details, ...overflow });
}
try {
  await mkdir(screenshotsDir, { recursive: true });
  await page.goto(qa.baseURL, { waitUntil: "domcontentloaded" });
  await ensureVaultGate(page);
  await page.locator(".onboarding").waitFor();
  const today = await page.evaluate(async () => {
    const { updateSettings } = await import("/src/db/index.ts");
    const { todayJST } = await import("/src/domain/dates.ts");
    await updateSettings({
      onboardingCompleted: true,
      openingLiquidBalance: null,
      financialAutomationEnabled: false,
      budgetCycle: { mode: "salary", startDay: 25 },
      salarySchedule: {
        payday: 25,
        expectedAmount: null,
        variableIncome: true,
      },
      colorMode: "light",
      helpDismissed: true,
      setupReviewed: ["balance", "salary", "cards", "debts", "recurring"],
      lockAfterSeconds: 900,
    });
    return todayJST();
  });
  await page.locator(".bottom-nav").waitFor();

  phase = "separated settings entry points";
  console.log(`Settings UI QA: ${phase}`);
  await page
    .getByRole("navigation", { name: "メインナビゲーション" })
    .getByRole("link", { name: "設定", exact: true })
    .click();
  for (const target of [
    "/financial",
    "/notifications",
    "/salary",
    "/privacy",
  ]) {
    const link = page.locator(`.settings-group a[href="#${target}"]`);
    await expect(link).toHaveCount(1);
    await expect(link).toBeVisible();
    await link.click();
    await expect(
      page.getByRole("heading", { name: headings[target], exact: true }),
    ).toBeVisible();
    if (target === "/financial") {
      await expect(
        page.getByRole("heading", { name: "給与のサイクル", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "毎日のリマインダー", exact: true }),
      ).toHaveCount(0);
    }
    await page.getByRole("link", { name: "設定へ戻る", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "設定", exact: true }),
    ).toBeVisible();
  }
  checks.push(
    "Separate settings links reach manual account/card management, notifications, salary period and privacy",
  );

  phase = "salary period persistence";
  console.log(`Settings UI QA: ${phase}`);
  await route("/salary");
  await page.getByLabel(/^予算を区切る日/).selectOption("salary");
  await page.getByLabel(/^毎月の開始日/).fill("25");
  await page.getByLabel(/^毎月の給料日/).fill("27");
  await expect(page.locator(".period-preview strong")).not.toHaveText(
    "開始日を1〜31で入力してください",
  );
  await page.getByRole("button", { name: "設定を保存", exact: true }).click();
  await expect
    .poll(async () => (await data()).settings.budgetCycle)
    .toEqual({ mode: "salary", startDay: 25 });
  await expect
    .poll(async () => (await data()).settings.salarySchedule?.payday)
    .toBe(27);
  checks.push(
    "Budget period and expected payday remain independently editable and saved",
  );

  phase = "manual account and card management";
  console.log(`Settings UI QA: ${phase}`);
  await route("/financial");
  await expect(
    page.getByRole("heading", {
      name: "口座・カードの管理",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /Moneytree|連携を許可|再認証|残高・明細を更新|更新を依頼/,
    }),
  ).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /Moneytree/ })).toHaveCount(
    0,
  );
  const addAccount = page.getByRole("link", {
    name: "口座・残高を登録する",
    exact: true,
  });
  const csv = page.getByRole("link", { name: /カード明細（CSV）を取り込む/ });
  await expect(addAccount).toBeVisible();
  await expect(csv).toBeVisible();
  await addAccount.click();
  const accountDialog = page.getByRole("dialog", {
    name: "お金の置き場所を追加",
    exact: true,
  });
  await expect(accountDialog).toBeVisible();
  await accountDialog
    .getByLabel("名前", { exact: true })
    .fill("架空の設定QA銀行");
  await accountDialog.getByLabel("現在の残高", { exact: true }).fill("25000");
  await accountDialog
    .getByRole("button", { name: "保存する", exact: true })
    .click();
  await closed();
  await expect
    .poll(async () =>
      (await data()).accounts.some(
        (account) =>
          account.name === "架空の設定QA銀行" &&
          account.snapshotBalance === 25000,
      ),
    )
    .toBe(true);
  assert.deepEqual((await data()).settings.budgetCycle, {
    mode: "salary",
    startDay: 25,
  });
  assert.equal((await data()).settings.salarySchedule.payday, 27);
  checks.push(
    "Manual account management opens a usable balance form without bank authorization or changes to the user's budget period",
  );

  phase = "card registration resumes CSV import";
  console.log(`Settings UI QA: ${phase}`);
  await route("/financial");
  await page.getByRole("link", { name: /カード明細（CSV）を取り込む/ }).click();
  await expect(
    page.getByRole("dialog", { name: "カードCSVを取り込む", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "カードを追加して続ける", exact: true })
    .click();
  const cardDialog = page.getByRole("dialog", {
    name: "カードを設定",
    exact: true,
  });
  await expect(cardDialog).toBeVisible();
  await cardDialog
    .getByLabel("カード名", { exact: true })
    .fill("架空の設定QAカード");
  await cardDialog.getByLabel("締め日（31＝月末）", { exact: true }).fill("31");
  await cardDialog.getByLabel("支払日", { exact: true }).fill("10");
  await cardDialog
    .getByRole("button", { name: "保存する", exact: true })
    .click();
  const importDialog = page.getByRole("dialog", {
    name: "カードCSVを取り込む",
    exact: true,
  });
  await expect(importDialog).toBeVisible();
  assert.equal(
    (await data()).cards.filter((card) => card.name === "架空の設定QAカード")
      .length,
    1,
  );
  const fixture = `利用日,利用金額,店名\r\n${today.replaceAll("-", "/")},690,架空の設定QA食堂\r\n`;
  await importDialog.locator('input[type="file"]').setInputFiles({
    name: "fictional-card.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(fixture),
  });
  await importDialog
    .getByRole("button", { name: "内容をプレビュー", exact: true })
    .click();
  await expect(importDialog.getByText(/1件を選択.*690/)).toBeVisible();
  await importDialog
    .getByRole("button", { name: /1件.*690.*取り込む/ })
    .click();
  await closed();
  await expect
    .poll(
      async () =>
        (await data()).expenses.filter(
          (expense) => expense.merchant === "架空の設定QA食堂",
        ).length,
    )
    .toBe(1);
  checks.push(
    "The CSV shortcut adds the first card and resumes file selection, preview and an actual encrypted expense import",
  );

  phase = "CSV duplicate preview";
  console.log(`Settings UI QA: ${phase}`);
  await route("/financial");
  await page.getByRole("link", { name: /カード明細（CSV）を取り込む/ }).click();
  await expect(importDialog).toBeVisible();
  await importDialog.locator('input[type="file"]').setInputFiles({
    name: "fictional-card-repeat.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(fixture),
  });
  await importDialog
    .getByRole("button", { name: "内容をプレビュー", exact: true })
    .click();
  await expect(
    importDialog.getByRole("checkbox", { name: /架空の設定QA食堂.*重複候補/ }),
  ).not.toBeChecked();
  await expect(
    importDialog.getByRole("button", { name: /0件.*取り込む/ }),
  ).toBeDisabled();
  await importDialog
    .getByRole("button", { name: "閉じる", exact: true })
    .click();
  await closed();
  assert.equal(
    (await data()).expenses.filter(
      (expense) => expense.merchant === "架空の設定QA食堂",
    ).length,
    1,
  );
  checks.push(
    "Repeated CSV import leaves duplicate rows unselected and cannot silently duplicate recorded spending",
  );

  phase = "calendar reminder file";
  console.log(`Settings UI QA: ${phase}`);
  await route("/notifications");
  await page
    .getByRole("checkbox", { name: "リマインダーを使う", exact: true })
    .check();
  await page.getByLabel(/^毎日知らせる時刻/).fill("08:35");
  await page.getByLabel(/^知らせ方/).selectOption("calendar");
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "保存してカレンダーに追加", exact: true })
    .click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "pace-daily-reminder.ics");
  const calendar = await readFile(await download.path(), "utf8");
  assert.ok(calendar.includes("RRULE:FREQ=DAILY"));
  assert.ok(calendar.includes("T083500"));
  assert.ok(calendar.includes("SUMMARY:今日のPaceを確認してください"));
  assert.equal(/25000|690|架空|カード|銀行/.test(calendar), false);
  await expect
    .poll(async () => (await data()).settings.reminder?.time)
    .toBe("08:35");
  checks.push(
    "Reminder setup creates one generic daily calendar file during the submit gesture without financial data",
  );

  phase = "privacy action links";
  console.log(`Settings UI QA: ${phase}`);
  for (const [panel, title] of [
    ["security", "アプリロック"],
    ["data", "バックアップと書き出し"],
  ]) {
    await route("/privacy");
    await page.locator(`a[href="#/settings?panel=${panel}"]`).click();
    await expect(
      page.getByRole("dialog", { name: title, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "閉じる", exact: true })
      .click();
    await closed();
    assert.equal(new URL(page.url()).hash.includes("panel="), false);
  }
  checks.push(
    "Privacy actions open the correct settings sheets and closing removes the panel URL",
  );

  phase = "mobile layout";
  console.log(`Settings UI QA: ${phase}`);
  const toastClose = page.getByRole("button", {
    name: "通知を閉じる",
    exact: true,
  });
  if (await toastClose.isVisible()) await toastClose.click();
  for (const mode of ["light", "dark"]) {
    await page.evaluate(async (colorMode) => {
      const { updateSettings } = await import("/src/db/index.ts");
      await updateSettings({ colorMode });
    }, mode);
    await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
    for (const width of [375, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const target of Object.keys(headings)) {
        await route(target);
        await mobileFits({ target, width, mode });
        if (
          width === 390 &&
          [
            "/settings",
            "/financial",
            "/salary",
            "/notifications",
            "/privacy",
          ].includes(target)
        )
          await page.screenshot({
            path: path.join(
              screenshotsDir,
              `settings-${target.slice(1)}-${mode}-${width}.png`,
            ),
            fullPage: true,
          });
      }
      await route("/money?add=account");
      await expect(
        page.getByRole("dialog", { name: "お金の置き場所を追加", exact: true }),
      ).toBeVisible();
      await mobileFits({ target: "/money?add=account", width, mode });
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "閉じる", exact: true })
        .click();
      await closed();
      await route("/manage/cards?import=1");
      await expect(importDialog).toBeVisible();
      await mobileFits({ target: "/manage/cards?import=1", width, mode });
      await importDialog
        .getByRole("button", { name: "閉じる", exact: true })
        .click();
      await closed();
    }
  }
  assert.deepEqual(overflows, []);
  checks.push(
    "Separated settings, account editor and CSV importer fit 375/390px in both light and dark modes",
  );

  phase = "ignored old authorization and stale bank connection";
  console.log(`Settings UI QA: ${phase}`);
  const legacyBankData = await page.evaluate(async () => {
    const { db, updateSettings } = await import("/src/db/index.ts");
    // Existing users may have kept the old automation flag on; even that must
    // never enable the removed bank integration or change saved data.
    await updateSettings({ financialAutomationEnabled: true });
    const stale = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const id = "moneytree:default";
    await db.financialConnections.put({
      id,
      createdAt: stale,
      updatedAt: stale,
      providerId: "moneytree",
      status: "connected",
      institutionIds: [],
      consentedAt: stale,
    });
    await db.providerCredentials.put({
      id,
      value: JSON.stringify({
        sessionNonce: "fictional-preserved-disabled-session",
        accessToken: "fictional-never-send-access-token",
        refreshToken: "fictional-never-send-refresh-token",
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        scope: [
          "guest_read",
          "accounts_read",
          "transactions_read",
          "request_refresh",
        ],
        resourceServer: "jp-api",
      }),
    });
    await db.syncStates.put({
      id,
      lastAttemptAt: stale,
      lastSuccessAt: stale,
      nextRefreshAllowedAt: null,
      status: "idle",
      message: "架空の過去の取得情報",
    });
    return {
      connections: await db.financialConnections.toArray(),
      credentials: await db.providerCredentials.toArray(),
      syncStates: await db.syncStates.toArray(),
    };
  });
  const dataBeforeCallback = await data();
  await page.goto(
    `${qa.baseURL}?code=fictional-invalid-code&state=fictional-invalid-state#/financial`,
  );
  assert.equal(new URL(page.url()).searchParams.has("code"), false);
  assert.equal(new URL(page.url()).searchParams.has("state"), false);
  await ensureVaultGate(page);
  await expect(
    page.getByRole("heading", { name: "口座・カードの管理", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".financial-settings [role=alert]")).toHaveCount(0);
  // An obsolete automatic-sync effect would start a request for this stale fixture.
  await page.waitForTimeout(1000);
  const afterCallback = await data();
  const preservedLegacyBankData = await page.evaluate(async () => {
    const { db } = await import("/src/db/index.ts");
    return {
      connections: await db.financialConnections.toArray(),
      credentials: await db.providerCredentials.toArray(),
      syncStates: await db.syncStates.toArray(),
    };
  });
  assert.deepEqual(preservedLegacyBankData, legacyBankData);
  assert.deepEqual(afterCallback, dataBeforeCallback);
  assert.equal(afterCallback.financialConnections.length, 1);
  assert.equal(
    afterCallback.syncStates.some((state) => state.status === "error"),
    false,
  );
  assert.equal(
    afterCallback.expenses.filter(
      (expense) => expense.merchant === "架空の設定QA食堂",
    ).length,
    1,
  );
  checks.push(
    "Old OAuth parameters are discarded before unlock; formal-looking configuration and preserved stale credentials cannot start bank requests or create errors",
  );

  assert.deepEqual(errors, []);
  assert.deepEqual(bankRequests, []);
  assert.deepEqual(foreignRequests, []);
  await writeFile(
    path.join(resultDir, "settings-results.json"),
    JSON.stringify(
      {
        passed: true,
        checks,
        errors,
        overflows,
        foreignRequests,
        bankRequests,
        fictionalProfileOnly: true,
        automaticBankIntegration: false,
        ignoredConfiguredBankEnvironment: true,
        legacyFinancialDataPreserved: true,
        screenshots: "screenshots/settings-*",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: checks.length,
      pageErrors: 0,
      overflows: 0,
      externalRequests: 0,
      bankRequests: 0,
    }),
  );
} catch (error) {
  await mkdir(resultDir, { recursive: true });
  await writeFile(
    path.join(resultDir, "settings-failure.json"),
    JSON.stringify(
      {
        phase,
        error: String(error),
        checks,
        errors,
        overflows,
        foreignRequests,
        bankRequests,
      },
      null,
      2,
    ),
  );
  await page
    .screenshot({
      path: path.join(resultDir, "settings-failure.png"),
      fullPage: true,
      timeout: 5000,
    })
    .catch(() => {});
  throw error;
} finally {
  await context.close();
  await browser.close();
  await qa.close();
}
