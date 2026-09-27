import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

// Run against Vite. Every record lives in an isolated, temporary browser profile.
const base = (process.env.PACE_QA_BASE_URL || "http://127.0.0.1:5173/").replace(
  /\/$/,
  "",
);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  headless: true,
});
const errors = [],
  checks = [];
await fs.mkdir("test-results/screenshots", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator(".pace-journey").waitFor();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  assert.equal(
    await page
      .locator(".journey-path")
      .evaluate((e) => getComputedStyle(e).animationName),
    "none",
  );
  await page.screenshot({
    path: "test-results/screenshots/sunny-onboarding.png",
    animations: "disabled",
  });
  checks.push("初回はOSがダークでもライト表示、動きを減らす設定を尊重");
  await page.getByRole("button", { name: "設定をあとで行う" }).click();
  const open = () =>
    page.getByRole("button", { name: /これ、買ったら？/ }).click();
  const close = () =>
    page.getByRole("button", { name: "閉じる", exact: true }).click();
  const snapshot = () =>
    page.evaluate(async () => {
      const { db } = await import("/src/db/index.ts");
      return Object.fromEntries(
        await Promise.all(
          db.tables.map(async (t) => [t.name, await t.toArray()]),
        ),
      );
    });
  await open();
  await expect(
    page.getByText("現在残高を入力すると試せます。", { exact: true }),
  ).toBeVisible();
  await close();
  await page.evaluate(async () => {
    const { updateSettings, db } = await import("/src/db/index.ts");
    const { todayJST } = await import("/src/domain/dates.ts");
    const { learnMerchantRule } = await import("/src/domain/categorization.ts");
    await updateSettings({
      openingLiquidBalance: 12000,
      helpDismissed: true,
      setupReviewed: ["balance", "salary", "cards", "debts", "recurring"],
    });
    const date = todayJST(),
      now = new Date().toISOString();
    await db.budgets.put({
      id: "qa-budget",
      year: Number(date.slice(0, 4)),
      month: Number(date.slice(5, 7)),
      totalBudget: 4000,
      categoryBudgets: {},
      createdAt: now,
      updatedAt: now,
    });
    await db.merchantRules.bulkPut([
      ...["青空ベーカリー", "駅前ベーカリー", "北町ベーカリー"].map((name) =>
        learnMerchantRule(name, "food", ""),
      ),
      ...["新町フラワー", "森のフラワー", "中央フラワー"].map((name) =>
        learnMerchantRule(name, "shopping", ""),
      ),
    ]);
  });
  await expect(page.locator(".hero-amount")).toContainText("12,000");
  const before = await snapshot();
  await open();
  const input = page.getByLabel("使う予定の金額", { exact: true });
  await input.fill("１,０００");
  await expect(input).toHaveValue("1000");
  await expect(page.locator(".preview-change strong")).toContainText("11,000");
  await expect(page.locator(".preview-next b")).toContainText(
    await page.evaluate(async () => {
      const { todayJST, remainingDaysIncludingToday } =
        await import("/src/domain/dates.ts");
      const days = remainingDaysIncludingToday(todayJST()) - 1;
      return days
        ? new Intl.NumberFormat("ja-JP").format(Math.floor(3000 / days))
        : "—";
    }),
  );
  await page.screenshot({
    path: "test-results/screenshots/sunny-purchase-preview.png",
    animations: "disabled",
  });
  for (const invalid of ["-1", "1.5", "abc", "1e3"]) {
    await input.fill(invalid);
    await expect(page.getByRole("alert")).toContainText("整数");
    await expect(page.locator(".preview-change strong")).toHaveText("—");
  }
  await input.fill("15000");
  await expect(page.locator(".preview-result")).toContainText(
    /[¥￥]3,000 不足/,
  );
  await expect(page.locator(".preview-result")).toContainText(
    /月予算を [¥￥]11,000 超える見込み/,
  );
  for (const width of [360, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await input.fill("999999999999");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  }
  await close();
  assert.deepEqual(
    await snapshot(),
    before,
    "Preview must not write any IndexedDB store",
  );
  checks.push(
    "未知残高・全角数字・不正入力・不足・予算超過・12桁を確認、試算前後で全DBストア一致",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "支出を記録", exact: true }).click();
  await page.getByLabel("店名・内容", { exact: true }).fill("川沿いベーカリー");
  await expect(page.getByText(/記録からの候補/)).toBeVisible();
  await page.getByLabel("支出金額", { exact: true }).fill("850");
  await page.getByRole("button", { name: "記録する", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(async () => {
      const { db } = await import("/src/db/index.ts");
      return (await db.expenses.toArray())[0].categoryId;
    }),
    "food",
  );
  checks.push("未登録店名を記録から分類、候補表示後に本人の保存操作で確定");
  await page.evaluate(async () => {
    const { updateSettings } = await import("/src/db/index.ts");
    await updateSettings({ colorMode: "dark" });
  });
  await page.getByRole("button", { name: "明るい表示にする" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  checks.push("既存のダーク設定から1タップでライト表示、再起動後も保持");
  const contrasts = await page.evaluate(async () => {
    const { updateSettings } = await import("/src/db/index.ts");
    const luminance = (hex) => {
      const rgb = hex
        .trim()
        .replace("#", "")
        .match(/../g)
        .slice(0, 3)
        .map((c) => parseInt(c, 16) / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const results = [];
    for (const theme of ["default", "midnight", "forest", "mono"])
      for (const colorMode of ["light", "dark"]) {
        await updateSettings({ theme, colorMode });
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        );
        const style = getComputedStyle(document.documentElement);
        const v = (name) => luminance(style.getPropertyValue(name));
        for (const [fg, bg] of [
          ["--text", "--surface"],
          ["--muted", "--surface"],
          ["--on-accent", "--accent"],
          ["--hero-ink", "--hero-start"],
          ["--hero-ink", "--hero-end"],
          ["--hero-muted", "--hero-end"],
        ]) {
          results.push({
            theme,
            colorMode,
            fg,
            bg,
            ratio: +ratio(v(fg), v(bg)).toFixed(2),
          });
        }
      }
    return results;
  });
  assert.ok(
    contrasts.every((c) => c.ratio >= 4.5),
    JSON.stringify(contrasts.filter((c) => c.ratio < 4.5)),
  );
  checks.push("4テーマ×明暗の主要テキスト48組でコントラスト4.5:1以上");
  assert.deepEqual(errors, []);
  await fs.writeFile(
    "test-results/refresh-results.json",
    JSON.stringify({ checks, contrasts, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
}
