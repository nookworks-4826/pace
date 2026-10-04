import { useState } from "react";
import { usePace } from "../app/context";
import { db, saveExpense, deleteExpense } from "../db";
import {
  AsyncForm,
  Field,
  Sheet,
  stamp,
  textValue,
  yen,
} from "../components/UI";
import { manualDuplicate, transferCandidates } from "../domain/financialImport";
import { suggestCategory, normalizeMerchant } from "../domain/categorization";
import { TransferEditor } from "./Money";
import type { ExternalTransaction, Expense } from "../types";

export function FinancialInbox() {
  const { data, run, toast } = usePace();
  const [selected, setSelected] = useState<ExternalTransaction | null>(null);
  const [transfer, setTransfer] = useState<{
    from?: string;
    to?: string;
    amount: number;
    ids: string[];
  } | null>(null);
  const pending = (data.externalTransactions ?? []).filter(
    (t) => t.kind === "unclassified",
  );
  const pairs = transferCandidates(pending);
  const account = selected
    ? data.accounts?.find((a) => a.id === selected.accountId)
    : null;
  const duplicate = selected ? manualDuplicate(data, selected) : undefined;
  const correctedExpense =
    selected?.amount !== undefined && selected.amount >= 0
      ? data.expenses.find((e) => e.id === selected.linkedRecordId)
      : undefined;
  async function merge(row: ExternalTransaction, existing: Expense) {
    await db.transaction(
      "rw",
      db.expenses,
      db.externalTransactions,
      db.financialAudits,
      async () => {
        await db.expenses.update(existing.id, {
          sourceAccountId: row.accountId,
          externalMergedFromManual: true,
          providerId: row.providerId,
          connectionId: row.connectionId,
          externalTransactionId: row.externalTransactionId,
          externalAccountId: row.externalAccountId,
          pendingStatus: row.pendingStatus,
          balanceEffect: "snapshot",
          updatedAt: new Date().toISOString(),
        });
        await db.externalTransactions.update(row.id, {
          kind: "expense",
          linkedRecordId: existing.id,
        });
        await db.financialAudits.add({
          ...stamp(),
          action: "manual-external-merge",
          recordId: existing.id,
          detail: "手入力と外部明細を利用者が確認して統合",
        });
      },
    );
    setSelected(null);
    toast("1件の支出として統合しました");
  }
  return (
    <>
      <section className="surface financial-inbox">
        <h2>
          確認する明細 <span className="count-badge">{pending.length}</span>
        </h2>
        {pairs.slice(0, 5).map((p) => (
          <button
            className="settings-row"
            key={p.from.id}
            onClick={() =>
              setTransfer({
                from: p.from.accountId,
                to: p.to.accountId,
                amount: -p.from.amount,
                ids: [p.from.id, p.to.id],
              })
            }
          >
            <span>
              <b>お金の移動ですか？</b>
              <small>
                {p.from.description} → {p.to.description}
              </small>
            </span>
            <b>{yen(-p.from.amount)}</b>
          </button>
        ))}
        {pending.slice(0, 30).map((t) => (
          <button
            className="settings-row"
            key={t.id}
            onClick={() => setSelected(t)}
          >
            <span>
              <b>{t.description}</b>
              <small>
                {t.date} ·{" "}
                {data.accounts?.find((a) => a.id === t.accountId)?.name} ·{" "}
                {t.pendingStatus === "pending" ? "未確定" : "要確認"}
              </small>
            </span>
            <b>{yen(t.amount)}</b>
          </button>
        ))}
        {!pending.length && (
          <p className="hint">確認待ちの明細はありません。</p>
        )}
      </section>
      {selected && (
        <Sheet title="明細を確認" onClose={() => setSelected(null)}>
          <p>
            {selected.description} · {yen(selected.amount)}
          </p>
          {duplicate && (
            <div className="inline-alert">
              <p>同じ手入力の記録があります。1件にまとめますか？</p>
              <button
                className="button button-primary"
                onClick={() => void run(() => merge(selected, duplicate))}
              >
                1件に統合する
              </button>
              <small>元のカテゴリー・メモを引き継ぎます。</small>
            </div>
          )}
          {correctedExpense && (
            <div className="inline-alert">
              <p>
                登録した利用が取消・返金に変更されています。元の支出は確認するまで残します。
              </p>
              <button
                className="button button-secondary"
                onClick={() =>
                  void run(async () => {
                    if (
                      !confirm(
                        "利用の取消ですか？元の支出を取り消します。部分返金なら下で返金を選んでください。",
                      )
                    )
                      return;
                    await db.transaction("rw", db.tables, async () => {
                      await deleteExpense(correctedExpense.id);
                      await db.externalTransactions.update(selected.id, {
                        kind: "ignored",
                        linkedRecordId: undefined,
                      });
                      await db.financialAudits.add({
                        ...stamp(),
                        action: "external-purchase-cancelled",
                        recordId: selected.id,
                        detail: "利用者が未確定利用の取消を確認",
                      });
                    });
                    setSelected(null);
                    toast("利用の取消を確認しました");
                  })
                }
              >
                利用の取消として確定
              </button>
            </div>
          )}
          {selected.amount !== 0 && (
            <button
              className="button button-secondary"
              onClick={() => {
                setTransfer({
                  from: selected.amount < 0 ? selected.accountId : undefined,
                  to: selected.amount > 0 ? selected.accountId : undefined,
                  amount: Math.abs(selected.amount),
                  ids: [selected.id],
                });
                setSelected(null);
              }}
            >
              振替・ATM・チャージとして確認
            </button>
          )}
          <AsyncForm
            label="分類を確定"
            onSubmit={async (f) => {
              const kind = textValue(f, "kind");
              const id = crypto.randomUUID();
              const amount = Math.abs(selected.amount);
              if (kind === "expense" && selected.amount >= 0)
                throw new Error("入金は支出として登録できません。");
              if (kind === "income" && selected.amount <= 0)
                throw new Error("出金は収入として登録できません。");
              await db.transaction("rw", db.tables, async () => {
                if (kind === "expense") {
                  if (account?.kind === "CREDIT_CARD" && !account.creditCardId)
                    throw new Error(
                      "口座設定で対応するカードを選んでください。",
                    );
                  const suggestion = suggestCategory(
                    selected.description,
                    data.merchantRules,
                    data.categories,
                  );
                  await saveExpense({
                    ...stamp(),
                    id,
                    amount,
                    date: selected.date,
                    merchant: selected.description,
                    description: "",
                    memo: "",
                    isFixedCost: false,
                    categoryId: suggestion.categoryId,
                    subcategoryId: suggestion.subcategoryId,
                    sourceAccountId: selected.accountId,
                    paymentMethod:
                      account?.kind === "CREDIT_CARD"
                        ? "creditCard"
                        : account?.kind === "CASH"
                          ? "cash"
                          : account?.kind === "BANK"
                            ? "bank"
                            : "other",
                    creditCardId: account?.creditCardId,
                    providerId: selected.providerId,
                    connectionId: selected.connectionId,
                    externalTransactionId: selected.externalTransactionId,
                    externalAccountId: selected.externalAccountId,
                    pendingStatus: selected.pendingStatus,
                    balanceEffect: "snapshot",
                  });
                } else if (kind === "income") {
                  await db.incomes.add({
                    ...stamp(),
                    id,
                    amount,
                    date: selected.date,
                    source: selected.description,
                    memo: "",
                    type: f.get("salary") === "on" ? "salary" : "other",
                    sourceAccountId: selected.accountId,
                    providerId: selected.providerId,
                    connectionId: selected.connectionId,
                    externalTransactionId: selected.externalTransactionId,
                    externalAccountId: selected.externalAccountId,
                    balanceEffect: "snapshot",
                  });
                  if (f.get("salary") === "on")
                    await db.salaryRules.put({
                      ...stamp(),
                      accountId: selected.accountId,
                      normalizedDescription: normalizeMerchant(
                        selected.description,
                      ),
                      enabled: true,
                    });
                } else if (kind === "refund") {
                  if (selected.amount <= 0)
                    throw new Error("返金は入金の明細を選んでください。");
                  const expenseId = textValue(f, "refundExpense");
                  const original = data.expenses.find(
                    (e) => e.id === expenseId,
                  );
                  if (!original)
                    throw new Error("返金元の支出を選んでください。");
                  const already = (data.externalTransactions ?? [])
                    .filter(
                      (t) =>
                        t.kind === "refund" &&
                        t.relatedExpenseId === original.id &&
                        t.id !== selected.id,
                    )
                    .reduce((s, t) => s + t.amount, 0);
                  if (amount + already > original.amount)
                    throw new Error(
                      "元の支出を超える返金です。金額や対象の支出を確認してください。",
                    );
                  await db.externalTransactions.update(selected.id, {
                    kind: "refund",
                    linkedRecordId: undefined,
                    relatedExpenseId: expenseId,
                    balanceEffect: "snapshot",
                  });
                }
                if (kind !== "refund")
                  await db.externalTransactions.update(selected.id, {
                    kind: kind as ExternalTransaction["kind"],
                    linkedRecordId: kind === "ignored" ? undefined : id,
                  });
                await db.financialAudits.add({
                  ...stamp(),
                  action: `external-${kind}`,
                  recordId: selected.id,
                  detail: "利用者が明細の扱いを確定",
                });
              });
              setSelected(null);
              toast("確認しました");
            }}
          >
            <Field label="この明細の扱い">
              <select
                name="kind"
                defaultValue={
                  selected.amount === 0
                    ? "ignored"
                    : correctedExpense
                      ? "refund"
                      : selected.amount > 0
                        ? "income"
                        : "expense"
                }
              >
                {selected.amount < 0 && <option value="expense">支出</option>}
                {selected.amount > 0 && (
                  <option value="income">入金（収入）</option>
                )}
                {selected.amount > 0 && (
                  <option value="refund">返金（収入には含めない）</option>
                )}
                <option value="ignored">集計しない</option>
              </select>
            </Field>
            {selected.amount > 0 && (
              <>
                <label className="check-field">
                  <input name="salary" type="checkbox" />
                  給与入金として記録
                </label>
                <Field label="返金の場合：元の支出">
                  <select
                    name="refundExpense"
                    defaultValue={correctedExpense?.id ?? ""}
                  >
                    <option value="">選択してください</option>
                    {data.expenses
                      .filter((e) => e.date <= selected.date)
                      .slice(-100)
                      .reverse()
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.date} {e.merchant} {yen(e.amount)}
                        </option>
                      ))}
                  </select>
                </Field>
              </>
            )}
            <p className="hint">
              残高に反映済みの明細です。残高からもう一度差し引きません。
            </p>
          </AsyncForm>
        </Sheet>
      )}
      {transfer && (
        <TransferEditor
          initialFrom={transfer.from}
          initialTo={transfer.to}
          initialAmount={transfer.amount}
          externalIds={transfer.ids}
          onClose={() => setTransfer(null)}
        />
      )}
    </>
  );
}
