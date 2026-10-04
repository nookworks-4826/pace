import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Coffee,
  Search,
  SlidersHorizontal,
  Trash2,
  Utensils,
  ShoppingBag,
  TrainFront,
  Receipt,
  Pencil,
} from "lucide-react";
import { usePace } from "../app/context";
import { Empty, Field, yen } from "../components/UI";
import { deleteExpense, saveExpense } from "../db";
import { dateKey, monthEnd } from "../domain/dates";
import { paymentLabels } from "../types";
import type { Expense } from "../types";

export function ExpenseRow({
  expense,
  allowDelete = false,
}: {
  expense: Expense;
  allowDelete?: boolean;
}) {
  const { data, today, openExpense, run, toast } = usePace();
  const category = data.categories.find((c) => c.id === expense.categoryId);
  const sub = category?.subcategories.find(
    (s) => s.id === expense.subcategoryId,
  );
  const sourceAccount = data.accounts?.find(
    (account) => account.id === expense.sourceAccountId,
  );
  const refunded = (data.externalTransactions ?? [])
    .filter(
      (row) =>
        row.kind === "refund" &&
        row.relatedExpenseId === expense.id &&
        row.pendingStatus !== "pending" &&
        dateKey(row.date) <= today,
    )
    .reduce((total, row) => total + Math.abs(row.amount), 0);
  const Icon =
    expense.categoryId === "food"
      ? sub?.name === "カフェ"
        ? Coffee
        : Utensils
      : expense.categoryId === "transport"
        ? TrainFront
        : expense.categoryId === "shopping"
          ? ShoppingBag
          : Receipt;
  return (
    <div className="transaction-row">
      <button className="transaction-main" onClick={() => openExpense(expense)}>
        <span
          className="category-icon"
          style={{
            color: category?.color,
            background: `${category?.color ?? "#888888"}14`,
          }}
        >
          <Icon size={20} />
        </span>
        <span className="transaction-text">
          <b>{expense.merchant || expense.description || "支出"}</b>
          <small>
            {sub?.name || category?.name} ·{" "}
            {sourceAccount?.name ??
              (expense.paymentMethod === "creditCard"
                ? (data.cards.find((c) => c.id === expense.creditCardId)
                    ?.name ?? "カード")
                : paymentLabels[expense.paymentMethod])}
            {expense.paymentChannel === "applePay" ? " · Apple Pay" : ""}
            {expense.receiptId
              ? " · レシート"
              : expense.providerId === "moneytree"
                ? " · 保存済み明細"
                : expense.providerId === "mock"
                  ? " · テスト明細"
                  : ""}
          </small>
        </span>
        <span className="transaction-price">
          −{yen(expense.amount)}
          <small>
            {Number(expense.date.slice(5, 7))}/{Number(expense.date.slice(8))}
          </small>
          {refunded > 0 && <small>返金 +{yen(refunded)}</small>}
        </span>
      </button>
      {allowDelete && (
        <div className="transaction-actions">
          <button
            className="icon-button"
            aria-label={`${expense.merchant}を編集`}
            onClick={() => openExpense(expense)}
          >
            <Pencil size={16} />
          </button>
          <button
            className="icon-button"
            aria-label={`${expense.merchant}を削除`}
            onClick={() => {
              if (
                confirm(
                  "削除すると残高や分析結果も再計算されます。削除しますか？",
                )
              )
                void run(async () => {
                  await deleteExpense(expense.id);
                  toast("支出を削除しました", async () => {
                    await saveExpense(expense);
                  });
                });
            }}
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
export function History() {
  const { data, today, openExpense } = usePace();
  const [params] = useSearchParams();
  const queryMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(params.get("month") ?? "")
    ? params.get("month")
    : null;
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(false);
  const [category, setCategory] = useState(params.get("category") ?? "");
  const [card, setCard] = useState(params.get("card") ?? "");
  const [method, setMethod] = useState("");
  const [account, setAccount] = useState(params.get("account") ?? "");
  const [from, setFrom] = useState(
    params.get("from") ?? (queryMonth ? `${queryMonth}-01` : ""),
  );
  const [to, setTo] = useState(
    params.get("to") ?? (queryMonth ? monthEnd(`${queryMonth}-01`) : ""),
  );
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [limit, setLimit] = useState(60);
  const filtered = useMemo(
    () =>
      data.expenses
        .filter((e) => {
          const c = data.categories.find((c) => c.id === e.categoryId);
          const corpus = [
            e.merchant,
            e.description,
            e.memo,
            c?.name,
            c?.subcategories.find((s) => s.id === e.subcategoryId)?.name,
            e.amount.toString(),
            data.accounts?.find((row) => row.id === e.sourceAccountId)?.name,
            data.cards.find((row) => row.id === e.creditCardId)?.name,
            e.paymentChannel === "applePay" ? "Apple Pay" : "",
          ]
            .join(" ")
            .normalize("NFKC")
            .toLowerCase();
          return (
            (!search ||
              corpus.includes(search.normalize("NFKC").toLowerCase())) &&
            (!category || e.categoryId === category) &&
            (!card || e.creditCardId === card) &&
            (!method || e.paymentMethod === method) &&
            (!account || e.sourceAccountId === account) &&
            (!from || e.date >= from) &&
            (!to || e.date <= to) &&
            (!min || e.amount >= Number(min)) &&
            (!max || e.amount <= Number(max))
          );
        })
        .sort(
          (a, b) =>
            b.date.localeCompare(a.date) ||
            b.createdAt.localeCompare(a.createdAt),
        ),
    [data, search, category, card, method, account, from, to, min, max],
  );
  const visible = filtered.slice(0, limit);
  const filteredIds = new Set(filtered.map((row) => row.id));
  const filteredRefundTotal = (data.externalTransactions ?? [])
    .filter(
      (row) =>
        row.kind === "refund" &&
        row.pendingStatus !== "pending" &&
        row.date <= today &&
        (!from || row.date >= from) &&
        (!to || row.date <= to) &&
        row.relatedExpenseId &&
        filteredIds.has(row.relatedExpenseId),
    )
    .reduce((total, row) => total + Math.abs(row.amount), 0);
  const dates = Array.from(new Set(visible.map((e) => e.date)));
  const yesterday = new Date(`${today}T12:00:00+09:00`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const ykey = yesterday.toISOString().slice(0, 10);
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">YOUR RECORDS</span>
          <h1>履歴</h1>
        </div>
        <button
          className={`icon-button ${filters ? "tinted" : ""}`}
          aria-label="絞り込み"
          aria-expanded={filters}
          onClick={() => setFilters(!filters)}
        >
          <SlidersHorizontal size={22} />
        </button>
      </header>
      <div className="search-box">
        <Search size={20} />
        <input
          aria-label="履歴を検索"
          placeholder="店名・金額・口座・メモ"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setLimit(60);
          }}
        />
      </div>
      {filters && (
        <div className="surface filter-panel">
          <div className="form-grid">
            <Field label="開始日">
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field label="終了日">
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <Field label="カテゴリー">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">すべて</option>
                {data.categories.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="支払方法">
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
              >
                <option value="">すべて</option>
                {Object.entries(paymentLabels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="最低金額">
              <input
                type="number"
                min="0"
                value={min}
                onChange={(e) => setMin(e.target.value)}
              />
            </Field>
            <Field label="最高金額">
              <input
                type="number"
                min="0"
                value={max}
                onChange={(e) => setMax(e.target.value)}
              />
            </Field>
          </div>
          <Field label="カード">
            <select value={card} onChange={(e) => setCard(e.target.value)}>
              <option value="">すべて</option>
              {data.cards.map((c) => (
                <option value={c.id} key={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          {(data.accounts?.length ?? 0) > 0 && (
            <Field label="支払元">
              <select
                value={account}
                onChange={(event) => setAccount(event.target.value)}
              >
                <option value="">すべて</option>
                {data.accounts?.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <button
            className="text-button"
            onClick={() => {
              setCategory("");
              setMethod("");
              setCard("");
              setAccount("");
              setFrom("");
              setTo("");
              setMin("");
              setMax("");
              setSearch("");
            }}
          >
            絞り込みを解除
          </button>
        </div>
      )}
      <div className="history-total">
        <span>{filtered.length}件の生活支出</span>
        <strong>
          {yen(
            filtered.reduce((s, e) => s + e.amount, 0) - filteredRefundTotal,
          )}
        </strong>
      </div>
      {filteredRefundTotal > 0 && (
        <p className="hint">
          関連する返金 {yen(filteredRefundTotal)} を差し引いています。
        </p>
      )}
      {filtered.length === 0 ? (
        <Empty
          icon={<Receipt />}
          action={
            <button
              className="button button-primary"
              onClick={() => openExpense()}
            >
              支出を追加
            </button>
          }
        >
          {data.expenses.length
            ? "条件に合う記録がありません"
            : "まだ支出はありません"}
          <br />
          使ったらここから記録できます。
        </Empty>
      ) : (
        dates.map((date) => (
          <section key={date} className="history-group">
            <div className="section-heading">
              <h2>
                {date === today
                  ? "今日"
                  : date === ykey
                    ? "昨日"
                    : `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`}
              </h2>
              <span>
                {yen(
                  filtered
                    .filter((e) => e.date === date)
                    .reduce((s, e) => s + e.amount, 0),
                )}
              </span>
            </div>
            <div className="surface transaction-list">
              {visible
                .filter((e) => e.date === date)
                .map((e) => (
                  <ExpenseRow key={e.id} expense={e} allowDelete />
                ))}
            </div>
          </section>
        ))
      )}
      {filtered.length > limit && (
        <button
          className="button button-secondary full"
          onClick={() => setLimit(limit + 60)}
        >
          さらに60件を表示
        </button>
      )}
      <p className="page-footnote">
        収入・返済・貯金・カード引落は、それぞれの管理画面と「お金のタイムライン」で確認できます。
      </p>
    </div>
  );
}
