import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

// Isolated contexts contain fictional QA settings only. Android emulation and
// virtual authenticators cannot verify a real Galaxy fingerprint sensor.
const baseURL = process.env.PACE_QA_BASE_URL || "http://localhost:5173/";
const offlineRequested = process.env.PACE_QA_OFFLINE === "1";
const passkeys = process.env.PACE_QA_PASSKEY === "1";
const registerChoice = passkeys ? "パスキー" : "デバイス認証";
const registerLabel = passkeys ? "パスキーを登録" : "デバイス認証を設定";
const unlockLabel = passkeys ? "パスキーで解除" : "デバイスで認証";
const resultPrefix = passkeys ? "passkeys" : "webauthn";
const androidOptions = {
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
  reducedMotion: "reduce",
  userAgent:
    "Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
};
const errors = [];
const offlineProbePath = "__pace_offline_probe__.txt";
let offlineEvidence;
const checks = [];
const layoutChecks = [];
const limitation =
  "Androidの画面・User-Agentとvirtual CTAP2 internal認証器を使ったChromeのブラウザQAです。Galaxy実機の指紋センサー、Samsung Pass、Samsung Internet、実際のiPhone/Safari/Face ID/Touch IDやプロバイダー間の同期を検証した結果ではありません。" +
  (offlineRequested
    ? "端末認証プロバイダーのオフライン動作も実機では未確認です。"
    : "");
let passed = false;
let failure;
await fs.mkdir("test-results", { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  headless: true,
});

function observeErrors(page, scenario) {
  page.on("pageerror", (error) => errors.push(`${scenario}: ${error.message}`));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.location().url?.includes(offlineProbePath)
    )
      errors.push(`${scenario}: ${message.text()}`);
  });
}

async function openLockSettings(page) {
  await page.goto(baseURL);
  await page
    .getByRole("button", { name: "設定をあとで行う", exact: true })
    .click();
  await page.goto(new URL("#/settings", baseURL).href);
  await page.getByRole("button", { name: "アプリロック", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function verifyMobileWidths(page, scenario) {
  for (const width of [360, 375, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 915 });
    const measurements = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      panels: [
        ...document.querySelectorAll(".sheet, .security-settings, .lock-panel"),
      ]
        .filter((element) => element.getBoundingClientRect().height > 0)
        .map((element) => ({
          className: element.className,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          right: element.getBoundingClientRect().right,
          left: element.getBoundingClientRect().left,
        })),
    }));
    assert.ok(
      measurements.document <= measurements.viewport + 1,
      `${scenario}: ${width}pxで横スクロールがないこと`,
    );
    for (const panel of measurements.panels) {
      assert.ok(
        panel.scrollWidth <= panel.clientWidth + 1,
        `${scenario}: ${width}pxの${panel.className}内に横溢れがないこと`,
      );
      assert.ok(
        panel.left >= -1 && panel.right <= measurements.viewport + 1,
        `${scenario}: ${width}pxの${panel.className}が画面内に収まること`,
      );
    }
    layoutChecks.push({ scenario, width, passed: true });
  }
  await page.setViewportSize({ width: 412, height: 915 });
}

