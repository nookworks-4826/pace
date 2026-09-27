import { chromium } from "playwright";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
const baseURL = (
  process.env.PACE_QA_BASE_URL || "http://127.0.0.1:5173/"
).replace(/\/$/, "");
await fs.mkdir("test-results", { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const errors = [],
  overflows = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await fs.mkdir("test-results", { recursive: true });
await fs.mkdir("test-results/screenshots", { recursive: true });
await page.goto(baseURL + "/");
await page.locator(".onboarding").waitFor();
await page.evaluate(async () => {
  const { db, updateSettings } = await import("/src/db/index.ts");
  const { todayJST } = await import("/src/domain/dates.ts");
  const today = todayJST(),
    month = today.slice(0, 7),
    at = month + "-01T00:00:00+09:00";
  const stamp = (id) => ({ id, createdAt: at, updatedAt: at });
  await updateSettings({
    onboardingCompleted: true,
    openingLiquidBalance: 30000,
    colorMode: "light",
    helpDismissed: true,
    setupReviewed: ["balance", "salary", "cards", "debts", "recurring"],
    salarySchedule: { payday: 25, expectedAmount: 78000, variableIncome: true },
  });
  await db.cards.add({
    ...stamp("test-visa"),
    name: "Visa",
    last4: "1234",
    closingDay: 15,
    paymentDay: 27,
    paymentMonthOffset: 1,
    openingOutstanding: 6400,
    isActive: true,
  });
  await db.incomes.add({
    ...stamp("test-salary"),
    amount: 62000,
    date: month + "-05",
    source: "アルバイト（検証用）",
    memo: "",
    type: "salary",
  });
  await db.debts.add({
    ...stamp("test-debt"),
    lenderName: "親",
    title: "渡航費",
    originalAmount: 70000,
    openingBalance: 50000,
    currentBalance: 50000,
    startedAt: month + "-01",
    plannedMonthlyPayment: 5000,
    nextPaymentDate: month + "-27",
    note: "架空の検証データ",
    isEstimated: false,
    cashReceived: false,
    status: "active",
  });
  await db.savingsGoals.add({
    id: "test-goal",
    name: "次の旅へ",
    targetAmount: 100000,
    openingAmount: 24000,
    currentAmount: 24000,
    targetDate: "2027-03-01",
    monthlyTarget: 3000,
    createdAt: at,
  });
  await db.recurringExpenses.bulkAdd([
    {
      id: "test-fixed",
      name: "Netflix",
      amount: 890,
      categoryId: "fixed",
      subcategoryId: "fixed-1",
      paymentMethod: "creditCard",
      creditCardId: "test-visa",
      frequency: "monthly",
      dueDay: 27,
      startDate: month + "-01",
      isActive: true,
      note: "",
    },
    {
      id: "test-mobile",
      name: "スマホ",
      amount: 1900,
      categoryId: "fixed",
      subcategoryId: "fixed-0",
      paymentMethod: "bank",
      frequency: "monthly",
      dueDay: 28,
      startDate: month + "-01",
      isActive: true,
      note: "",
    },
  ]);
  await db.budgets.add({
    ...stamp("test-budget"),
    year: Number(today.slice(0, 4)),
    month: Number(today.slice(5, 7)),
    totalBudget: 45000,
    categoryBudgets: { food: 24000 },
  });
  const shops = [
    ["サイゼリヤ", "food", "food-0", 1280],
    ["セブンイレブン", "food", "food-1", 560],
    ["JR", "transport", "transport-0", 420],
    ["スターバックス", "food", "food-3", 680],
    ["映画", "entertainment", "entertainment-1", 1800],
    ["Amazon", "shopping", "shopping-4", 2980],
  ];
  const records = Array.from({ length: Number(today.slice(8)) - 1 }, (_, i) => {
    const s = shops[i % shops.length];
    const credit = i % 4 === 0;
    return {
      ...stamp("test-e-" + i),
      date: month + "-" + String(i + 1).padStart(2, "0"),
      merchant: s[0],
      description: "",
      amount: s[3],
      categoryId: s[1],
      subcategoryId: s[2],
      paymentMethod: credit ? "creditCard" : "cash",
      creditCardId: credit ? "test-visa" : undefined,
      memo: "架空の検証データ",
      isFixedCost: false,
    };
  });
  records.push({
    ...stamp("test-today"),
    date: today,
    merchant: "スターバックス",
    description: "",
    amount: 680,
    categoryId: "food",
    subcategoryId: "food-3",
    paymentMethod: "cash",
    memo: "",
    isFixedCost: false,
  });
  await db.expenses.bulkAdd(records);
});
await page.locator(".hero-card").waitFor();
for (const width of [375, 390, 430, 768, 1024]) {
  await page.setViewportSize({ width, height: width >= 768 ? 1024 : 844 });
  for (const route of [
    "/",
    "/history",
    "/analytics",
    "/manage/cards",
    "/manage/debts",
    "/manage/savings",
    "/manage/recurring",
    "/settings",
  ]) {
    await page.goto(baseURL + "/#" + route);
    await page.locator(".page").waitFor();
    if (route === "/analytics")
      await page.locator(".analytics-section").first().waitFor();
    const overflow = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      offenders: [...document.querySelectorAll("body *")]
        .filter(
          (e) =>
            e.getBoundingClientRect().right > innerWidth + 1 &&
            getComputedStyle(e).position !== "fixed",
        )
        .slice(0, 5)
        .map((e) => e.className),
    }));
    if (overflow.scroll > width) overflows.push({ width, route, ...overflow });
    if (
      width === 390 &&
      [
        "/",
        "/history",
        "/analytics",
        "/manage/cards",
        "/manage/debts",
        "/manage/savings",
      ].includes(route)
    )
      await page.screenshot({
        path: `test-results/screenshots/${route === "/" ? "home" : route.replaceAll("/", "-").slice(1)}-390.png`,
        animations: "disabled",
        fullPage: route === "/analytics",
      });
  }
  checks.push(`${width}px:8画面横スクロール検査`);
}
await page.setViewportSize({ width: 375, height: 812 });
await page.goto(baseURL + "/#/");
await page.getByRole("button", { name: "支出を追加", exact: true }).click();
await page.getByLabel("クイック入力").fill("セブン 560");
await page.getByRole("button", { name: "反映", exact: true }).click();
await page.locator(".sheet").evaluate((e) => {
  e.scrollTop = 0;
});
await page.screenshot({
  path: "test-results/screenshots/expense-375.png",
  animations: "disabled",
});
await page.getByRole("button", { name: "閉じる", exact: true }).click();
await page.getByRole("button", { name: "支出を追加", exact: true }).click();
if ((await page.getByLabel("支出金額", { exact: true }).inputValue()) !== "560")
  errors.push("下書き保持エラー");
