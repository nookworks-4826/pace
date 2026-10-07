import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Pinned npm packages are the source. No CDN request happens in this build step.
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(app, "public/ocr");
await mkdir(output, { recursive: true });
const variants = ["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"];
for (const filename of variants) await copyFile(resolve(app, "node_modules/tesseract.js-core", filename), resolve(output, filename));
for (const language of ["jpn", "eng"]) await copyFile(resolve(app, "node_modules/@tesseract.js-data", language, "4.0.0_best_int", `${language}.traineddata.gz`), resolve(output, `${language}.traineddata.gz`));

// createWorker resolves only after initialization. This local entry can close even
// during model loading; its one-use fragment never enters the HTTP/cache URL.
const workerSource = await readFile(resolve(app, "node_modules/tesseract.js/dist/worker.min.js"), "utf8");
const lifecycle = `
(() => {
  for (const name of ["log", "warn", "error", "info", "debug"]) console[name] = () => {};
  const local = (value) => {
    const url = new URL(value, self.location.href);
    if (url.origin !== self.location.origin) throw new Error("External OCR resources are disabled");
    return url.href;
  };
  const importLocal = self.importScripts.bind(self);
  self.importScripts = (...urls) => importLocal(...urls.map(local));
  const fetchLocal = self.fetch.bind(self);
  self.fetch = (input, init) => fetchLocal(local(input instanceof Request ? input.url : input), init);
  const session = self.location.hash.slice(1);
  if (!/^[a-f0-9-]{36}$/.test(session) || typeof BroadcastChannel === "undefined") { self.close(); return; }
  const channel = new BroadcastChannel("pace-ocr-" + session);
  const stop = () => { channel.close(); self.close(); };
  let deadline;
  const renew = () => {clearTimeout(deadline); deadline=setTimeout(stop, 80000);};
  channel.onmessage = (event) => { if (event.data === "cancel") stop(); else if(event.data === "keepalive") renew(); };
  channel.postMessage("ready");
  renew();
})();
`;
await writeFile(resolve(output, "worker.min.js"), lifecycle + workerSource);
const coreLicense = await readFile(resolve(app, "node_modules/tesseract.js-core/LICENSE"), "utf8");
await writeFile(resolve(output, "NOTICE.txt"), `Tesseract.js 7.0.0 and Tesseract.js-core 7.0.0: Apache-2.0.\nLanguage data: @tesseract.js-data/jpn 1.0.0 and eng 1.0.0; Tesseract trained data.\nSources: https://github.com/naptha/tesseract.js and https://github.com/naptha/tessdata\n\n${coreLicense}`);
console.log("Prepared 7 same-origin OCR assets (LSTM, SIMD and relaxed SIMD).");
