import { useEffect, useRef, useState } from "react";
import { Camera, Check, FileImage, LoaderCircle, ScanLine, X } from "lucide-react";
import type { Worker as OCRWorker } from "tesseract.js";
import { Field } from "../components/UI";
import { parseReceiptText, validateReceiptCandidate } from "../domain/receipts";
import type { ReceiptDraftCandidate } from "../domain/receipts";
import { paymentLabels } from "../types";
import type { PaymentMethod } from "../types";

interface EditableReceipt {
  merchant: string;
  amount: string;
  date: string;
  time: string;
  tax: string;
  paymentMethod: PaymentMethod | "";
  products: string;
}
const empty: EditableReceipt = { merchant: "", amount: "", date: "", time: "", tax: "", paymentMethod: "", products: "" };
const MAX_BYTES = 20 * 1024 * 1024;
const allowedMime = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
type OCRRun = { cancel: () => void; worker: OCRWorker | null };

async function receiptCanvas(file: File) {
  let source: ImageBitmap | HTMLImageElement;
  let revoke: (() => void) | null = null;
  try { source = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    const url = URL.createObjectURL(file);
    revoke = () => URL.revokeObjectURL(url);
    try {
      source = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("image")); image.src = url;
      });
    } catch { revoke(); throw new Error("image"); }
  }
  try {
    const width = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
    const height = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
    if (!width || !height || width * height > 50_000_000) throw new Error("image");
    const scale = Math.min(1, 1800 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("image");
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    if ("close" in source) source.close();
    revoke?.();
  }
}

