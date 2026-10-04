import { useState } from "react";
import { usePace } from "../app/context";
import {
  AsyncForm,
  Field,
  Sheet,
  money,
  textValue,
  yen,
  stamp,
} from "../components/UI";
import { db } from "../db";
import { fixedCostCandidates } from "../domain/financialActions";
import type { RecurringExpense } from "../types";

export function FixedCostSuggestions() {
  const { data, today, toast } = usePace();
  const [candidate, setCandidate] = useState<
    (typeof fixedCostCandidates)[number] | null
  >(null);
  const [recurringDifference, setRecurringDifference] = useState<{
    recurring: RecurringExpense;
    actual: number;
    expenseId: string;
  } | null>(null);
  const differences = data.expenses
    .filter(
      (e) =>
        e.externalTransactionId &&
        !e.isFixedCost &&
        !data.financialAudits?.some(
          (a) => a.action === "fixed-candidate-ignored" && a.recordId === e.id,
        ),
    )
    .flatMap((e) => {
      const r = data.recurringExpenses.find(
        (r) =>
          r.isActive &&
          r.sourceAccountId === e.sourceAccountId &&
          e.merchant.toLowerCase().includes(r.name.toLowerCase()) &&
          r.amount !== e.amount &&
          r.startDate <= e.date &&
          (!r.endDate || r.endDate >= e.date),
      );
      return r ? [{ recurring: r, actual: e.amount, expenseId: e.id }] : [];
    });
  const accounts = data.accounts?.filter((account) => account.isActive) ?? [];
  if (!accounts.length && !differences.length) return null;
  return (
    <>
      <section className="surface">
        <h2>固定費の候補</h2>
        <p className="hint">
          金額は目安です。追加画面で、実際の金額・支払日・支払元を確認できます。
        </p>
        <div className="chips">
          {accounts.length > 0 &&
            fixedCostCandidates
              .filter(
                (c) => !data.recurringExpenses.some((r) => r.name === c.name),
              )
              .map((c) => (
                <button
                  className="chip"
                  key={c.name}
                  onClick={() => setCandidate(c)}
                >
                  {c.name} · {yen(c.amount)}
                </button>
              ))}
        </div>
        {differences.map((d) => (
          <button
            className="settings-row"
            key={d.expenseId}
            onClick={() => setRecurringDifference(d)}
          >
            <span>
              <b>{d.recurring.name}の金額が違います</b>
              <small>
                予定 {yen(d.recurring.amount)} → 実績 {yen(d.actual)}
              </small>
            </span>
            <span>確認 →</span>
          </button>
        ))}
      </section>
      {candidate && (
        <Sheet
          title={`${candidate.name}を追加`}
          onClose={() => setCandidate(null)}
        >
          <AsyncForm
            onSubmit={async (f) => {
              const a = data.accounts?.find(
                (a) => a.id === textValue(f, "account"),
              );
              if (!a) throw new Error("支払元を選んでください。");
              await db.recurringExpenses.add({
                id: crypto.randomUUID(),
                name: textValue(f, "name"),
                amount: money(f.get("amount")),
                categoryId: "fixed",
                subcategoryId: "",
                paymentMethod:
                  a.kind === "CREDIT_CARD"
                    ? "creditCard"
                    : a.kind === "CASH"
                      ? "cash"
                      : a.kind === "BANK"
                        ? "bank"
                        : "other",
                creditCardId: a.creditCardId,
                sourceAccountId: a.id,
                frequency: "monthly",
                dueDay: Number(f.get("day")),
                startDate: today,
                isActive: true,
                note: "",
              });
              setCandidate(null);
              toast("固定費を追加しました");
            }}
          >
            <Field label="名前">
              <input name="name" required defaultValue={candidate.name} />
            </Field>
            <Field label="金額">
              <input
                name="amount"
                required
                type="number"
                min={1}
                defaultValue={candidate.amount}
              />
            </Field>
            <Field label="支払日">
              <input
                name="day"
                required
                type="number"
                min={1}
                max={31}
                placeholder="1〜31"
              />
            </Field>
            <Field label="支払元">
              <select name="account" required defaultValue="">
                <option value="">選択してください</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
          </AsyncForm>
        </Sheet>
      )}
      {recurringDifference && (
        <Sheet
          title="固定費の金額を確認"
          onClose={() => setRecurringDifference(null)}
        >
          <p>
            実績 {yen(recurringDifference.actual)} · 予定{" "}
            {yen(recurringDifference.recurring.amount)}
          </p>
          <AsyncForm
            label="確認する"
            onSubmit={async (f) => {
              const d = recurringDifference;
              await db.transaction(
                "rw",
                db.expenses,
                db.recurringExpenses,
                db.recurringOccurrences,
                db.financialAudits,
                async () => {
                  const choice = textValue(f, "choice");
                  if (choice === "future")
                    await db.recurringExpenses.update(d.recurring.id, {
                      amount: d.actual,
                    });
                  if (choice !== "ignore") {
                    const e = data.expenses.find((e) => e.id === d.expenseId)!;
                    const due = `${e.date.slice(0, 7)}-${String(Math.min(d.recurring.dueDay, new Date(Number(e.date.slice(0, 4)), Number(e.date.slice(5, 7)), 0).getDate())).padStart(2, "0")}`;
                    const occurrenceId = `${d.recurring.id}:${e.date.slice(0, 7)}`;
                    if (await db.recurringOccurrences.get(occurrenceId))
                      throw new Error("この月の固定費は確認済みです。");
                    await db.expenses.update(d.expenseId, {
                      isFixedCost: true,
                      recurringOccurrenceId: occurrenceId,
                    });
                    await db.recurringOccurrences.put({
                      id: occurrenceId,
                      recurringExpenseId: d.recurring.id,
                      dueDate: due,
                      status: "paid",
                      expenseId: d.expenseId,
                    });
                  } else
                    await db.financialAudits.add({
                      ...stamp(),
                      action: "fixed-candidate-ignored",
                      recordId: d.expenseId,
                      detail:
                        "固定費候補を利用者が見送り。支出・予定は変更しない",
                    });
                },
              );
              setRecurringDifference(null);
              toast("確認しました");
            }}
          >
            <Field label="金額変更の扱い">
              <select name="choice">
                <option value="once">今回だけ実績の金額にする</option>
                <option value="future">今後の予定金額も変更する</option>
                <option value="ignore">固定費として照合しない</option>
              </select>
            </Field>
            <small>
              照合しない場合は通常の支出として残り、固定費の支払い予定も残ります。
            </small>
          </AsyncForm>
        </Sheet>
      )}
    </>
  );
}
