import { useState } from "react";
import { withUndo, undoChange } from "../domain/undo";
import { balanceDrift } from "../domain/practical";
import { usePace } from "../app/context";
import { AsyncForm, Field, Sheet, yen } from "../components/UI";
import { db, readAppData } from "../db";
import {
  calculateAccountBalance,
  getAccountBalances,
} from "../domain/accounts";
import { recordFeatureUse } from "../domain/experienceActions";
import { reconcileAccount } from "../domain/financialActions";
export function BalanceCheck({ onClose }: { onClose: () => void }) {
  const { data, today, toast, openExpense } = usePace(),
    [values, setValues] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Record<string, "adjust" | "later">>(
    {},
  );
  const balances = getAccountBalances(data, today).filter(
    (b) => b.account.isActive && !b.account.archivedAt,
  );
  return (
    <Sheet title="残高をまとめて確認" onClose={onClose}>
      <p className="hint">
        今の残高・カード未払いを確認してください。変わっていない欄は入力不要です。
      </p>
      <AsyncForm
        label="確認した残高を保存"
        onSubmit={async () => {
          const undo = await withUndo("残高をまとめて確認", async () => {
            const fresh = await readAppData(false);
            for (const b of balances) {
              if (choices[b.account.id] === "later") continue;
              const a = fresh.accounts?.find((a) => a.id === b.account.id);
              if (!a?.isActive || a.archivedAt)
                throw new Error("口座が変更されました。開き直してください。");
              const latest = calculateAccountBalance(fresh, a, today);
              if (
                latest !== b.balance ||
                a.snapshotRecordedAt !== b.account.snapshotRecordedAt
              )
                throw new Error(
                  "別の画面で残高・記録が変更されました。再確認してください。",
                );
              const value = values[a.id]?.trim();
              if (!value && latest === null) continue;
              const amount = value ? Number(value) : latest!;
              if (
                !Number.isSafeInteger(amount) ||
                amount < 0 ||
                amount > 999999999999
              )
                throw new Error("残高は0円以上の整数で入力してください。");
              if (
                latest !== null &&
                amount !== latest &&
                choices[a.id] !== "adjust"
              )
                throw new Error(`${a.name}の差額の扱いを選んでください。`);
              if (latest === amount)
                await db.accounts.update(a.id, {
                  lastVerifiedAt: new Date().toISOString(),
                });
              else
                await reconcileAccount(
                  a,
                  amount,
                  today,
                  "本人が残高調整を選択",
                );
            }
          });
          void recordFeatureUse("balance").catch(() => {});
          onClose();
          toast(
            undo.id ? "残高を確認しました" : "未確認の口座はそのまま残しました",
            undo.id ? () => undoChange(undo.id) : undefined,
          );
        }}
      >
        {balances.map((b) => {
          const raw = values[b.account.id],
            drift = raw ? balanceDrift(b.balance, Number(raw)) : null;
          return (
            <section className="surface" key={b.account.id}>
              <Field
                label={`${b.account.name}${b.isLiability ? " · 未払い" : ""}`}
                hint={`前回値 ${b.balance === null ? "未確認" : yen(b.balance)} · ${b.account.lastVerifiedAt?.slice(0, 10) ?? "確認日なし"}${b.isStale ? " · 確認推奨" : ""}`}
              >
                <input
                  aria-label={`${b.account.name}の確認残高`}
                  inputMode="numeric"
                  value={raw ?? ""}
                  placeholder={
                    b.balance === null
                      ? "金額を入力"
                      : `${b.balance}（変更なし）`
                  }
                  onChange={(e) => {
                    setValues({
                      ...values,
                      [b.account.id]: e.target.value
                        .replace(/[^0-9]/g, "")
                        .slice(0, 12),
                    });
                    setChoices((old) => {
                      const next = { ...old };
                      delete next[b.account.id];
                      return next;
                    });
                  }}
                />
              </Field>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setValues({
                    ...values,
                    [b.account.id]: b.balance === null ? "" : String(b.balance),
                  });
                  setChoices({
                    ...choices,
                    [b.account.id]: b.balance === null ? "later" : "adjust",
                  });
                }}
              >
                変更なし
              </button>
              {!!drift && (
                <>
                  <p>
                    差額 {drift > 0 ? "+" : ""}
                    {yen(drift)}
                  </p>
                  <div className="chips">
                    <button
                      type="button"
                      className="chip"
                      disabled={b.isLiability ? drift < 0 : drift > 0}
                      onClick={() => {
                        onClose();
                        openExpense(undefined, false, {
                          amount: Math.abs(drift),
                          sourceAccountId: b.account.id,
                          paymentMethod: b.isLiability
                            ? "creditCard"
                            : b.account.kind === "CASH"
                              ? "cash"
                              : b.account.kind === "BANK"
                                ? "bank"
                                : "other",
                          creditCardId: b.account.creditCardId,
                          memo: "残高確認の差額を本人が支出として登録",
                        });
                      }}
                    >
                      支出として記録
                    </button>
                    <button
                      type="button"
                      className="chip"
                      disabled={b.isLiability || drift < 0}
                      onClick={() => {
                        onClose();
                        window.dispatchEvent(
                          new CustomEvent("pace-income-draft", {
                            detail: {
                              amount: drift,
                              sourceAccountId: b.account.id,
                            },
                          }),
                        );
                      }}
                    >
                      収入として記録
                    </button>
                    <button
                      type="button"
                      className={
                        choices[b.account.id] === "adjust"
                          ? "chip selected"
                          : "chip"
                      }
                      aria-pressed={choices[b.account.id] === "adjust"}
                      onClick={() =>
                        setChoices({ ...choices, [b.account.id]: "adjust" })
                      }
                    >
                      残高だけ調整
                    </button>
                    <button
                      type="button"
                      className={
                        choices[b.account.id] === "later"
                          ? "chip selected"
                          : "chip"
                      }
                      aria-pressed={choices[b.account.id] === "later"}
                      onClick={() =>
                        setChoices({ ...choices, [b.account.id]: "later" })
                      }
                    >
                      あとで確認
                    </button>
                  </div>
                  <p className="hint">
                    差額は自動で支出にしません。選んだ方法で確認して保存できます。
                  </p>
                </>
              )}
            </section>
          );
        })}
        {!balances.length && (
          <p className="hint">先にお金の置き場所を追加してください。</p>
        )}
      </AsyncForm>
    </Sheet>
  );
}
