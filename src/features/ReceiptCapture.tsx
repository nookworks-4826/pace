import { useEffect, useRef, useState } from "react";
import { Camera, Check, FileImage, ScanLine, X, RotateCw } from "lucide-react";
import { APP_VERSION } from "../types";
import type { Worker as OCRWorker } from "tesseract.js";
import { Field } from "../components/UI";
import { usePace } from "../app/context";
import {
  parseReceiptText,
  refineReceiptTotal,
  validateReceiptCandidate,
  type ReceiptDraftCandidate,
} from "../domain/receipts";
import {
  canvasRaster,
  decodeReceipt,
  defaultQuad,
  detectReceipt,
  imageQuality,
  receiptFraming,
  prepareReceipt,
  rasterCanvas,
  rectifyReceipt,
  validQuad,
  type Quad,
} from "../domain/receiptImage";
import { payableAccounts } from "../domain/personalization";
import { suggestLocalCategory } from "../domain/localAssistant";
import { ReceiptCrop } from "./ReceiptCrop";
import { ReceiptCamera } from "./ReceiptCamera";
interface Fields {
  merchant: string;
  amount: string;
  date: string;
  time: string;
  tax: string;
  account: string;
  category: string;
  subcategory: string;
}
const empty: Fields = {
  merchant: "",
  amount: "",
  date: "",
  time: "",
  tax: "",
  account: "",
  category: "uncategorized",
  subcategory: "",
};
type Engine = { worker: OCRWorker; channel: BroadcastChannel };
export function ReceiptCapture({
  onApply,
  onBusyChange,
  onOpenChange,
  startOpen = false,
}: {
  startOpen?: boolean;
  onApply: (candidate: ReceiptDraftCandidate) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const { data, today } = usePace();
  const [open, setOpen] = useState(startOpen),
    [cameraOpen, setCameraOpen] = useState(false),
    [preview, setPreview] = useState(""),
    [quad, setQuad] = useState<Quad>(defaultQuad),
    [confirmed, setConfirmed] = useState(false);
  const [fields, setFields] = useState(empty),
    [candidate, setCandidate] = useState<ReceiptDraftCandidate>({}),
    [review, setReview] = useState(false),
    [saveImage, setSaveImage] = useState(false);
  const [busy, setBusy] = useState(false),
    [applying, setApplying] = useState(false),
    [progress, setProgress] = useState(0),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [warnings, setWarnings] = useState<string[]>([]);
  const source = useRef<HTMLCanvasElement | null>(null),
    cropped = useRef<Blob | null>(null),
    engine = useRef<Engine | null>(null),
    idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef<{ cancel: () => void } | null>(null),
    mounted = useRef(true),
    generation = useRef(0),
    applyGuard = useRef(false),
    camera = useRef<HTMLInputElement>(null),
    picker = useRef<HTMLInputElement>(null),
    previewUrl = useRef("");
  const reportProgress = useRef<(progress: number) => void>(() => {});
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  function setImagePreview(blob: Blob | null) {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = "";
    if (!mounted.current) return;
    previewUrl.current = blob ? URL.createObjectURL(blob) : "";
    setPreview(previewUrl.current);
  }
  function freeSource() {
    if (source.current) {
      source.current.width = 0;
      source.current.height = 0;
      source.current = null;
    }
  }
  function releaseEngine() {
    clearTimeout(idle.current);
    const old = engine.current;
    engine.current = null;
    old?.channel.postMessage("cancel");
    old?.channel.close();
    void old?.worker.terminate().catch(() => {});
  }
  useEffect(() => {
    mounted.current = true;
    const hidden = () => {
      if (document.hidden) {
        current.current?.cancel();
        releaseEngine();
        setCameraOpen(false);
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      mounted.current = false;
      generation.current++;
      current.current?.cancel();
      releaseEngine();
      freeSource();
      cropped.current = null;
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      onBusyChange?.(false);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  async function choose(selected: File | undefined) {
    if (!selected) return;
    const token = ++generation.current;
    current.current?.cancel();
    freeSource();
    cropped.current = null;
    setImagePreview(null);
    setError("");
    setFields(empty);
    setCandidate({});
    setReview(false);
    setSaveImage(false);
    setOpen(true);
    setConfirmed(false);
    setCameraOpen(false);
    setWarnings([]);
    if (
      !/^(image\/(jpeg|png|webp))$/.test(selected.type) ||
      selected.size > 20 * 1024 * 1024
    ) {
      setError("JPEG・PNG・WebPの20MB以下の画像を選んでください。");
      setReview(true);
      return;
    }
    setBusy(true);
    onBusyChange?.(true);
    let c: HTMLCanvasElement | null = null;
    try {
      c = await decodeReceipt(selected);
      if (!mounted.current || generation.current !== token) return;
      const raster = canvasRaster(c),
        found = detectReceipt(raster);
      setWarnings([
        ...imageQuality(raster),
        ...(found ? receiptFraming(found, raster.width, raster.height) : []),
        ...(found ? [] : ["範囲を検出できません。四隅を調整してください。"]),
      ]);
      setQuad(found ?? structuredClone(defaultQuad));
      const blob = await new Promise<Blob | null>((resolve) =>
        c!.toBlob(resolve, "image/jpeg", 0.9),
      );
      if (!mounted.current || generation.current !== token) return;
      source.current = c;
      c = null;
      setImagePreview(blob);
    } catch {
      if (mounted.current && generation.current === token) {
        setError(
          "画像を開けませんでした。JPEG・PNG・WebPの24MP以下の写真にするか手入力してください。",
        );
        setReview(true);
      }
    } finally {
      if (c) {
        c.width = 0;
        c.height = 0;
      }
      if (mounted.current && generation.current === token) {
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  }
  function rotate() {
    const token = generation.current,
      old = source.current;
    if (!old) return;
    const c = document.createElement("canvas");
    c.width = old.height;
    c.height = old.width;
    const ctx = c.getContext("2d")!;
    ctx.translate(c.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(old, 0, 0);
    const next = quad.map((p) => ({ x: 1 - p.y, y: p.x }));
    setQuad([next[3], next[0], next[1], next[2]]);
    freeSource();
    source.current = c;
    setConfirmed(false);
    void new Promise<Blob | null>((resolve) =>
      c.toBlob(resolve, "image/jpeg", 0.9),
    ).then((blob) => {
      if (
        mounted.current &&
        generation.current === token &&
        source.current === c
      )
        setImagePreview(blob);
    });
  }
  const update = <K extends keyof Fields>(key: K, value: Fields[K]) =>
    setFields((old) => ({ ...old, [key]: value }));
  async function read() {
    if (!source.current || !confirmed || !validQuad(quad) || current.current)
      return;
    if (
      typeof BroadcastChannel === "undefined" ||
      typeof WebAssembly === "undefined"
    ) {
      setError("この端末では読み取れません。手入力してください。");
      setReview(true);
      return;
    }
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    setProgress(0);
    setStatus("レシートだけを切り抜いています");
    clearTimeout(idle.current);
    let cancelled = false,
      channel: BroadcastChannel | null = null,
      worker: OCRWorker | null = null,
      canvas: HTMLCanvasElement | null = null,
      crop: HTMLCanvasElement | null = null;
    let rejectCancel: (e: Error) => void = () => {};
    const cancellation = new Promise<never>((_, reject) => {
      rejectCancel = reject;
    });
    const run = {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        channel?.postMessage("cancel");
        void worker?.terminate().catch(() => {});
        releaseEngine();
        rejectCancel(new Error("cancelled"));
      },
    };
    current.current = run;
    const active = () =>
      !cancelled && mounted.current && current.current === run;
    reportProgress.current = (p) => {
      if (active()) {
        setStatus("文字を読み取り中");
        setProgress(Math.round(25 + Math.max(0, Math.min(1, p)) * 65));
      }
    };
    const task = async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      if (!active()) return;
      const raster = rectifyReceipt(canvasRaster(source.current!), quad);
      crop = rasterCanvas(raster);
      setWarnings(imageQuality(raster));
      cropped.current = await new Promise<Blob | null>((resolve) =>
        crop!.toBlob(resolve, "image/jpeg", 0.9),
      );
      if (!active()) return;
      setImagePreview(cropped.current);
      freeSource();
      canvas = rasterCanvas(prepareReceipt(raster, true));
      const { createWorker, OEM, PSM } = await import("tesseract.js");
      if (!active()) return;
      if (engine.current) {
        worker = engine.current.worker;
        channel = engine.current.channel;
      } else {
        const session = crypto.randomUUID();
        channel = new BroadcastChannel(`pace-ocr-${session}`);
        channel.onmessage = (e) => {
          if (e.data === "ready" && cancelled) channel?.postMessage("cancel");
        };
        const base = new URL(
          `${import.meta.env.BASE_URL}ocr/`,
          document.baseURI,
        ).href;
        worker = await createWorker(["jpn", "eng"], OEM.LSTM_ONLY, {
          workerPath: `${base}worker.min.js?v=${APP_VERSION}#${session}`,
          workerBlobURL: false,
          corePath: base.replace(/\/$/, ""),
          langPath: base.replace(/\/$/, ""),
          cacheMethod: "none",
          gzip: true,
          legacyCore: false,
          legacyLang: false,
          logger: (m) => {
            if (m.status === "recognizing text")
              reportProgress.current(Number(m.progress) || 0);
          },
          errorHandler: () => {},
        });
        if (!active()) {
          await worker.terminate();
          channel.close();
          return;
        }
        engine.current = { worker, channel };
      }
      channel.postMessage("keepalive");
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_COLUMN,
        preserve_interword_spaces: "1",
        user_defined_dpi: "300",
        debug_file: "/dev/null",
      });
      let result = await worker.recognize(
        canvas,
        {},
        { text: true, blocks: true },
      );
      if (!active()) return;
      let parsed = parseReceiptText(result.data.text, result.data.confidence);
      if ((parsed.confidence?.amount ?? 0) < 0.75) {
        const lines =
          result.data.blocks?.flatMap((b) =>
            b.paragraphs.flatMap((p) => p.lines),
          ) ?? [];
        const line = lines.find(
          (l) =>
            /(?:総合計|合計|お支払|grand\s*total|\btotal\b)/i.test(l.text) &&
            !/(?:小計|税|subtotal|tax)/i.test(l.text),
        );
        if (line) {
          setStatus("合計の周辺を確認中");
          const top = Math.max(0, line.bbox.y0 - 16),
            bottom = Math.min(canvas.height, line.bbox.y1 + 80);
          const retry = await worker.recognize(
              canvas,
              {
                rectangle: {
                  left: 0,
                  top,
                  width: canvas.width,
                  height: bottom - top,
                },
              },
              { text: true },
            ),
            second = parseReceiptText(retry.data.text, retry.data.confidence);
          parsed = refineReceiptTotal(parsed, second);
        } else if (!parsed.amount) {
          const gray = rasterCanvas(prepareReceipt(raster, false));
          try {
            result = await worker.recognize(gray, {}, { text: true });
            const second = parseReceiptText(
              result.data.text,
              result.data.confidence,
            );
            if (second.amount !== undefined)
              parsed = refineReceiptTotal(
                {
                  ...parsed,
                  merchant: parsed.merchant ?? second.merchant,
                  date: parsed.date ?? second.date,
                  time: parsed.time ?? second.time,
                  tax: parsed.tax ?? second.tax,
                },
                second,
              );
          } finally {
            gray.width = 0;
            gray.height = 0;
          }
        }
      }
      if (!active()) return;
      const s = suggestLocalCategory(parsed.merchant ?? "", data);
      setCandidate(parsed);
      setFields({
        ...empty,
        merchant: parsed.merchant ?? "",
        amount:
          (parsed.confidence?.amount ?? 0) >= 0.75 && parsed.amount
            ? String(parsed.amount)
            : "",
        date: parsed.date ?? "",
        time: parsed.time ?? "",
        tax: parsed.tax === undefined ? "" : String(parsed.tax),
        category: s.categoryId,
        subcategory: s.subcategoryId,
      });
      setReview(true);
      setProgress(100);
      if (!result.data.text.trim())
        setError(
          "文字が見つかりませんでした。撮影し直すか手入力してください。",
        );
    };
    const timeout = setTimeout(() => {
      if (active()) {
        setError(
          "時間がかかっているため中止しました。撮影し直すか、下に入力してください。",
        );
        setReview(true);
        run.cancel();
      }
    }, 60000);
    try {
      await Promise.race([task(), cancellation]);
    } catch {
      if (!cancelled && mounted.current) {
        setError(
          "読み取れませんでした。画像・端末の空き容量を確認し、手入力してください。",
        );
        setReview(true);
        releaseEngine();
      }
    } finally {
      clearTimeout(timeout);
      if (canvas) {
        (canvas as HTMLCanvasElement).width = 0;
        (canvas as HTMLCanvasElement).height = 0;
      }
      if (crop) {
        (crop as HTMLCanvasElement).width = 0;
        (crop as HTMLCanvasElement).height = 0;
      }
      if (cancelled) {
        freeSource();
        cropped.current = null;
        setImagePreview(null);
        const closing = channel as BroadcastChannel | null;
        setTimeout(() => {
          try {
            closing?.postMessage("cancel");
            closing?.close();
          } catch {}
        }, 1000);
      } else if (engine.current)
        idle.current = setTimeout(releaseEngine, 20000);
      if (current.current === run) {
        current.current = null;
        if (mounted.current) {
          setBusy(false);
          onBusyChange?.(false);
        }
      }
    }
  }
  async function apply() {
    if (applyGuard.current) return;
    const account = payableAccounts(data).find((a) => a.id === fields.account);
    const next: ReceiptDraftCandidate = {
      needsReview:
        !fields.merchant.trim() ||
        (fields.merchant === candidate.merchant &&
          (candidate.confidence?.merchant ?? 0) < 0.75),
      merchant: fields.merchant.trim() || undefined,
      amount: fields.amount ? Number(fields.amount) : undefined,
      date: fields.date || undefined,
      time: fields.time || undefined,
      tax: fields.tax ? Number(fields.tax) : undefined,
      categoryId: fields.category,
      subcategoryId: fields.subcategory,
      sourceAccountId: account?.id,
      paymentMethod: account
        ? account.kind === "CREDIT_CARD"
          ? "creditCard"
          : account.kind === "CASH"
            ? "cash"
            : account.kind === "BANK"
              ? "bank"
              : "other"
        : undefined,
    };
    const invalid = validateReceiptCandidate(next);
    if (
      invalid ||
      !next.amount ||
      !next.date ||
      (payableAccounts(data).length && !account)
    ) {
      setError(
        invalid ??
          (!next.date
            ? "日付を確認してください。"
            : !next.amount
              ? "合計金額を確認してください。"
              : "支払元を選んでください。"),
      );
      return;
    }
    if (next.date > today) {
      setError("未来の日付は記録できません。");
      return;
    }
    applyGuard.current = true;
    setApplying(true);
    onBusyChange?.(true);
    try {
      if (saveImage && cropped.current)
        next.imageFile = new File([cropped.current], "receipt.jpg", {
          type: "image/jpeg",
        });
      await onApply(next);
      if (mounted.current) {
        setOpen(false);
        setReview(false);
        setFields(empty);
        setSaveImage(false);
      }
      cropped.current = null;
      freeSource();
      setImagePreview(null);
      releaseEngine();
    } catch {
      if (mounted.current)
        setError(
          "登録できませんでした。内容を確認してもう一度お試しください。",
        );
    } finally {
      applyGuard.current = false;
      if (mounted.current) {
        setApplying(false);
        onBusyChange?.(false);
      }
    }
  }
  function close() {
    setBusy(false);
    onBusyChange?.(false);
    generation.current++;
    current.current?.cancel();
    releaseEngine();
    freeSource();
    cropped.current = null;
    setImagePreview(null);
    setReview(false);
    setOpen(false);
    setSaveImage(false);
    setCameraOpen(false);
  }
  return (
    <section className="receipt-capture">
      <button
        type="button"
        className="button button-secondary full"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <ScanLine size={18} />
        レシートから入力
      </button>
      {open && (
        <div className="receipt-workspace">
          <input
            ref={camera}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            hidden
            onChange={(e) => {
              void choose(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <input
            ref={picker}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={(e) => {
              void choose(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <div className="button-row">
            <button
              type="button"
              className="button button-secondary"
              disabled={busy || applying}
              onClick={() =>
                typeof navigator.mediaDevices !== "undefined"
                  ? setCameraOpen(true)
                  : camera.current?.click()
              }
            >
              <Camera size={17} />
              撮影
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy || applying}
              onClick={() => picker.current?.click()}
            >
              <FileImage size={17} />
              写真を選ぶ
            </button>
          </div>
          {cameraOpen && (
            <ReceiptCamera
              onPhoto={(f) => void choose(f)}
              onClose={() => setCameraOpen(false)}
              onFallback={() => {
                setCameraOpen(false);
                camera.current?.click();
              }}
            />
          )}
          {preview && source.current && !review && (
            <>
              <ReceiptCrop
                preview={preview}
                quad={quad}
                disabled={busy}
                onChange={(q) => {
                  setQuad(q);
                  setConfirmed(false);
                }}
              />
              <button
                type="button"
                className="chip"
                disabled={busy}
                onClick={rotate}
              >
                <RotateCw size={16} />
                90°回転
              </button>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy || !validQuad(quad)}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                レシート全体が枠内にあり、背景を除けています
              </label>
              <button
                type="button"
                className="button button-primary full"
                disabled={busy || !confirmed || !validQuad(quad)}
                onClick={() => void read()}
              >
                <ScanLine size={18} />
                読み取る
              </button>
            </>
          )}
          {preview && review && (
            <img
              className="receipt-preview"
              src={preview}
              alt="背景を除いたレシート"
            />
          )}
          {warnings.map((w, i) => (
            <p className="hint receipt-warning" key={i}>
              {w}
            </p>
          ))}
          {busy && (
            <div role="status" aria-live="polite">
              <p>
                {status} {progress}%
              </p>
              <progress value={progress} max={100} />
              <button
                type="button"
                className="chip"
                onClick={() => {
                  current.current?.cancel();
                  setReview(true);
                }}
              >
                <X size={16} />
                中止
              </button>
            </div>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          {!busy && !review && (
            <button
              type="button"
              className="text-button"
              onClick={() => setReview(true)}
            >
              手入力する
            </button>
          )}
          {review && !busy && (
            <div className="chips receipt-fallbacks">
              <button
                type="button"
                className="chip"
                onClick={() => {
                  close();
                  setOpen(true);
                  camera.current?.click();
                }}
              >
                撮影し直す
              </button>
              <button
                type="button"
                className="chip"
                disabled={!cropped.current}
                onClick={() => {
                  const image = cropped.current!;
                  void choose(
                    new File([image], "receipt.jpg", { type: "image/jpeg" }),
                  );
                }}
              >
                切り抜きを調整
              </button>
              <button
                type="button"
                className="chip"
                onClick={() => {
                  setFields({
                    ...empty,
                    amount: fields.amount,
                    date: fields.date || today,
                    account: fields.account,
                  });
                  setCandidate({});
                  setSaveImage(false);
                  setReview(true);
                }}
              >
                金額だけで登録
              </button>
              <button
                type="button"
                className="chip"
                onClick={() => {
                  void Promise.resolve(
                    onApply({
                      inputOnly: true,
                      needsReview: !fields.merchant.trim(),
                      amount: fields.amount ? Number(fields.amount) : undefined,
                      date: fields.date || today,
                      merchant: fields.merchant || undefined,
                      sourceAccountId: fields.account || undefined,
                      categoryId: fields.category,
                    }),
                  )
                    .then(close)
                    .catch(() => setError("手入力に反映できませんでした。"));
                }}
              >
                手入力に切り替え
              </button>
            </div>
          )}
          {review && !busy && (
            <div className="receipt-review">
              <p className="hint">
                確認して登録。読み取りだけでは保存されません。
              </p>
              <div
                className={
                  (candidate.confidence?.merchant ?? 0) < 0.75
                    ? "needs-review"
                    : ""
                }
              >
                <Field label="お店">
                  <input
                    value={fields.merchant}
                    maxLength={120}
                    onChange={(e) => update("merchant", e.target.value)}
                    autoComplete="off"
                  />
                </Field>
                {(candidate.confidence?.merchant ?? 0) < 0.75 && (
                  <small>店名を確認してください（任意）</small>
                )}
              </div>
              <div
                className={
                  (candidate.confidence?.amount ?? 0) < 0.75
                    ? "needs-review"
                    : ""
                }
              >
                <Field label="合計（円）">
                  <input
                    inputMode="numeric"
                    value={fields.amount}
                    onChange={(e) =>
                      update(
                        "amount",
                        e.target.value.replace(/[^0-9]/g, "").slice(0, 12),
                      )
                    }
                  />
                </Field>
                {(candidate.confidence?.amount ?? 0) < 0.75 && (
                  <>
                    <small>合計金額を確認してください</small>
                    <div className="chips">
                      {(candidate.amountCandidates ?? []).map((a) => (
                        <button
                          type="button"
                          className="chip"
                          key={a.amount}
                          onClick={() => update("amount", String(a.amount))}
                        >
                          ¥{a.amount.toLocaleString("ja-JP")} · 候補
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <Field label="カテゴリー">
                <select
                  value={fields.category}
                  onChange={(e) => {
                    update("category", e.target.value);
                    update("subcategory", "");
                  }}
                >
                  {data.categories
                    .filter((c) => !c.archived)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="支払元">
                <select
                  aria-label="支払元"
                  value={fields.account}
                  onChange={(e) => update("account", e.target.value)}
                >
                  <option value="">選んでください</option>
                  {payableAccounts(data).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div
                className={
                  (candidate.confidence?.date ?? 0) < 0.75 ? "needs-review" : ""
                }
              >
                <Field label="日付">
                  <input
                    type="date"
                    max={today}
                    value={fields.date}
                    onChange={(e) => update("date", e.target.value)}
                  />
                </Field>
                {(candidate.confidence?.date ?? 0) < 0.75 && (
                  <small>日付を確認してください</small>
                )}
              </div>
              <details>
                <summary>時刻・税額</summary>
                <Field label="時刻（任意）">
                  <input
                    type="time"
                    value={fields.time}
                    onChange={(e) => update("time", e.target.value)}
                  />
                </Field>
                <Field label="税額（任意）">
                  <input
                    inputMode="numeric"
                    value={fields.tax}
                    onChange={(e) =>
                      update("tax", e.target.value.replace(/[^0-9]/g, ""))
                    }
                  />
                </Field>
              </details>
              {cropped.current && (
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={saveImage}
                    onChange={(e) => setSaveImage(e.target.checked)}
                  />
                  レシート画像も端末内に保存
                </label>
              )}
              <button
                type="button"
                className="button button-primary full"
                disabled={applying}
                onClick={() => void apply()}
              >
                <Check size={18} />
                {payableAccounts(data).length ? "確認して記録" : "入力に反映"}
              </button>
            </div>
          )}
          <p className="hint">
            端末内で読み取り。元写真は読み取り後、確認用の切り抜きは画面を閉じると破棄します。画像保存は初期状態オフです。
          </p>
        </div>
      )}
    </section>
  );
}
