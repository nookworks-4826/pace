import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// Only an isolated browser profile with fictional records is used.
const current = path.resolve("dist");
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const previous = path.resolve(process.env.PACE_QA_PREVIOUS_DIST || "dist");
await readFile(path.join(current, "sw.js"));
await readFile(path.join(previous, "sw.js"));
let release = 0;
let failUpdate = false;
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (!url.pathname.startsWith("/pace/")) {
      response.writeHead(404).end();
      return;
    }
    const relative = decodeURIComponent(url.pathname.slice(6)) || "index.html";
    const root = release === 0 ? previous : current;
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    if (relative === "sw.js" && failUpdate) {
      response.writeHead(503).end();
      return;
    }
    let contents = await readFile(target);
    // Change the SW bytes to exercise later releases without altering application data.
    if (relative === "sw.js")
      contents = Buffer.concat([
        contents,
        Buffer.from(`\n// QA release ${release}\n`),
      ]);
    response.writeHead(200, {
      "Content-Type": mime[path.extname(target)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(contents);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://localhost:${server.address().port}/pace/`;
let browser;
const results = [];
try {
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
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors = [];
  const externalRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  context.on("request", (request) => {
    if (!request.url().startsWith(base) && !request.url().startsWith("data:"))
      externalRequests.push(request.url());
  });
  const go = async (route) => {
    await page.goto(`${base}#${route}`);
    await page.locator(".bottom-nav").waitFor();
  };
  const close = async () => {
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "閉じる", exact: true })
      .click();
  };
  const save = async () => {
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存する", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  };
  const snapshot = (target = page) =>
    target.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("pace");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const names = [...db.objectStoreNames];
        const tx = db.transaction(names, "readonly");
        const tables = await Promise.all(
          names.map(
            (name) =>
              new Promise((resolve, reject) => {
                const request = tx.objectStore(name).getAll();
                request.onsuccess = () => resolve([name, request.result]);
                request.onerror = () => reject(request.error);
              }),
          ),
        );
        return {
          version: db.version,
          tables: Object.fromEntries(tables),
          storage: Object.fromEntries(
            Object.keys(localStorage)
              .sort()
              .map((key) => [key, localStorage.getItem(key)]),
          ),
        };
      } finally {
        db.close();
      }
    });
  const unlock = async () => {
    await page.getByLabel("6桁のPIN", { exact: true }).fill("926417");
    await page
      .getByRole("button", { name: "ロックを解除", exact: true })
      .click();
    await page.locator(".bottom-nav").waitFor();
  };
  await page.goto(base);
  await page.getByRole("button", { name: "設定をあとで行う" }).click();
  await page.locator(".hero-card").waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page
    .getByRole("button", { name: "現在残高を入力する", exact: true })
    .click();
  await page.getByLabel("実際の銀行＋現金残高").fill("30000");
  await save();
  await go("/manage/cards");
  await page.getByRole("button", { name: "最初のカードを追加" }).click();
  await page.getByLabel("カード名", { exact: true }).fill("検証用カード");
  await page.getByLabel("記録開始前からのカード未払い").fill("0");
  await save();
  for (const [amount, merchant, credit] of [
    [1280, "検証用の昼食", false],
    [5000, "検証用のカード購入", true],
  ]) {
    await page.getByRole("button", { name: "支出を追加", exact: true }).click();
    await page.getByLabel("支出金額", { exact: true }).fill(String(amount));
    await page.getByLabel("店名・内容", { exact: true }).fill(merchant);
    if (credit)
      await page.getByRole("button", { name: "カード", exact: true }).click();
    await page.getByRole("button", { name: "記録する", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }
  await go("/settings");
  await page.getByRole("button", { name: "アプリロック", exact: true }).click();
  await page.getByRole("button", { name: "6桁PIN", exact: true }).click();
  await page.getByLabel("新しい6桁PIN").fill("926417");
  await page.getByLabel("PINをもう一度").fill("926417");
  await page.getByRole("button", { name: "PINを設定", exact: true }).click();
  await page.getByText("現在：6桁PIN").waitFor();
  await close();
  await page.getByRole("button", { name: "支出を追加", exact: true }).click();
  await page.getByLabel("支出金額", { exact: true }).fill("690");
  await page
    .getByLabel("店名・内容", { exact: true })
    .fill("更新後に確認する下書き");
  await close();
  const before = await snapshot();
  assert.equal(before.tables.expenses.length, 2);
  assert.equal(before.tables.cards.length, 1);
  assert(before.tables.drafts[0].value.includes("690"));
  release = 1;
  await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistration()).update(),
  );
  await page.locator(".update-banner").waitFor();
  assert.deepEqual(await snapshot(), before);
  await page
    .locator(".update-banner")
    .getByRole("button", { name: "更新する", exact: true })
    .click();
  await unlock();
  await page
    .getByText(`現在のバージョン ${version}`, { exact: true })
    .waitFor();
  assert.deepEqual(await snapshot(), before);
  results.push(`既存版→${version}、全IndexedDBテーブル・PIN設定・下書きが一致`);
  await page.getByRole("button", { name: "更新を確認", exact: false }).click();
  await page
    .getByText("この公開先で配信中の最新版です。", { exact: true })
    .waitFor();
  results.push("手動確認で最新版を表示");
  for (const width of [375, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${width}pxで横スクロールなし`,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await mkdir("test-results/screenshots", { recursive: true });
  await page.screenshot({
    path: "test-results/screenshots/settings-update-390.png",
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: "test-results/screenshots/settings-update-dark-390.png",
    fullPage: true,
  });
  results.push("375/390/430/768px、設定更新欄の横スクロールなし");
  await context.setOffline(true);
  await page.getByRole("button", { name: "更新を確認", exact: false }).click();
  await page
    .getByText(
      "通信できるときに更新を確認できます。記録はそのまま続けられます。",
      { exact: true },
    )
    .waitFor();
  await page.reload();
  await unlock();
  assert.deepEqual(await snapshot(), before);
  results.push("更新後もオフライン再起動・PIN解除・データ保持");
  await context.setOffline(false);
  failUpdate = true;
  await page.getByRole("button", { name: "更新を確認", exact: false }).click();
  await page
    .getByText(
      "更新を確認・適用できませんでした。通信状態を確認して、もう一度お試しください。",
      { exact: true },
    )
    .waitFor();
  assert.deepEqual(await snapshot(), before);
  failUpdate = false;
  results.push("更新サーバーエラーを表示、記録は保持");
  release = 2;
  await page.getByRole("button", { name: "更新を確認", exact: false }).click();
  await page
    .getByRole("button", { name: "更新を適用", exact: false })
    .waitFor();
  await page
    .getByRole("button", { name: "更新を後で行う", exact: true })
    .click();
  await page
    .getByRole("button", { name: "更新を適用", exact: false })
    .waitFor();
  await page.getByRole("button", { name: "支出を追加", exact: true }).click();
  assert.equal(
    await page.getByLabel("支出金額", { exact: true }).inputValue(),
    "690",
  );
  // Programmatic click checks the handler even though the modal blocks pointer access.
  await page
    .getByRole("button", { name: "更新を適用", exact: false })
    .evaluate((button) => button.click());
  await page
    .getByText("入力・設定画面を保存して閉じてから、更新してください。", {
      exact: true,
    })
    .waitFor();
  await page.getByRole("dialog").waitFor();
  results.push("更新の延期後も設定から適用可能、入力中の更新は保留");
  await close();
  await page.getByRole("button", { name: "更新を適用", exact: false }).click();
  await unlock();
  assert.deepEqual(await snapshot(), before);
  await page.getByRole("link", { name: "ホーム", exact: true }).click();
  await page.getByText("￥23,720", { exact: true }).first().waitFor();
  results.push("2回目の更新後も残高・カード未払いを含む今使っていい金額が一致");
  const second = await context.newPage();
  second.on("pageerror", (error) => errors.push(error.message));
  await second.goto(`${base}#/settings`);
  await second.getByLabel("6桁のPIN", { exact: true }).fill("926417");
  await second
    .getByRole("button", { name: "ロックを解除", exact: true })
    .click();
  await second.getByRole("button", { name: "支出を追加", exact: true }).click();
  await second.getByLabel("支出金額", { exact: true }).fill("690");
  await go("/settings");
  release = 3;
  await page.getByRole("button", { name: "更新を確認", exact: false }).click();
  await page.getByRole("button", { name: "更新を適用", exact: false }).click();
  await unlock();
  await second.getByRole("dialog").waitFor();
  assert.equal(
    await second.getByLabel("支出金額", { exact: true }).inputValue(),
    "690",
  );
  await second
    .getByRole("dialog")
    .getByRole("button", { name: "閉じる", exact: true })
    .click();
  await second
    .getByRole("button", { name: "更新を適用", exact: false })
    .click();
  await second.getByLabel("6桁のPIN", { exact: true }).fill("926417");
  await second
    .getByRole("button", { name: "ロックを解除", exact: true })
    .click();
  await second.locator(".bottom-nav").waitFor();
  assert.deepEqual(await snapshot(), before);
  results.push(
    "別タブで更新しても入力中のタブは再読み込みせず、閉じてから更新可能",
  );
  // Optional: the previous build must already support passkeys (v1.2.0+).
  if (process.env.PACE_QA_UPDATE_PASSKEY === "1") {
    await context.close();
    release = 0;
    const authContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    });
    authContext.on("request", (request) => {
      if (!request.url().startsWith(base) && !request.url().startsWith("data:"))
        externalRequests.push(request.url());
    });
    const authPage = await authContext.newPage();
    authPage.on("pageerror", (error) => errors.push(error.message));
    const cdp = await authContext.newCDPSession(authPage);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await authPage.goto(base);
    await authPage.getByRole("button", { name: "設定をあとで行う" }).click();
    await authPage.evaluate(() =>
      navigator.serviceWorker.ready.then(() => true),
    );
    await authPage.reload();
    await authPage.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
    );
    await authPage.goto(`${base}#/settings`);
    await authPage
      .getByRole("button", { name: "アプリロック", exact: true })
      .click();
    await authPage
      .getByRole("button", { name: "パスキー", exact: true })
      .click();
    await authPage
      .getByRole("button", { name: "パスキーを登録", exact: true })
      .click();
    await authPage.getByText("現在：パスキー", { exact: true }).waitFor();
    await authPage.getByRole("button", { name: "閉じる", exact: true }).click();
    const authBefore = await snapshot(authPage);
    const verifyAuthPreserved = (after, successfulAssertions) => {
      const expected = structuredClone(authBefore);
      const key = "pace:local-lock:v1";
      const lock = JSON.parse(expected.storage[key]);
      // A successful authentication advances the virtual authenticator's replay
      // counter. All keys, identity metadata and financial stores must be equal.
      lock.signCount += successfulAssertions;
      expected.storage[key] = JSON.stringify(lock);
      assert.deepEqual(after, expected);
    };
    release = 4;
    await authPage.evaluate(async () =>
      (await navigator.serviceWorker.getRegistration()).update(),
    );
    await authPage
      .locator(".update-banner")
      .getByRole("button", { name: "更新する", exact: true })
      .click();
    await authPage
      .getByRole("button", { name: "パスキーで解除", exact: true })
      .click();
    await authPage
      .getByText(`現在のバージョン ${version}`, { exact: true })
      .waitFor();
    verifyAuthPreserved(await snapshot(authPage), 1);
    await authContext.setOffline(true);
    await authPage.reload();
    await authPage
      .getByRole("button", { name: "パスキーで解除", exact: true })
      .click();
    await authPage.locator(".bottom-nav").waitFor();
    verifyAuthPreserved(await snapshot(authPage), 2);
    results.push(
      "旧版で登録したパスキーを更新後とオフライン再起動後に使用、全DBとロック設定一致（仮想認証器）",
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  await writeFile(
    "test-results/update-results.json",
    JSON.stringify({ results, errors, externalRequests }, null, 2),
  );
  console.log(JSON.stringify({ results, errors, externalRequests }, null, 2));
} catch (error) {
  await mkdir("test-results", { recursive: true });
  for (const [index, page] of (
    browser?.contexts()[0]?.pages() || []
  ).entries()) {
    await page.screenshot({
      path: `test-results/update-error-${index}.png`,
      fullPage: true,
    });
    console.error(
      "Failed update screen",
      index,
      (await page.locator("body").innerText()).slice(-1800),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
