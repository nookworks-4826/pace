import type { PaymentMethod } from "../types";

/** Suggestions only. The capture UI requires an explicit review before onApply. */
export interface ReceiptDraftCandidate {
  needsReview?: boolean;
  inputOnly?: boolean;
  amountCandidates?: { amount: number; score: number; label: string }[];
  confidence?: { merchant: number; amount: number; date: number };
  sourceAccountId?: string;
  categoryId?: string;
  subcategoryId?: string;
  merchant?: string;
  amount?: number;
  date?: string;
  time?: string;
  tax?: number;
  paymentMethod?: PaymentMethod;
  products?: string[];
  imageFile?: File;
}
const maximumAmount = 999_999_999_999;
const metadata =
  /(?:合計|小計|税|消費税|お預[かり]*|預り|お釣|釣銭|現金|クレジット|カード|支払|ポイント|領収|レシート|TEL|電話|住所|登録番号|営業時間|責任者|担当|伝票|取引|POS|No\.|Thank\s*you|ありがとうございます|またのご来店)/i;
const nonTotal =
  /(?:小計|税抜|税額|消費税|内税|外税|お預|預り|お釣|おつり|釣銭|ポイント|値引|割引|点数|合計点数|総点数|SUBTOTAL|TAX|CHANGE|TENDER|CASH RECEIVED|DISCOUNT|POINTS)/i;
export function validReceiptDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
export function validReceiptTime(value: string) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function parseAmount(value: string): number | undefined {
  // JPY has no fractional unit. Do not silently remove a decimal point.
  const text = value.replace(/[¥￥円,\s]/g, "");
  if (!/^\d{1,12}$/.test(text)) return undefined;
  const result = Number(text);
  return Number.isSafeInteger(result) && result >= 0 && result <= maximumAmount
    ? result
    : undefined;
}
function endingAmount(line: string) {
  if (/(?:USD|EUR|GBP|AUD|CAD|CNY|KRW|US\$|\$|€|£)/i.test(line))
    return undefined;
  if (/\d\.\d|[-−]\s*[¥￥]?\s*\d/.test(line)) return undefined;
  const match = line.match(/[¥￥]?\s*(\d[\d,\s]{0,20})(?:\s*円)?\s*$/);
  return match ? parseAmount(match[1]) : undefined;
}
function extractDate(text: string): string | undefined {
  const western = text.match(
    /(?:^|\D)(\d{4}|\d{2})[\/.年-]\s*(\d{1,2})[\/.月-]\s*(\d{1,2})(?:日|\b)/,
  );
  const era = text.match(
    /(?:令和|R)\s*(\d{1,2})[\/.年-]\s*(\d{1,2})[\/.月-]\s*(\d{1,2})(?:日|\b)/i,
  );
  const result = era ?? western;
  if (!result) return undefined;
  const year = era
    ? 2018 + Number(result[1])
    : result[1].length === 2
      ? 2000 + Number(result[1])
      : Number(result[1]);
  const date = `${year}-${result[2].padStart(2, "0")}-${result[3].padStart(2, "0")}`;
  return year >= 2000 && year <= 2100 && validReceiptDate(date)
    ? date
    : undefined;
}
export function parseReceiptText(
  rawText: string,
  ocrConfidence = 100,
): ReceiptDraftCandidate {
  const text = rawText
    .slice(0, 100_000)
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const result: ReceiptDraftCandidate = {};
  result.date = extractDate(text);
  const dates = new Set(lines.map(extractDate).filter(Boolean));
  if (dates.size > 1) result.date = undefined;
  const time = text.match(/(?:^|\D)([0-2]?\d)[:時]\s*([0-5]\d)(?:分|\b)/);
  if (time) {
    const value = `${time[1].padStart(2, "0")}:${time[2]}`;
    if (validReceiptTime(value)) result.time = value;
  }
  const totals: { amount: number; score: number; label: string }[] = [];
  const taxes: number[] = [];
  const products: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const compact = line.replace(/\s/g, "");
    const totalLabel =
      /(?:税込|お買上(?:げ)?金額|総合計|お支払(?:い)?(?:金額|額)?|合計金額|合計|TOTAL)/i.test(
        compact,
      ) && !nonTotal.test(compact);
    if (totalLabel) {
      const own = endingAmount(line);
      const following =
        own === undefined &&
        lines[i + 1] &&
        /^[¥￥\d,\s]+(?:円)?$/.test(lines[i + 1])
          ? endingAmount(lines[i + 1])
          : undefined;
      const amount = own ?? following;
      if (amount !== undefined && amount > 0)
        totals.push({
          amount,
          score: /(?:税込合計|総合計|合計金額|お買上|GRANDTOTAL|お支払)/i.test(
            compact,
          )
            ? 0.95
            : /(?:合計|TOTAL)/i.test(compact)
              ? 0.9
              : 0.65,
          label: line.slice(0, 120),
        });
    }
    if (
      /(?:消費税(?:等)?(?:額)?|税額|内税|外税)/.test(compact) ||
      /^TAX(?:\s+AMOUNT)?\s*[:：¥￥\d]/i.test(line)
    ) {
      const tax = endingAmount(line);
      if (tax !== undefined) taxes.push(tax);
    }
    if (
      !metadata.test(compact) &&
      !extractDate(line) &&
      !/(?:\d{1,2}:\d{2}|\d{2,4}[-/]\d{1,2})/.test(line)
    ) {
      if (
        !result.merchant &&
        i < 5 &&
        /[A-Za-z\u3040-\u30ff\u3400-\u9fff]/.test(line) &&
        endingAmount(line) === undefined
      )
        result.merchant = line.slice(0, 200);
      const item = line.match(/^(.+?)\s+[¥￥]?\s*\d[\d,]*(?:円)?\s*$/);
      if (
        item &&
        /[A-Za-z\u3040-\u30ff\u3400-\u9fff]/.test(item[1]) &&
        products.length < 50
      )
        products.push(item[1].trim().slice(0, 250));
    }
  }
  if (totals.length) {
    const score = Math.max(...totals.map((candidate) => candidate.score));
    const amounts = [
      ...new Set(
        totals
          .filter((candidate) => candidate.score === score)
          .map((candidate) => candidate.amount),
      ),
    ];
    // Conflicting totals need a person's decision, not a maximum-value guess.
    if (amounts.length === 1) result.amount = amounts[0];
    result.amountCandidates = totals
      .filter(
        (c, i) =>
          totals.findIndex(
            (other) => other.amount === c.amount && other.score >= c.score,
          ) === i,
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    // Any conflicting totals lower confidence even when one label ranks higher.
    const conflicts = new Set(totals.map((c) => c.amount)).size > 1;
    result.confidence = {
      merchant: result.merchant ? 0.65 : 0,
      date: result.date ? 0.9 : 0,
      amount: result.amount === undefined ? 0.25 : conflicts ? 0.45 : score,
    };
  }
  result.confidence ??= {
    merchant: result.merchant ? 0.65 : 0,
    date: result.date ? 0.9 : 0,
    amount: 0,
  };
  const engine = Math.max(0, Math.min(1, ocrConfidence / 100));
  result.confidence = {
    merchant: result.confidence.merchant * engine,
    date: result.confidence.date * engine,
    amount: result.confidence.amount * engine,
  };
  if (
    taxes.length === 1 &&
    (result.amount === undefined || taxes[0] <= result.amount)
  )
    result.tax = taxes[0];
  if (products.length) result.products = products;
  const payment = lines.map((line) => line.replace(/\s/g, "")).join("\n");
  if (/(?:PayPay|Suica|交通系IC|電子マネー|PASMO|ICOCA)/i.test(payment))
    result.paymentMethod = "other";
  else if (/(?:デビット)/i.test(payment)) result.paymentMethod = "debit";
  else if (
    /(?:クレジット|VISA|Mastercard|JCB|AMEX|カード支払|カード払い)/i.test(
      payment,
    )
  )
    result.paymentMethod = "creditCard";
  else if (/(?:現金|お預り|お預かり|お釣)/.test(payment))
    result.paymentMethod = "cash";
  return result;
}