await page.getByRole("button", { name: "閉じる", exact: true }).click();
checks.push("375px:支出シート・クイック入力・下書き保持");
await page.evaluate(async () => {
  const { updateSettings } = await import("/src/db/index.ts");
  await updateSettings({ colorMode: "dark" });
});
await page.goto(baseURL + "/#/");
await page.screenshot({
  path: "test-results/screenshots/home-dark-375.png",
  animations: "disabled",
});
await page.goto(baseURL + "/#/analytics");
await page.locator(".analytics-section").first().waitFor();
await page.screenshot({
  path: "test-results/analytics-dark.png",
  animations: "disabled",
  fullPage: true,
});
checks.push("ダークモード:ホーム・分析");
await page.evaluate(async () => {
  const { db, updateSettings } = await import("/src/db/index.ts");
  const { todayJST } = await import("/src/domain/dates.ts");
  const at = new Date().toISOString();
  await updateSettings({ colorMode: "light" });
  await db.expenses.add({
    id: "test-large",
    amount: 999999999999,
    date: todayJST(),
    merchant:
      "とても長い店舗名の表示を確認するための架空のお店・新宿駅南口支店",
    description: "",
    categoryId: "shopping",
    subcategoryId: "shopping-4",
    paymentMethod: "cash",
    memo: "検証データ",
    isFixedCost: false,
    createdAt: at,
    updatedAt: at,
  });
});
await page.goto(baseURL + "/#/");
await page.screenshot({
  path: "test-results/negative-large.png",
  animations: "disabled",
});
await page.goto(baseURL + "/#/history");
await page.screenshot({
  path: "test-results/history-long.png",
  animations: "disabled",
});
const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth > innerWidth,
);
if (overflow) overflows.push({ route: "large-long", width: 375 });
checks.push("不足・12桁金額・長い店舗名");
await page.evaluate(async () => {
  const { db } = await import("/src/db/index.ts");
  await db.expenses.delete("test-large");
  const rows = await db.expenses.toArray();
  const template = rows[0];
  await db.expenses.bulkAdd(
    Array.from({ length: 5000 }, (_, i) => ({
      ...template,
      id: "load-" + i,
      merchant: "負荷検証用店舗 " + i,
      amount: 1,
    })),
  );
});
const start = Date.now();
await page.goto(baseURL + "/#/history");
await page.waitForFunction(
  () => document.querySelectorAll(".transaction-row").length === 60,
);
const rowCount = await page.locator(".transaction-row").count();
checks.push(`5,024件:最初のDOM${rowCount}件、遷移${Date.now() - start}ms`);
await page.evaluate(async () => {
  const { db, updateSettings } = await import("/src/db/index.ts");
  await updateSettings({ openingLiquidBalance: 999999999999 });
  await db.budgets.clear();
});
await page.goto(baseURL + "/#/");
await page.waitForFunction(
  () =>
    Number(
      document.querySelector(".hero-amount")?.textContent?.replace(/\D/g, ""),
    ) > 100000000000,
);
if (
  await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
) {
  overflows.push({ route: "large-positive", width: 375 });
}
checks.push("12桁の正の残高・今日の目安も横スクロールなし");
await fs.writeFile(
  "test-results/visual-results.json",
  JSON.stringify({ checks, errors, overflows }, null, 2),
);
console.log(JSON.stringify({ checks, errors, overflows }, null, 2));
await browser.close();
assert.deepEqual(errors, [], "ブラウザエラーがないこと");
assert.deepEqual(overflows, [], "横スクロールがないこと");
