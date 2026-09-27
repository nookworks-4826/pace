import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
const svg = await readFile("public/icon.svg", "utf8");
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  headless: true,
});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [name, size, maskable] of [
    ["icon-sunny-192.png", 192, false],
    ["icon-sunny-512.png", 512, false],
    ["icon-sunny-maskable.png", 512, true],
    ["apple-touch-icon-sunny.png", 180, true],
  ]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;width:100%;height:100%;background:#ffdb67}svg{width:100%;height:100%;display:block}</style>${maskable ? svg.replace('rx="112"', 'rx="0"') : svg}`,
    );
    await page.screenshot({ path: `public/${name}` });
  }
} finally {
  await browser.close();
}