export function validateReceiptCandidate(candidate: ReceiptDraftCandidate) {
  if (
    candidate.amount !== undefined &&
    (!Number.isSafeInteger(candidate.amount) ||
      candidate.amount < 1 ||
      candidate.amount > maximumAmount)
  )
    return "合計を1円以上の整数で入力してください。";
  if (candidate.date && !validReceiptDate(candidate.date))
    return "日付を確認してください。";
  if (candidate.time && !validReceiptTime(candidate.time))
    return "時刻を確認してください。";
  if (
    candidate.tax !== undefined &&
    (!Number.isSafeInteger(candidate.tax) ||
      candidate.tax < 0 ||
      candidate.tax > (candidate.amount ?? maximumAmount))
  )
    return "税額を確認してください。";
  return null;
}

/** A focused second pass may strengthen agreement, but cannot hide conflicting totals. */
export function refineReceiptTotal(
  first: ReceiptDraftCandidate,
  second: ReceiptDraftCandidate,
): ReceiptDraftCandidate {
  if (second.amount === undefined) return first;
  const byAmount = new Map<
    number,
    { amount: number; score: number; label: string }
  >();
  for (const c of [
    ...(first.amountCandidates ?? []),
    ...(second.amountCandidates ?? []),
  ]) {
    if (c.score > (byAmount.get(c.amount)?.score ?? -1))
      byAmount.set(c.amount, c);
  }
  const conflicts =
    byAmount.size > 1 ||
    (first.amount !== undefined && first.amount !== second.amount);
  const amount = first.amount ?? (conflicts ? undefined : second.amount);
  const confidence = Math.max(
    first.confidence?.amount ?? 0,
    second.confidence?.amount ?? 0,
  );
  return {
    ...first,
    amount,
    amountCandidates: [...byAmount.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5),
    confidence: {
      merchant: first.confidence?.merchant ?? 0,
      date: first.confidence?.date ?? 0,
      amount: conflicts ? Math.min(0.45, confidence) : confidence,
    },
  };
}