export function ReceiptCapture({ onApply, onBusyChange }: { onApply: (candidate: ReceiptDraftCandidate) => void | Promise<void>; onBusyChange?: (busy: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [review, setReview] = useState(false);
  const [fields, setFields] = useState<EditableReceipt>(empty);
  const [saveImage, setSaveImage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const current = useRef<OCRRun | null>(null);
  const mounted = useRef(true);
  const applyGuard = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; current.current?.cancel(); onBusyChange?.(false); };
  }, []);
  useEffect(() => {
    if (!file) { setPreview(""); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  function choose(selected: File | undefined) {
    if (!selected) return;
    current.current?.cancel();
    setError(""); setReview(false); setSaveImage(false); setFields(empty); setOpen(true);
    const validType = allowedMime.has(selected.type) || (!selected.type && /\.(?:jpe?g|png|webp|heic|heif)$/i.test(selected.name));
    if (!validType || selected.size > MAX_BYTES) {
      setFile(null); setReview(true); setError(validType ? "画像が大きいため読み取れません。小さい画像を選ぶか、下に入力してください。" : "JPEG・PNG・WebPで撮影し直すか、下に入力してください。"); return;
    }
    setFile(selected);
  }
  const update = <K extends keyof EditableReceipt>(key: K, value: EditableReceipt[K]) => setFields((old) => ({ ...old, [key]: value }));
  async function read() {
    if (!file || current.current) return;
    if (typeof BroadcastChannel === "undefined" || typeof WebAssembly === "undefined") { setError("この端末では読み取れません。下に入力してください。"); setReview(true); return; }
    setBusy(true); onBusyChange?.(true); setProgress(0); setStatus("読み取りを準備中"); setError("");
    let cancelled = false;
    let channel: BroadcastChannel | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectCancelled: (reason: Error) => void = () => {};
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    const run: OCRRun = { worker: null, cancel: () => {} };
    run.cancel = () => {
      cancelled = true; channel?.postMessage("cancel"); void run.worker?.terminate(); rejectCancelled(new Error("cancelled"));
    };
    current.current = run;
    const active = () => !cancelled && mounted.current && current.current === run;
    const work = async () => {
      canvas = await receiptCanvas(file);
      if (!active()) { canvas.width = 0; canvas.height = 0; throw new Error("cancelled"); }
      const { createWorker, OEM, PSM } = await import("tesseract.js");
      if (!active()) throw new Error("cancelled");
      const session = crypto.randomUUID();
      channel = new BroadcastChannel(`pace-ocr-${session}`);
      channel.onmessage = (event) => { if (event.data === "ready" && cancelled) channel?.postMessage("cancel"); };
      const base = new URL(`${import.meta.env.BASE_URL}ocr/`, document.baseURI).href;
      run.worker = await createWorker(["jpn", "eng"], OEM.LSTM_ONLY, {
        workerPath: `${base}worker.min.js#${session}`,
        workerBlobURL: false,
        corePath: base.replace(/\/$/, ""),
        langPath: base.replace(/\/$/, ""),
        cacheMethod: "none", gzip: true, legacyCore: false, legacyLang: false,
        logger: (message) => {
          if (!active()) return;
          const value = Math.max(0, Math.min(1, Number(message.progress) || 0));
          if (message.status === "recognizing text") { setStatus("文字を読み取り中"); setProgress(Math.round(25 + value * 75)); }
          else if (message.status === "loading language traineddata") { setStatus("読み取りデータを準備中"); setProgress(Math.round(5 + value * 15)); }
          else { setStatus("読み取りを準備中"); setProgress((old) => Math.max(old, 3)); }
        },
        errorHandler: () => { /* No receipt or engine error payload is logged. */ },
      });
      if (!active()) { await run.worker.terminate(); throw new Error("cancelled"); }
      await run.worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_COLUMN, preserve_interword_spaces: "1", user_defined_dpi: "300", debug_file: "/dev/null" });
      const result = await run.worker.recognize(canvas!, {}, { text: true });
      if (!active()) throw new Error("cancelled");
      const candidate = parseReceiptText(result.data.text);
      setFields({ merchant: candidate.merchant ?? "", amount: candidate.amount === undefined ? "" : String(candidate.amount), date: candidate.date ?? "", time: candidate.time ?? "", tax: candidate.tax === undefined ? "" : String(candidate.tax), paymentMethod: candidate.paymentMethod ?? "", products: candidate.products?.join("\n") ?? "" });
      setReview(true); setProgress(100); setStatus("内容を確認してください");
      if (!result.data.text.trim()) setError("文字が見つかりませんでした。撮影し直すか、下に入力してください。");
    };
    try {
      timer = setTimeout(() => { setError("時間がかかっているため中止しました。撮影し直すか、下に入力してください。"); setReview(true); run.cancel(); }, 60_000);
      await Promise.race([work(), cancellation]);
    } catch {
      if (!cancelled && mounted.current) { setError(navigator.onLine === false ? "読み取りデータをまだ準備できていません。オンラインで一度読み取るか、下に入力してください。" : "読み取れませんでした。HEICの場合はJPEGで撮影し直すか、下に入力してください。"); setReview(true); }
    } finally {
      if (timer) clearTimeout(timer);
      const closingChannel = channel as BroadcastChannel | null;
      closingChannel?.postMessage("cancel");
      await run.worker?.terminate().catch(() => {});
      // Give a newly started worker time to acknowledge cancellation during init.
      if (cancelled && !run.worker) setTimeout(() => closingChannel?.close(), 65_000);
      else closingChannel?.close();
      if (canvas) { (canvas as HTMLCanvasElement).width = 0; (canvas as HTMLCanvasElement).height = 0; }
      if (current.current === run) current.current = null;
      if (mounted.current) { setBusy(false); onBusyChange?.(false); }
    }
  }
  async function apply() {
    if (applyGuard.current) return;
    const candidate: ReceiptDraftCandidate = {
      merchant: fields.merchant.trim().slice(0, 200) || undefined,
      amount: fields.amount.trim() ? Number(fields.amount) : undefined,
      date: fields.date || undefined, time: fields.time || undefined,
      tax: fields.tax.trim() ? Number(fields.tax) : undefined,
      paymentMethod: fields.paymentMethod || undefined,
      products: fields.products.split("\n").map((item) => item.trim()).filter(Boolean).slice(0, 50).map((item) => item.slice(0, 250)),
    };
    const invalid = validateReceiptCandidate(candidate);
    if (invalid || candidate.amount === undefined) { setError(invalid ?? "合計を入力してください。"); return; }
    applyGuard.current = true; setApplying(true); onBusyChange?.(true); setError("");
    try {
      if (saveImage && file) {
        const canvas = await receiptCanvas(file);
        try {
          const image = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("image")), "image/jpeg", 0.85));
          if (image.size > 8 * 1024 * 1024) throw new Error("image");
          // Re-encoding also avoids retaining the camera's EXIF location metadata.
          candidate.imageFile = new File([image], "receipt.jpg", { type: "image/jpeg" });
        } finally { canvas.width = 0; canvas.height = 0; }
      }
      if (!mounted.current) return;
      await onApply(candidate); setOpen(false); setFile(null); setSaveImage(false); setReview(false); setFields(empty);
    }
    catch { setError("反映できませんでした。もう一度お試しください。"); }
    finally { applyGuard.current = false; if (mounted.current) { setApplying(false); onBusyChange?.(false); } }
  }
  return <section className="receipt-capture" style={{ margin: "16px 0" }}>
    <button type="button" className="button button-secondary" style={{ width: "100%" }} onClick={() => { if (open) current.current?.cancel(); setOpen(!open); }} aria-expanded={open}><ScanLine size={18} /> レシートから入力</button>
    {open && <div style={{ paddingTop: 12 }}>
      <input ref={camera} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" hidden onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ""; }} />
      <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" hidden onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ""; }} />
      <div className="button-row"><button type="button" className="button button-secondary" disabled={busy || applying} onClick={() => camera.current?.click()}><Camera size={17} /> 撮影</button><button type="button" className="button button-secondary" disabled={busy || applying} onClick={() => picker.current?.click()}><FileImage size={17} /> 写真を選ぶ</button></div>
      {preview && <img src={preview} alt="選択したレシート" onError={() => { setError("画像を表示できません。JPEGで撮影し直すか、下に入力してください。"); setReview(true); }} style={{ display: "block", width: "100%", maxHeight: 220, objectFit: "contain", borderRadius: 12, background: "var(--soft)" }} />}
      {file && !busy && <button type="button" className="button button-primary" style={{ width: "100%", marginTop: 12 }} disabled={applying} onClick={() => void read()}><ScanLine size={18} /> {review ? "もう一度読み取る" : "読み取る"}</button>}
      {busy && <div role="status" aria-live="polite"><p className="hint"><LoaderCircle size={16} /> {status} {progress}%</p><progress value={progress} max={100} aria-label="レシート読み取りの進み具合" style={{ width: "100%" }} /><button type="button" className="button button-secondary" onClick={() => { current.current?.cancel(); setStatus("中止しました"); setReview(true); }}><X size={17} /> 中止</button></div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!busy && !review && <button type="button" className="text-button" onClick={() => { setReview(true); setError(""); }}>手入力する</button>}
      {review && !busy && <div>
        <p className="hint">確認して、支出の入力に反映</p>
        <Field label="お店"><input value={fields.merchant} maxLength={200} onChange={(event) => update("merchant", event.target.value)} autoComplete="off" /></Field>
        <div className="form-grid"><Field label="合計（円）"><input value={fields.amount} type="text" inputMode="numeric" onChange={(event) => update("amount", event.target.value)} autoComplete="off" /></Field><Field label="税額（任意）"><input value={fields.tax} type="text" inputMode="numeric" onChange={(event) => update("tax", event.target.value)} autoComplete="off" /></Field><Field label="日付"><input type="date" value={fields.date} onChange={(event) => update("date", event.target.value)} /></Field><Field label="時刻（任意）"><input type="time" value={fields.time} onChange={(event) => update("time", event.target.value)} /></Field></div>
        <Field label="支払い方法"><select value={fields.paymentMethod} onChange={(event) => update("paymentMethod", event.target.value as PaymentMethod | "")}><option value="">選ぶ</option>{Object.entries(paymentLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
        <details><summary className="hint">商品名（任意）</summary><Field label="商品名・1行に1つ"><textarea value={fields.products} maxLength={12_500} onChange={(event) => update("products", event.target.value)} /></Field></details>
        {file && <label className="check-field"><input type="checkbox" checked={saveImage} onChange={(event) => setSaveImage(event.target.checked)} /> レシート画像も端末内に保存</label>}
        <button type="button" className="button button-primary" style={{ width: "100%" }} disabled={applying} onClick={() => void apply()}>{applying ? <LoaderCircle size={18} /> : <Check size={18} />} 入力に反映</button>
      </div>}
      <p className="hint">画像は外部へ送信しません。初回は読み取りデータの準備が必要です。</p>
    </div>}
  </section>;
}
