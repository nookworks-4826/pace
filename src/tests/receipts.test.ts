import { describe, expect, it } from "vitest";
import { parseReceiptText, validReceiptDate, validateReceiptCandidate } from "../domain/receipts";

describe("local receipt candidates", () => {
  it("extracts a fictional Japanese cash receipt without mistaking tender/change for total", () => {
    expect(parseReceiptText("架空マート\n2026年10月3日 18:24\nミルク 220\nパン 180\n小計 400\n消費税 32\n合 計 ¥４３２\n現金 お預り 1,000\nお釣り 568")).toMatchObject({ merchant: "架空マート", amount: 432, date: "2026-10-03", time: "18:24", tax: 32, products: ["ミルク", "パン"], paymentMethod: "cash" });
  });
  it("accepts a total on the next line, two-digit year and an era date", () => {
    expect(parseReceiptText("架空カフェ\n26/10/3 9:05\n税込合計\n¥1,250\nVISA")).toMatchObject({ amount: 1250, date: "2026-10-03", time: "09:05", paymentMethod: "creditCard" });
    expect(parseReceiptText("令和8年10月3日\n合計 900").date).toBe("2026-10-03");
  });
  it("leaves incompatible totals and foreign currency for explicit correction", () => {
    expect(parseReceiptText("合計 950\n合計 590").amount).toBeUndefined();
    expect(parseReceiptText("TOTAL USD 12.50").amount).toBeUndefined();
    expect(parseReceiptText("TOTAL $250").amount).toBeUndefined();
    expect(parseReceiptText("合計 12.50").amount).toBeUndefined();
    expect(parseReceiptText("小計 700\nお預り 1,000\n釣銭 300").amount).toBeUndefined();
  });
  it("does not hallucinate absent dates, invalid calendar dates or payment methods", () => {
    const result = parseReceiptText("架空商店\n2026/02/30 29:15\n合計 810");
    expect(result.date).toBeUndefined(); expect(result.time).toBeUndefined(); expect(result.paymentMethod).toBeUndefined();
    expect(validReceiptDate("2024-02-29")).toBe(true); expect(validReceiptDate("2025-02-29")).toBe(false);
    expect(parseReceiptText("")).not.toHaveProperty("amount");
  });
  it("classifies electronic money as a channel candidate and never invents an account", () => {
    expect(parseReceiptText("合計 830\nPayPay 支払").paymentMethod).toBe("other");
    expect(parseReceiptText("合計 830\nSuica").paymentMethod).toBe("other");
    expect(parseReceiptText("合計 830\nデビット").paymentMethod).toBe("debit");
  });
  it("validates editable candidates instead of saving OCR automatically", () => {
    expect(validateReceiptCandidate({ amount: 900, tax: 90, date: "2026-10-03", time: "14:30" })).toBeNull();
    for (const candidate of [{ amount: -1 }, { amount: 0.5 }, { amount: 100, tax: 101 }, { date: "2026-02-30" }, { time: "24:00" }]) expect(validateReceiptCandidate(candidate)).toBeTruthy();
  });
});
