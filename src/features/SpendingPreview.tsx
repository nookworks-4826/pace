import { useState } from "react";
import { ArrowRight, Calculator, ChevronRight } from "lucide-react";
import { usePace } from "../app/context";
import { Field, Sheet, yen } from "../components/UI";
import { MAX_MONEY } from "../domain/finance";
import { previewPurchase } from "../domain/spendingPreview";

export function SpendingPreview() {
  const { finance, today } = usePace();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const numeric = Number(amount);
  const valid =
    /^\d+$/.test(amount) &&
    Number.isSafeInteger(numeric) &&
    numeric >= 0 &&
    numeric <= MAX_MONEY;
  const result = valid ? previewPurchase(finance, numeric, today) : null;
  return (
    <>
      <button className="purchase-entry surface" onClick={() => setOpen(true)}>
        <span className="purchase-entry-icon">
          <Calculator size={21} />
        </span>
        <span>
          <strong>これ、買ったら？</strong>
          <small>使う前に残額をチェック</small>
        </span>
        <ChevronRight size={19} />
      </button>
      {open && (
        <Sheet title="これ、買ったら？" onClose={() => setOpen(false)}>
          <div className="purchase-preview">
            <Field label="使う予定の金額">
              <div className="purchase-amount">
                <span>¥</span>
                <input
                  aria-label="使う予定の金額"
                  inputMode="numeric"
                  type="text"
                  value={amount}
                  maxLength={12}
                  placeholder="0"
                  onChange={(event) =>
                    setAmount(
                      event.target.value.normalize("NFKC").replaceAll(",", ""),
                    )
                  }
                />
              </div>
            </Field>
            <div className="amount-chips">
              {[1000, 3000, 5000, 10000].map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={numeric === value && valid}
                  onClick={() => setAmount(String(value))}
                >
                  {yen(value)}
                </button>
              ))}
            </div>
            {finance.safeToSpend === null ? (
              <p className="note-panel">現在残高を入力すると試せます。</p>
            ) : (
              <>
                {amount && !valid && (
                  <p className="form-error" role="alert">
                    0円以上の整数を入力してください。
                  </p>
                )}
                <div
                  className="preview-result"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <p className="eyebrow">購入後の見通し</p>
                  <div className="preview-change">
                    <span>{yen(Math.max(0, finance.safeToSpend))}</span>
                    <ArrowRight size={19} />
                    <strong
                      key={result?.safeAfter}
                      className={result?.shortage ? "preview-negative" : ""}
                    >
                      {result ? yen(Math.max(0, result.safeAfter)) : "—"}
                    </strong>
                  </div>
                  <p>
                    {result?.shortage
                      ? `予定分まで含めると ${yen(result.shortage)} 不足`
                      : "今使っていい金額"}
                  </p>
                  {result && (
                    <div className="preview-next">
                      <span>
                        {result.daysAfterToday
                          ? "明日からの1日あたり"
                          : "今月は今日まで"}
                      </span>
                      <b>
                        {result.tomorrowAllowance === null
                          ? "—"
                          : yen(result.tomorrowAllowance)}
                      </b>
                    </div>
                  )}
                  {result?.budgetAfter !== null &&
                    result?.budgetAfter !== undefined &&
                    result.budgetAfter < 0 && (
                      <p className="preview-negative">
                        月予算を {yen(-result.budgetAfter)} 超える見込み
                      </p>
                    )}
                </div>
              </>
            )}
            <small>試算のみ。記録は追加されません。</small>
            <details>
              <summary>計算について</summary>
              <p className="hint">
                登録済みの残高・予定から、この金額を追加で使った場合を計算します。未入力の支払いは含みません。明日からの目安は、購入後の金額と月予算の残りの小さい方を、明日から月末までの日数で割っています。すでに確保している固定費・カード引落・返済・貯金移動には使いません。
              </p>
            </details>
          </div>
        </Sheet>
      )}
    </>
  );
}
