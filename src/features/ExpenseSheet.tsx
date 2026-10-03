import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  Check,
  CreditCard as CardIcon,
  Sparkles,
  Wallet,
} from "lucide-react";
import { usePace } from "../app/context";
import { AsyncForm, Field, Sheet, stamp, yen } from "../components/UI";
import { db, deleteExpense, saveExpense } from "../db";
import {
  suggestCategory,
  parseQuickEntry,
  normalizeMerchant,
} from "../domain/categorization";
import { paymentLabels } from "../types";
import type { Expense, Favorite, PaymentMethod } from "../types";
import type { PaymentChannel } from "../types";
import { ReceiptCapture } from "./ReceiptCapture";

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
  onClose,
}: {
  expense?: Expense;
  onClose: () => void;
}) {
  const { data, today, toast } = usePace();
  const lastExpense = [...data.expenses].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )[0];
  const initialAccount =
    (data.accounts ?? []).find(
      (a) => a.isActive && a.id === lastExpense?.sourceAccountId,
    ) ?? (data.accounts ?? []).find((a) => a.isActive && a.kind === "CASH");
  const blank: Draft = {
    sourceAccountId: initialAccount?.id ?? "",
    paymentChannel: "direct",
    amount: "",
    merchant: "",
    date: today,
    categoryId: "uncategorized",
    subcategoryId: "",
    paymentMethod:
      data.settings.financialAutomationEnabled && initialAccount
        ? initialAccount.kind === "CREDIT_CARD"
          ? "creditCard"
          : initialAccount.kind === "CASH"
            ? "cash"
            : initialAccount.kind === "BANK"
              ? "bank"
              : "other"
        : ([...data.expenses].sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
          )[0]?.paymentMethod ?? "cash"),
    creditCardId:
      initialAccount?.creditCardId ??
      data.cards.find((c) => c.isActive)?.id ??
      "",
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
      : blank,
  );
  const [draftReady, setDraftReady] = useState(Boolean(expense));
  const interacted = useRef(false);
  useEffect(() => {
    if (expense) return;
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
  const [quick, setQuick] = useState("");
  const [manual, setManual] = useState(Boolean(expense));
  const [favorite, setFavorite] = useState(false);
  const [receiptImage, setReceiptImage] = useState<File | undefined>();
  const [receiptBusy, setReceiptBusy] = useState(false);
  const receiptBusyRef = useRef(false);
  const savedRef = useRef(false);
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
    () => suggestCategory(draft.merchant, data.merchantRules, data.categories),
    [draft.merchant, data.merchantRules, data.categories],
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
  const recent = Array.from(
    new Map(
      [...data.expenses]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .filter((e) => e.merchant)
        .map((e) => [e.merchant, e]),
    ).values(),
  ).slice(0, 5);
  const frequentCategories = data.categories
    .map((c) => ({
      ...c,
      uses: data.expenses.filter((e) => e.categoryId === c.id).length,
    }))
    .filter((c) => c.uses > 0 && !c.archived)
    .sort((a, b) => b.uses - a.uses)
    .slice(0, 4);
  const amounts = Array.from(
    new Set(
      [...data.expenses]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((e) => e.amount),
    ),
  ).slice(0, 4);
  function applyFavorite(f: Favorite) {
    setManual(true);
    setDraft((old) => ({
      ...old,
      merchant: f.merchant,
      amount: String(f.amount),
      categoryId: f.categoryId,
      subcategoryId: f.subcategoryId,
      paymentMethod: f.paymentMethod,
      creditCardId: f.creditCardId ?? old.creditCardId,
      sourceAccountId: f.sourceAccountId ?? old.sourceAccountId,
      paymentChannel: f.paymentChannel ?? "direct",
    }));
  }
  async function save() {
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
        (a.isActive || a.id === expense?.sourceAccountId),
    );
    if (data.settings.financialAutomationEnabled && !source)
      throw new Error("支払元を選んでください。");
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
    if (amount >= 100000 && !confirm(`${yen(amount)}で登録しますか？`)) return;
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
      return;
    const row: Expense = {
      ...(expense ?? stamp()),
      amount,
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
      paymentChannel: draft.paymentChannel,
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
    await db.transaction(
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
    );
    savedRef.current = true;
    onClose();
    toast(
      row.paymentMethod === "creditCard"
        ? `記録しました · カード未払いに${yen(amount)}追加`
        : "記録しました",
      async () => {
        if (expense) await saveExpense(expense);
        else await deleteExpense(row.id);
      },
    );
  }
  return (
    <Sheet title={expense ? "支出を編集" : "支出を記録"} onClose={onClose}>
      <AsyncForm
        onSubmit={save}
        disabled={receiptBusy}
        label={expense ? "変更を保存" : "記録する"}
      >
        {!expense && (
          <ReceiptCapture
            onBusyChange={(busy) => {
              receiptBusyRef.current = busy;
              setReceiptBusy(busy);
            }}
            onApply={(candidate) => {
              const possible = (data.accounts ?? []).filter(
                (a) =>
                  a.isActive &&
                  (candidate.paymentMethod === "cash"
                    ? a.kind === "CASH"
                    : candidate.paymentMethod === "creditCard"
                      ? a.kind === "CREDIT_CARD"
                      : candidate.paymentMethod === "other"
                        ? a.kind === "EWALLET"
                        : a.kind === "BANK"),
              );
              setManual(false);
              interacted.current = true;
              setDraft((old) => ({
                ...old,
                amount: candidate.amount
                  ? String(candidate.amount)
                  : old.amount,
                merchant: candidate.merchant || old.merchant,
                date: candidate.date ?? old.date,
                paymentMethod: candidate.paymentMethod ?? old.paymentMethod,
                sourceAccountId: candidate.paymentMethod
                  ? possible.length === 1
                    ? possible[0].id
                    : ""
                  : old.sourceAccountId,
                creditCardId:
                  possible.length === 1
                    ? (possible[0].creditCardId ?? old.creditCardId)
                    : old.creditCardId,
                memo:
                  [
                    candidate.time ? `時刻 ${candidate.time}` : "",
                    candidate.tax ? `税額 ${candidate.tax}円` : "",
                    ...(candidate.products ?? []),
                  ]
                    .filter(Boolean)
                    .join("\n") || old.memo,
              }));
              setReceiptImage(candidate.imageFile);
            }}
          />
        )}
        {expense?.receiptId &&
          data.receipts?.find((r) => r.id === expense.receiptId) && (
            <details>
              <summary>保存したレシート</summary>
              <img
                className="receipt-preview"
                alt="保存したレシート"
                src={`data:${data.receipts.find((r) => r.id === expense.receiptId)!.mimeType};base64,${data.receipts.find((r) => r.id === expense.receiptId)!.imageBase64}`}
              />
            </details>
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
        {data.settings.financialAutomationEnabled && (
          <Field label="支払元">
            <select
              required
              value={draft.sourceAccountId}
              onChange={(e) => {
                const a = data.accounts?.find((a) => a.id === e.target.value);
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
                  creditCardId: a?.creditCardId ?? old.creditCardId,
                }));
              }}
            >
              <option value="">選択してください</option>
              {data.accounts
                ?.filter(
                  (a) =>
                    (a.isActive && a.kind !== "SAVINGS") ||
                    a.id === expense?.sourceAccountId,
                )
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {!a.isActive ? "（集計外）" : ""}
                  </option>
                ))}
            </select>
          </Field>
        )}
        {!data.settings.financialAutomationEnabled && (
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
                {p === "creditCard" ? (
                  <CardIcon size={19} />
                ) : (
                  <Wallet size={19} />
                )}
                <span>{paymentLabels[p]}</span>
              </button>
            ))}
          </fieldset>
        )}
        {draft.paymentMethod === "creditCard" && (
          <Field label="利用カード">
            <select
              required
              value={draft.creditCardId}
              disabled={!!data.settings.financialAutomationEnabled}
              onChange={(e) => update("creditCardId", e.target.value)}
            >
              <option value="">カードを選択</option>
              {data.cards
                .filter((c) => c.isActive || c.id === expense?.creditCardId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.last4 ? ` · ${c.last4}` : ""}
                  </option>
                ))}
            </select>
            <small>
              使った日に支出へ反映。現金残高は引落まで変わりません。
            </small>
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
      </AsyncForm>
    </Sheet>
  );
}