try {
  const context = await browser.newContext(androidOptions);
  // Record policy options only, never keys, credential IDs or financial data.
  await context.addInitScript(() => {
    const create = navigator.credentials.create.bind(navigator.credentials);
    const get = navigator.credentials.get.bind(navigator.credentials);
    window.__paceAuthPolicies = [];
    navigator.credentials.create = (options) => {
      window.__paceAuthPolicies.push({
        operation: "create",
        attachment:
          options?.publicKey?.authenticatorSelection?.authenticatorAttachment,
        userVerification:
          options?.publicKey?.authenticatorSelection?.userVerification,
        residentKey: options?.publicKey?.authenticatorSelection?.residentKey,
        requireResidentKey:
          options?.publicKey?.authenticatorSelection?.requireResidentKey,
      });
      if (window.__paceCancelNextRegistration) {
        window.__paceCancelNextRegistration = false;
        return Promise.reject(
          new DOMException("QA cancellation", "NotAllowedError"),
        );
      }
      return create(options);
    };
    navigator.credentials.get = (options) => {
      window.__paceAuthPolicies.push({
        operation: "get",
        userVerification: options?.publicKey?.userVerification,
      });
      return get(options);
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  observeErrors(page, "android-platform");
  const cdp = await context.newCDPSession(page);
  let registrations = 0;
  let assertions = 0;
  cdp.on("WebAuthn.credentialAdded", () => registrations++);
  cdp.on("WebAuthn.credentialAsserted", () => assertions++);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );

  await openLockSettings(page);
  const financialSnapshot = async () =>
    page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("pace");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const names = [...database.objectStoreNames].sort();
        return await Promise.all(
          names.map(
            (name) =>
              new Promise((resolve, reject) => {
                const request = database
                  .transaction(name)
                  .objectStore(name)
                  .getAll();
                request.onsuccess = () => resolve([name, request.result]);
                request.onerror = () => reject(request.error);
              }),
          ),
        );
      } finally {
        database.close();
      }
    });
  const originalData = await financialSnapshot();
  await expect(
    page.getByText("指紋・顔認証などに対応", { exact: true }),
  ).toBeHidden();
  if (passkeys) {
    await page.getByRole("button", { name: "6桁PIN", exact: true }).click();
    await page.getByLabel("新しい6桁PIN", { exact: true }).fill("472915");
    await page.getByLabel("PINをもう一度", { exact: true }).fill("472915");
    await page.getByRole("button", { name: "PINを設定", exact: true }).click();
    await expect(page.getByText("現在：6桁PIN", { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: registerChoice, exact: true }).click();
  if (passkeys) {
    await page.getByLabel("現在のPIN", { exact: true }).fill("000000");
    await page
      .getByRole("button", { name: "現在のロックで確認", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "現在のPINが一致しません",
    );
    assert.equal(registrations, 0);
    await page.getByLabel("現在のPIN", { exact: true }).fill("472915");
    await page
      .getByRole("button", { name: "現在のロックで確認", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: registerLabel, exact: true }),
    ).toBeVisible();
    const originalLock = await page.evaluate(() =>
      localStorage.getItem("pace:local-lock:v1"),
    );
    await page.evaluate(() => {
      window.__paceCancelNextRegistration = true;
    });
    await page
      .getByRole("button", { name: registerLabel, exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "現在のロック設定は変更していません",
    );
    assert.equal(
      await page.evaluate(() => localStorage.getItem("pace:local-lock:v1")),
      originalLock,
    );
    checks.push(
      "誤ったPINでは登録不可。正しいPINで確認後の登録キャンセルでも以前のPIN設定を保持",
    );
  }
  await page.getByRole("button", { name: registerLabel, exact: true }).click();
  await expect(
    page.getByText(`現在：${registerChoice}`, { exact: true }),
  ).toBeVisible();
  await expect.poll(() => registrations).toBe(1);
  const creationPolicies = await page.evaluate(() =>
    window.__paceAuthPolicies.filter((policy) => policy.operation === "create"),
  );
  assert.equal(creationPolicies.length, passkeys ? 2 : 1);
  assert.equal(creationPolicies[0].attachment, "platform");
  assert.equal(creationPolicies[0].userVerification, "required");
  checks.push(
    "Android mobile環境でplatform認証器を登録（userVerification: required）",
  );
  if (passkeys) {
    assert.ok(
      creationPolicies.every(
        (policy) =>
          policy.residentKey === "required" &&
          policy.requireResidentKey === true,
      ),
    );
    const { credentials } = await cdp.send("WebAuthn.getCredentials", {
      authenticatorId,
    });
    assert.equal(credentials.length, 1);
    assert.equal(credentials[0].isResidentCredential, true);
    checks.push(
      "ブラウザの仮想認証器にdiscoverableパスキーが保存されたことを確認",
    );
  }

  const assertionsBeforeTest = assertions;
  await page.getByRole("button", { name: "認証を試す", exact: true }).click();
  await expect(page.locator(".toast[role='status']")).toContainText(
    passkeys ? "パスキーで認証できました" : "デバイス認証を確認できました",
  );
  await expect.poll(() => assertions).toBeGreaterThan(assertionsBeforeTest);
  const testPolicies = await page.evaluate(() =>
    window.__paceAuthPolicies.filter((policy) => policy.operation === "get"),
  );
  assert.ok(testPolicies.length > 0);
  assert.ok(
    testPolicies.every((policy) => policy.userVerification === "required"),
  );
  checks.push("設定内の『認証を試す』で署名検証と成功表示を確認");
  await verifyMobileWidths(page, "galaxy-security-settings");
  const toastClose = page.getByRole("button", {
    name: "通知を閉じる",
    exact: true,
  });
  if (await toastClose.isVisible()) await toastClose.click();
  await page.locator(".sheet").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: passkeys
      ? "test-results/passkeys-settings.png"
      : "test-results/galaxy-security.png",
    fullPage: false,
  });
  if (passkeys) {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({
      path: "test-results/passkeys-settings-dark.png",
      fullPage: false,
    });
    await page.emulateMedia({ colorScheme: "light" });
  }

  await page.reload();
  await expect(page.locator(".lock-screen")).toBeVisible();
  await expect(page.locator(".bottom-nav")).toHaveCount(0);
  if (passkeys)
    await page.screenshot({
      path: "test-results/passkeys-lock.png",
      fullPage: false,
    });
  await verifyMobileWidths(page, "galaxy-lock-screen");
  const assertionsBeforeUnlock = assertions;
  await page.getByRole("button", { name: unlockLabel, exact: true }).click();
  await expect(page.locator(".bottom-nav")).toBeVisible();
  await expect.poll(() => assertions).toBeGreaterThan(assertionsBeforeUnlock);
  const unlockPolicies = await page.evaluate(() =>
    window.__paceAuthPolicies.filter((policy) => policy.operation === "get"),
  );
  assert.ok(unlockPolicies.length > 0);
  assert.ok(
    unlockPolicies.every((policy) => policy.userVerification === "required"),
  );
  checks.push("再読込時はロックされ、platform認証の成功後だけ解除");
  if (offlineRequested) {
    await expect
      .poll(
        () =>
          page.evaluate(async () =>
            Boolean((await navigator.serviceWorker.getRegistration())?.active),
          ),
        {
          timeout: 15000,
          message: "本番PWAのService Workerが有効になること",
        },
      )
      .toBe(true);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.waitForFunction(
      () => Boolean(navigator.serviceWorker.controller),
      undefined,
      { timeout: 15000 },
    );
    await context.setOffline(true);
    const offlineReload = await page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(
      offlineReload?.fromServiceWorker(),
      true,
      "再起動のHTMLをService Workerが返すこと",
    );
    await expect(page.locator(".lock-screen")).toBeVisible();
    await expect(page.locator(".bottom-nav")).toHaveCount(0);
    const assertionsBeforeOfflineUnlock = assertions;
    await page.getByRole("button", { name: unlockLabel, exact: true }).click();
    await expect(page.locator(".bottom-nav")).toBeVisible();
    const blockedUncachedRequest = await page.evaluate(async (path) => {
      try {
        await fetch(new URL(path, location.href), { cache: "no-store" });
        return false;
      } catch {
        return true;
      }
    }, offlineProbePath);
    const navigatorOnline = await page.evaluate(() => navigator.onLine);
    offlineEvidence = {
      controlledReload: offlineReload.fromServiceWorker(),
      blockedUncachedRequest,
      navigatorOnline,
    };
    assert.equal(
      blockedUncachedRequest,
      true,
      "未キャッシュの通信はオフラインのため失敗すること",
    );
    // navigator.onLine is a browser hint, not proof that network requests can succeed.
    if (!navigatorOnline)
      await expect(page.locator(".offline-banner")).toBeVisible();
    await expect
      .poll(() => assertions)
      .toBeGreaterThan(assertionsBeforeOfflineUnlock);
    const offlinePolicies = await page.evaluate(() =>
      window.__paceAuthPolicies.filter((policy) => policy.operation === "get"),
    );
    assert.ok(offlinePolicies.length > 0);
    assert.ok(
      offlinePolicies.every((policy) => policy.userVerification === "required"),
    );
    checks.push("本番PWAをオフラインで再読込し、仮想platform認証器で解除");
    await context.setOffline(false);
  }
  assert.deepEqual(await financialSnapshot(), originalData);
  checks.push("認証の登録・試行・再起動後もIndexedDBの全ストアの内容が一致");
  await context.close();

  const unsupportedContext = await browser.newContext(androidOptions);
  await unsupportedContext.addInitScript(() => {
    Object.defineProperty(
      PublicKeyCredential,
      "isUserVerifyingPlatformAuthenticatorAvailable",
      {
        configurable: true,
        value: async () => false,
      },
    );
  });
  const unsupportedPage = await unsupportedContext.newPage();
  unsupportedPage.setDefaultTimeout(15000);
  observeErrors(unsupportedPage, "android-pin-fallback");
  await openLockSettings(unsupportedPage);
  await expect(
    unsupportedPage.getByRole("button", { name: "デバイス認証", exact: true }),
  ).toBeDisabled();
  await expect(
    unsupportedPage.getByRole("button", { name: "パスキー", exact: true }),
  ).toBeDisabled();
  await expect(
    unsupportedPage.getByText(/利用できる端末の認証が見つかりません/),
  ).toBeVisible();
  await unsupportedPage
    .getByRole("button", { name: "6桁PIN", exact: true })
    .click();
  await unsupportedPage
    .getByLabel("新しい6桁PIN", { exact: true })
    .fill("472915");
  await unsupportedPage
    .getByLabel("PINをもう一度", { exact: true })
    .fill("472915");
  await unsupportedPage
    .getByRole("button", { name: "PINを設定", exact: true })
    .click();
  await expect(
    unsupportedPage.getByText("現在：6桁PIN", { exact: true }),
  ).toBeVisible();
  await verifyMobileWidths(unsupportedPage, "galaxy-pin-fallback");
  const fallbackToastClose = unsupportedPage.getByRole("button", {
    name: "通知を閉じる",
    exact: true,
  });
  if (await fallbackToastClose.isVisible()) await fallbackToastClose.click();
  await unsupportedPage.locator(".sheet").evaluate((element) => {
    element.scrollTop = 0;
  });
  await unsupportedPage.screenshot({
    path: "test-results/galaxy-pin-fallback.png",
    fullPage: false,
  });
  await unsupportedPage.reload();
  await expect(unsupportedPage.locator(".lock-screen")).toBeVisible();
  await expect(unsupportedPage.locator(".bottom-nav")).toHaveCount(0);
  await unsupportedPage.getByLabel("6桁のPIN", { exact: true }).fill("472915");
  await unsupportedPage
    .getByRole("button", { name: "ロックを解除", exact: true })
    .click();
  await expect(unsupportedPage.locator(".bottom-nav")).toBeVisible();
  checks.push(
    "platform認証器を利用できない場合も6桁PINを設定し、再読込後にPINで解除",
  );
  await unsupportedContext.close();
  assert.deepEqual(errors, [], "認証中にpageerror / console errorがないこと");
  passed = true;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  const result = {
    passed,
    passkeys,
    offlineRequested,
    offlineEvidence,
    checks,
    layoutChecks,
    errors,
    limitation,
    ...(failure ? { failure } : {}),
  };
  await fs.writeFile(
    `test-results/${resultPrefix}-results.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}
