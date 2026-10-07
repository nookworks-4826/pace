import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, Check, Sparkles, Wallet } from "lucide-react";
import { usePace } from "../app/context";
import { AsyncForm, Field, Sheet, stamp, yen } from "../components/UI";
import { db, saveExpense } from "../db";
import { parseQuickEntry, normalizeMerchant } from "../domain/categorization";
import { suggestLocalCategory } from "../domain/localAssistant";
import { paymentLabels } from "../types";
import type { Expense, Favorite, PaymentMethod } from "../types";
import type { PaymentChannel } from "../types";
import {
  rankPaymentSources,
  unusualAmount,
  payableAccounts,
} from "../domain/personalization";
import { recordFeatureUse } from "../domain/experienceActions";
import { Link } from "react-router-dom";
import { ReceiptCapture } from "./ReceiptCapture";

import {
  expenseInput,
  previousExpense,
  recentAmountSuggestions,
} from "../domain/practical";
import { withUndo, undoChange } from "../domain/undo";
interface Draft {
  sourceAccountId: string;
  paymentChannel: PaymentChannel;
  amount: string;
  merchant: string;
  date: string;
  categoryId: string;
  subcategoryId: string;
  paymentMethod: PaymentMethod;
  creditCardId: string;
  memo: string;
}
export function ExpenseSheet({
  expense,
  input,
  onClose,
  startReceipt = false,
}: {
  expense?: Expense;
  input?: Partial<Expense>;
  startReceipt?: boolean;
  onClose: () => void;
}) {
  const { data, today, toast } = usePace();
  const blank: Draft = {
    sourceAccountId: "",
    paymentChannel: "direct",
    amount: "",
    merchant: "",
    date: today,
    categoryId: "uncategorized",
    subcategoryId: "",
    paymentMethod: "cash",
    creditCardId: "",
    memo: "",
  };
  const [draft, setDraft] = useState<Draft>(() =>
    expense
      ? {
          ...expense,
          amount: String(expense.amount),
          creditCardId: expense.creditCardId ?? "",
          sourceAccountId: expense.sourceAccountId ?? "",
          paymentChannel: expense.paymentChannel ?? "direct",
        }
      : {
          ...blank,
          ...input,
          amount: input?.amount ? String(input.amount) : "",
          creditCardId: input?.creditCardId ?? "",
          sourceAccountId: input?.sourceAccountId ?? "",
        },
  );
  const [draftReady, setDraftReady] = useState(Boolean(expense || input));
  const interacted = useRef(false);
  useEffect(() => {
    if (expense || input) return;
    let cancelled = false;
    void db.drafts
      .get("expense")
      .then((row) => {
        if (!cancelled && row && !interacted.current) {
          try {
            const value = JSON.parse(row.value) as Partial<Draft>;
            if (
              typeof value.amount === "string" &&
              typeof value.merchant === "string" &&
              typeof value.date === "string"
            ) {
              setManual(true);
              setDraft({ ...blank, ...value });
            }
          } catch {
            /* An invalid temporary draft is ignored. */
          }
        }
      })
      .catch(() => {
        if (!cancelled)
          toast("下書きを読み込めませんでした。新しく入力できます。");
      })
      .finally(() => {
        if (!cancelled) setDraftReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [showAllAccounts, setShowAllAccounts] = useState(false);
  const sources = useMemo(
    () =>
      rankPaymentSources(data, today, expense?.sourceAccountId, draft.merchant),
    [
      data.accounts,
      data.expenses,
      data.settings.personalization,
      today,
      expense?.sourceAccountId,
      draft.merchant,
    ],
  );
  const accountInput =
    !!data.settings.financialAutomationEnabled || sources.length > 0;
  const [quick, setQuick] = useState("");
  const [manual, setManual] = useState(Boolean(expense));
  const [favorite, setFavorite] = useState(false);
  const [savedReceipt, setSavedReceipt] = useState<{
    mimeType: string;
    imageBase64: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (expense?.receiptId)
      void db.receipts
        .get(expense.receiptId)
        .then((r) => {
          if (!cancelled) setSavedReceipt(r ?? null);
        })
        .catch(() =>
          toast("画像を読み込めませんでした。記録は保存されています。"),
        );
    return () => {
      cancelled = true;
    };
  }, [expense?.receiptId]);
  const [receiptImage, setReceiptImage] = useState<File | undefined>();
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(startReceipt);
  const receiptBusyRef = useRef(false);
  const savedRef = useRef(false);
  const receiptNeedsReview = useRef(false);
  const receiptApplying = useRef(false);
  useEffect(() => {
    if (draftReady && !expense && !savedRef.current)
      void db.drafts
        .put({ id: "expense", value: JSON.stringify(draft) })
        .catch(() =>
          toast(
            "下書きを保存できませんでした。入力内容を確認して保存してください。",
          ),
        );
  }, [draft, draftReady, expense, toast]);
  const suggestion = useMemo(
    () => suggestLocalCategory(draft.merchant, data),
    [draft.merchant, data.merchantRules, data.categories, data.expenses],
  );
  useEffect(() => {
    if (!manual && draft.merchant) {
      setDraft((old) => ({
        ...old,
        categoryId: suggestion.categoryId,
        subcategoryId: suggestion.subcategoryId,
      }));
    }
  }, [manual, draft.merchant, suggestion.categoryId, suggestion.subcategoryId]);
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    interacted.current = true;
    setDraft((old) => ({ ...old, [key]: value }));
  };
  const selectedCategory = data.categories.find(
    (c) => c.id === draft.categoryId,
  );
  const recent = useMemo(() => {
    const merchants = new Map<string, Expense>();
    for (const row of [...data.expenses].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )) {
      if (row.merchant && !merchants.has(row.merchant))
        merchants.set(row.merchant, row);
      if (merchants.size >= 5) break;
    }
    return [...merchants.values()];
  }, [data.expenses]);
  const frequentCategories = useMemo(() => {
    const uses = new Map<string, number>();
    for (const row of data.expenses)
      uses.set(row.categoryId, (uses.get(row.categoryId) ?? 0) + 1);
    return data.categories
      .map((c) => ({ ...c, uses: uses.get(c.id) ?? 0 }))
      .filter((c) => c.uses > 0 && !c.archived)
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 4);
  }, [data.expenses, data.categories]);
  const amounts = useMemo(
    () =>
      recentAmountSuggestions(
        data,
        draft.merchant,
        draft.sourceAccountId,
        today,
      ),
    [data.expenses, draft.merchant, draft.sourceAccountId, today],
  );
  const previous = useMemo(() => previousExpense(data), [data.expenses]);
  function applyFavorite(f: Favorite | Expense) {
    interacted.current = true;
    setManual(true);
    const values = expenseInput(f);
    const validSource = payableAccounts(data).some(
      (a) => a.id === values.sourceAccountId,
    );
    setDraft({
      ...blank,
      ...values,
      amount: values.amount ? String(values.amount) : "",
      sourceAccountId: validSource ? values.sourceAccountId! : "",
      creditCardId: values.creditCardId ?? "",
    });
  }
  async function save(draft: Draft, receiptImage: File | undefined) {
    if (receiptBusyRef.current)
      throw new Error("レシートの処理が終わるまでお待ちください。");
    const amount = Number(draft.amount);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 999_999_999_999)
      throw new Error("1円以上の金額を入力してください。");
    if (draft.date > today)
      throw new Error(
        "未来の日付は記録できません。予定は固定費から登録できます。",
      );
    const source = (data.accounts ?? []).find(
      (a) =>
        a.id === draft.sourceAccountId &&
        ((a.isActive && !a.archivedAt) || a.id === expense?.sourceAccountId),
    );
    if (accountInput && !source) throw new Error("支払元を選んでください。");
    if (source?.kind === "CREDIT_CARD" && !source.creditCardId)
      throw new Error("口座の設定で対応するカードを選んでください。");
    const paymentMethod = source
      ? source.kind === "CREDIT_CARD"
        ? "creditCard"
        : source.kind === "CASH"
          ? "cash"
          : source.kind === "BANK"
            ? "bank"
            : "other"
      : draft.paymentMethod;
    if (
      paymentMethod === "creditCard" &&
      !(source?.creditCardId ?? draft.creditCardId)
    )
      throw new Error(
        "カードを選んでください。設定の「カード」から追加できます。",
      );
    if (
      unusualAmount(
        data.expenses.filter((e) => e.id !== expense?.id),
        draft.merchant,
        amount,
      ) &&
      !confirm("いつもより大きな金額です。内容を確認して登録しますか？")
    )
      return false;
    if (amount >= 100000 && !confirm(`${yen(amount)}で登録しますか？`))
      return false;
    const duplicate = data.expenses.find(
      (e) =>
        e.id !== expense?.id &&
        e.date === draft.date &&
        e.amount === amount &&
        normalizeMerchant(e.merchant) === normalizeMerchant(draft.merchant) &&
        Date.now() - new Date(e.createdAt).getTime() < 300000,
    );
    if (
      duplicate &&
      !confirm(
        "同じ店・金額の記録があります。重複の可能性がありますが、登録しますか？",
      )
    )
      return false;
    const row: Expense = {
      ...(expense ?? stamp()),
      amount,
      reviewed: expense?.reviewed,
      ocrNeedsReview:
        receiptNeedsReview.current ||
        expense?.ocrNeedsReview ||
        (receiptApplying.current && !draft.merchant.trim()),
      inputOrigin:
        expense?.inputOrigin ??
        (receiptApplying.current ? "receipt" : "manual"),
      date: draft.date,
      merchant: draft.merchant.trim() || "支出",
      description: expense?.description ?? "",
      categoryId: draft.categoryId,
      subcategoryId: draft.subcategoryId,
      paymentMethod,
      creditCardId:
        paymentMethod === "creditCard"
          ? (source?.creditCardId ?? draft.creditCardId)
          : undefined,
      memo: draft.memo,
      isFixedCost: expense?.isFixedCost ?? false,
      recurringOccurrenceId: expense?.recurringOccurrenceId,
      sourceAccountId: source?.id ?? expense?.sourceAccountId,
      paymentChannel:
        source?.kind === "CASH" || source?.kind === "BANK"
          ? "direct"
          : draft.paymentChannel,
      balanceEffect: expense?.externalTransactionId ? "snapshot" : "ledger",
      pendingStatus: expense?.externalTransactionId
        ? expense.pendingStatus
        : paymentMethod === "creditCard"
          ? "pending"
          : undefined,
      updatedAt: new Date().toISOString(),
    };
    const receiptId = receiptImage ? crypto.randomUUID() : undefined;
    if (receiptId) row.receiptId = receiptId;
    const imageBase64 = receiptImage
      ? await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = () =>
            reject(new Error("画像を保存できませんでした。"));
          reader.readAsDataURL(receiptImage);
        })
      : undefined;
    const undo = await withUndo(expense ? "支出を編集" : "支出を追加", () =>
      db.transaction(
        "rw",
        [
          db.expenses,
          db.merchantRules,
          db.categories,
          db.cards,
          db.recurringOccurrences,
          db.recurringExpenses,
          db.favorites,
          db.drafts,
          db.receipts,
          db.externalTransactions,
          db.expenseInbox,
        ],
        async () => {
          if (receiptImage && receiptId && imageBase64) {
            await db.receipts.add({
              ...stamp(),
              id: receiptId,
              expenseId: row.id,
              mimeType: receiptImage.type,
              imageBase64,
            });
          }
          await saveExpense(row);
          if (favorite)
            await db.favorites.put({
              id: crypto.randomUUID(),
              name: row.merchant,
              memo: row.memo,
              merchant: row.merchant,
              amount,
              categoryId: row.categoryId,
              subcategoryId: row.subcategoryId,
              paymentMethod: row.paymentMethod,
              creditCardId: row.creditCardId,
              sourceAccountId: row.sourceAccountId,
              paymentChannel: row.paymentChannel,
            });
          if (!expense) await db.drafts.delete("expense");
        },
      ),
    );
    void recordFeatureUse(
      receiptApplying.current ? "receipt" : "expense",
    ).catch(() => {});
    savedRef.current = true;
    onClose();
    toast(
      row.paymentMethod === "creditCard"
        ? `記録しました · カード未払いに${yen(amount)}追加`
        : "記録しました",
      () => undoChange(undo.id),
    );
    return true;
  }
  return (
    <Sheet title={expense ? "支出を編集" : "支出を記録"} onClose={onClose}>
      <AsyncForm
        onSubmit={async () => {
          await save(draft, receiptImage);
        }}
        disabled={receiptBusy || receiptOpen}
        className={receiptOpen ? "receipt-mode" : ""}
        label={expense ? "変更を保存" : "記録する"}
      >
        {savedReceipt && (
          <details>
            <summary>保存したレシート</summary>
            <img
              className="receipt-preview"
              alt="保存したレシート"
              src={`data:${savedReceipt.mimeType};base64,${savedReceipt.imageBase64}`}
            />
          </details>
        )}
        {!expense && (
          <div className="chips" aria-label="入力を再利用">
            {previous && (
              <button
                type="button"
                className="chip"
                onClick={() => applyFavorite(previous)}
              >
                前回と同じ
              </button>
            )}
            {data.favorites.slice(0, 6).map((f) => (
              <button
                type="button"
                className="chip"
                key={f.id}
                onClick={() => applyFavorite(f)}
              >
                <Bookmark size={13} />
                {f.name}
              </button>
            ))}
          </div>
        )}
        <div className="expense-amount">
          <label htmlFor="expense-amount">いくら使いましたか？</label>
          <div>
            <span>¥</span>
            <input
              id="expense-amount"
              style={{
                width: `${Math.max(1, Number(draft.amount || 0).toLocaleString("ja-JP").length)}ch`,
              }}
              data-autofocus
              aria-label="支出金額"
              inputMode="numeric"
              autoComplete="off"
              pattern="[0-9,]*"
              value={Number(draft.amount || 0).toLocaleString("ja-JP")}
              onChange={(e) =>
                update(
                  "amount",
                  e.target.value.replace(/[^0-9]/g, "").slice(0, 12),
                )
              }
            />
          </div>
        </div>
        {amounts.length > 0 && (
          <div className="chips recent-amounts">
            {amounts.map((a) => (
              <button
                type="button"
                className="chip"
                key={a}
                onClick={() => update("amount", String(a))}
              >
                {yen(a)}
              </button>
            ))}
          </div>
        )}
        {accountInput && (
          <fieldset className="source-picker">
            <legend>支払元</legend>
            <div className="chips">
              {sources.slice(0, 4).map((a) => (
                <button
                  type="button"
                  className={
                    draft.sourceAccountId === a.id ? "chip selected" : "chip"
                  }
                  aria-pressed={draft.sourceAccountId === a.id}
                  key={a.id}
                  onClick={() => {
                    interacted.current = true;
                    setDraft((old) => ({
                      ...old,
                      sourceAccountId: a.id,
                      paymentMethod:
                        a.kind === "CREDIT_CARD"
                          ? "creditCard"
                          : a.kind === "CASH"
                            ? "cash"
                            : a.kind === "BANK"
                              ? "bank"
                              : "other",
                      creditCardId: a.creditCardId ?? "",
                      paymentChannel:
                        a.kind === "CASH" || a.kind === "BANK"
                          ? "direct"
                          : old.paymentChannel,
                    }));
                  }}
                >
                  {a.name}
                </button>
              ))}
              <button
                type="button"
                className="chip"
                aria-expanded={showAllAccounts}
                onClick={() => setShowAllAccounts(!showAllAccounts)}
              >
                すべて
              </button>
            </div>
            {(showAllAccounts ||
              (!sources
                .slice(0, 4)
                .some((a) => a.id === draft.sourceAccountId) &&
                !!draft.sourceAccountId)) && (
              <Field label="すべての支払元">
                <select
                  value={draft.sourceAccountId}
                  onChange={(e) => {
                    interacted.current = true;
                    const a = sources.find((a) => a.id === e.target.value);
                    setDraft((old) => ({
                      ...old,
                      sourceAccountId: e.target.value,
                      paymentMethod:
                        a?.kind === "CREDIT_CARD"
                          ? "creditCard"
                          : a?.kind === "CASH"
                            ? "cash"
                            : a?.kind === "BANK"
                              ? "bank"
                              : "other",
                      creditCardId: a?.creditCardId ?? "",
                      paymentChannel:
                        a?.kind === "CASH" || a?.kind === "BANK"
                          ? "direct"
                          : old.paymentChannel,
                    }));
                  }}
                >
                  <option value="">選択してください</option>
                  {sources.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {!a.isActive ? "（集計外）" : ""}
                    </option>
                  ))}
                </select>
                <Link to="/money?add=account" onClick={onClose}>
                  支払元を追加
                </Link>
              </Field>
            )}
            {!draft.sourceAccountId && (
              <small>支払元を選んでください。候補は自動確定しません。</small>
            )}
          </fieldset>
        )}
        {!accountInput && (
          <fieldset className="payment-picker">
            <legend>支払方法</legend>
            {(Object.keys(paymentLabels) as PaymentMethod[]).map((p) => (
              <button
                type="button"
                key={p}
                className={draft.paymentMethod === p ? "selected" : ""}
                aria-pressed={draft.paymentMethod === p}
                onClick={() => update("paymentMethod", p)}
              >
                <Wallet size={18} />
                <span>{paymentLabels[p]}</span>
              </button>
            ))}
            <Link to="/money" onClick={onClose}>
              支払元を登録する
            </Link>
          </fieldset>
        )}
        {draft.paymentMethod === "creditCard" && !accountInput && (
          <Field label="利用カード">
            <select
              required
              value={draft.creditCardId}
              onChange={(e) => update("creditCardId", e.target.value)}
            >
              <option value="">選択してください</option>
              {data.cards
                .filter((c) => c.isActive || c.id === expense?.creditCardId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        {draft.paymentMethod === "creditCard" && (
          <Field label="使い方">
            <select
              value={draft.paymentChannel}
              onChange={(e) =>
                update("paymentChannel", e.target.value as PaymentChannel)
              }
            >
              <option value="direct">カードで支払う</option>
              <option value="applePay">Apple Pay</option>
              <option value="other">その他</option>
            </select>
          </Field>
        )}
        {!expense && (
          <ReceiptCapture
            onOpenChange={setReceiptOpen}
            onBusyChange={(busy) => {
              receiptBusyRef.current = busy;
              setReceiptBusy(busy);
            }}
            startOpen={startReceipt}
            onApply={async (candidate) => {
              receiptNeedsReview.current = candidate.needsReview ?? false;
              const source = payableAccounts(data).find(
                (a) => a.id === candidate.sourceAccountId,
              );
              const next: Draft = {
                ...draft,
                amount: String(candidate.amount ?? ""),
                merchant: candidate.merchant ?? "",
                date: candidate.date ?? today,
                categoryId: candidate.categoryId ?? "uncategorized",
                subcategoryId: candidate.subcategoryId ?? "",
                sourceAccountId: source?.id ?? "",
                creditCardId: source?.creditCardId ?? "",
                paymentMethod: candidate.paymentMethod ?? draft.paymentMethod,
                memo: [
                  candidate.time ? "時刻 " + candidate.time : "",
                  candidate.tax !== undefined
                    ? "税額 " + candidate.tax + "円"
                    : "",
                ]
                  .filter(Boolean)
                  .join("\n"),
              };
              setManual(true);
              interacted.current = true;
              setDraft(next);
              setReceiptImage(candidate.imageFile);
              if (source && !candidate.inputOnly) {
                receiptBusyRef.current = false;
                receiptApplying.current = true;
                try {
                  if (!(await save(next, candidate.imageFile)))
                    throw new Error("cancelled");
                } finally {
                  receiptApplying.current = false;
                }
              }
            }}
          />
        )}
        <details className="optional-expense">
          <summary>店名・カテゴリー・日付など（任意）</summary>
          <div className="quick-entry">
            <Sparkles size={17} />
            <input
              aria-label="クイック入力"
              placeholder="サイゼリヤ 1280 クレカ"
              value={quick}
              onChange={(e) => setQuick(e.target.value)}
            />
            <button
              type="button"
              className="text-button"
              onClick={() => {
                const parsed = parseQuickEntry(quick);
                if (parsed.amount) {
                  setManual(false);
                  setDraft((old) => ({
                    ...old,
                    amount: String(parsed.amount),
                    merchant: parsed.merchant,
                    paymentMethod: parsed.paymentMethod ?? old.paymentMethod,
                  }));
                  setQuick("");
                } else toast("「店名 金額」の順で入力してください");
              }}
            >
              反映
            </button>
          </div>
          {data.favorites.length > 0 && (
            <div className="chips">
              {data.favorites.map((f) => (
                <button
                  type="button"
                  key={f.id}
                  className="chip"
                  onClick={() => applyFavorite(f)}
                >
                  <Bookmark size={13} />
                  {f.name}
                </button>
              ))}
            </div>
          )}
          <Field label="店名・内容">
            <input
              name="merchant"
              maxLength={120}
              placeholder="どこで、何に使いましたか？"
              value={draft.merchant}
              onChange={(e) => {
                setManual(false);
                update("merchant", e.target.value);
              }}
            />
          </Field>
          {recent.length > 0 && (
            <div className="chips">
              {recent.map((e) => (
                <button
                  type="button"
                  className="chip"
                  key={e.id}
                  onClick={() => {
                    setManual(false);
                    setDraft((old) => ({
                      ...old,
                      merchant: e.merchant,
                      paymentMethod: e.paymentMethod,
                      creditCardId: e.creditCardId ?? old.creditCardId,
                      sourceAccountId: e.sourceAccountId ?? old.sourceAccountId,
                    }));
                  }}
                >
                  {e.merchant}
                </button>
              ))}
            </div>
          )}
          {frequentCategories.length > 0 && (
            <div className="chips" aria-label="よく使うカテゴリー">
              {frequentCategories.map((c) => (
                <button
                  type="button"
                  className="chip"
                  key={c.id}
                  onClick={() => {
                    setManual(true);
                    setDraft((old) => ({
                      ...old,
                      categoryId: c.id,
                      subcategoryId: "",
                    }));
                  }}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          <div className="form-grid">
            <Field label="カテゴリー">
              <select
                value={draft.categoryId}
                onChange={(e) => {
                  setManual(true);
                  setDraft((old) => ({
                    ...old,
                    categoryId: e.target.value,
                    subcategoryId: "",
                  }));
                }}
              >
                {data.categories
                  .filter((c) => !c.archived || c.id === draft.categoryId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="内訳">
              <select
                value={draft.subcategoryId}
                onChange={(e) => {
                  setManual(true);
                  update("subcategoryId", e.target.value);
                }}
              >
                <option value="">指定なし</option>
                {selectedCategory?.subcategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p className="microcopy">
            {manual ? (
              <>
                <Check size={14} />
                次回からこの分類を使用します
              </>
            ) : suggestion.confidence === "high" ? (
              <>
                <Sparkles size={14} />
                店名から分類しました
              </>
            ) : suggestion.confidence === "medium" ? (
              `${suggestion.source === "pattern" ? "記録からの候補 · " : ""}${selectedCategory?.name}？ 分類を確認してください`
            ) : (
              "カテゴリーはあとから変更できます"
            )}
          </p>
          <Field label="日付">
            <input
              type="date"
              required
              max={today}
              value={draft.date}
              onChange={(e) => update("date", e.target.value)}
            />
          </Field>
          <details>
            <summary>メモ・お気に入り</summary>
            <Field label="メモ">
              <textarea
                rows={2}
                maxLength={1000}
                value={draft.memo}
                onChange={(e) => update("memo", e.target.value)}
              />
            </Field>
            <label className="check-field">
              <input
                type="checkbox"
                checked={favorite}
                onChange={(e) => setFavorite(e.target.checked)}
              />
              この内容をお気に入りに追加
            </label>
          </details>
        </details>
      </AsyncForm>
    </Sheet>
  );
}
