/** Owns a fresh local server and fictional browser profiles for the existing UI checks. */
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startQaServer } from "./qa-vite-support.mjs";

const previousBaseURL = process.env.PACE_QA_BASE_URL;
const previousCwd = process.cwd();
const smoke = process.argv.includes("--smoke");
const qa = await startQaServer("ui-suite");
try {
  process.chdir(qa.root);
  process.env.PACE_QA_BASE_URL = qa.baseURL;
  if (smoke) {
    const { chromium } = await import("playwright");
    const { installVaultSupport } = await import("./qa-vault-support.mjs");
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      headless: true,
    });
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        locale: "ja-JP",
        timezoneId: "Asia/Tokyo",
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      const errors = [],
        external = [];
      page.on("pageerror", (error) => errors.push(error.message));
      context.on("request", (request) => {
        if (
          /^https?:/.test(request.url()) &&
          !request.url().startsWith(qa.baseURL)
        )
          external.push(request.url());
      });
      installVaultSupport(page);
      await page.goto(qa.baseURL);
      await page
        .getByRole("button", { name: "設定をあとで行う", exact: true })
        .click();
      await page.locator(".bottom-nav").waitFor();
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      await mkdir("test-results", { recursive: true });
      await writeFile(
        "test-results/ui-suite-smoke.json",
        JSON.stringify(
          {
            passed: true,
            actualVaultGate: true,
            isolatedDependencyCache: true,
            pageErrors: 0,
            externalRequests: 0,
          },
          null,
          2,
        ),
      );
    } finally {
      await browser.close();
    }
  } else {
    for (const script of ["qa-flows.mjs", "qa-layout.mjs", "qa-webauthn.mjs"]) {
      console.log(`UI QA: ${script}`);
      await import(new URL(script, import.meta.url).href);
    }
  }
} finally {
  if (previousBaseURL === undefined) delete process.env.PACE_QA_BASE_URL;
  else process.env.PACE_QA_BASE_URL = previousBaseURL;
  process.chdir(previousCwd);
  await qa.close();
}
await assert.rejects(access(qa.cacheDir), (error) => error.code === "ENOENT");
console.log(
  smoke
    ? "UI suite smoke passed; temporary dependency cache removed."
    : "UI suite passed; temporary dependency cache removed.",
);
