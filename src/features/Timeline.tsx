import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, CalendarDays } from "lucide-react";
import { usePace } from "../app/context";
import { Empty, yen } from "../components/UI";
import { addMonthsDate, dateOnDay, monthKey } from "../domain/dates";
import { getCardSummary, nextDebtPayment } from "../domain/finance";

export function Timeline() {
  const { data, finance, today } = usePace();
  const navigate = useNavigate();
  const [limit, setLimit] = useState(80);
  const rows = useMemo(() => {
    const actual = [
      ...data.expenses.map((e) => ({
        id: e.id,
        date: e.date,
        name: e.merchant,
        type: "生活支出",
        amount: -e.amount,
        planned: false,
      })),
      ...data.incomes.map((e) => ({
        id: e.id,
        date: e.date,
        name: e.source,
        type: "収入",
        amount: e.amount,
        planned: false,
      })),
      ...data.cardPayments.map((e) => ({
        id: e.id,
        date: e.date,
        name: data.cards.find((c) => c.id === e.creditCardId)?.name ?? "カード",
        type: "カード引落",
        amount: -e.amount,
        planned: false,
      })),
      ...data.repayments.map((e) => ({
        id: e.id,
        date: e.date,
        name: data.debts.find((d) => d.id === e.debtId)?.lenderName ?? "返済",
        type: "借金返済",
        amount: -e.amount,
        planned: false,
      })),
      ...data.savingsContributions.map((e) => ({
        id: e.id,
        date: e.date,
        name:
          data.savingsGoals.find((g) => g.id === e.savingsGoalId)?.name ??
          "貯金",
        type: "貯金移動",
        amount: -e.amount,
        planned: false,
      })),
      ...data.balanceAdjustments.map((e) => ({
        id: e.id,
        date: e.date,
        name: e.memo || "残高を合わせた",
        type: "残高調整",
        amount: e.difference,
        planned: false,
      })),
      ...(data.transfers ?? []).map((transfer) => ({
        id: `transfer-${transfer.id}`,
        date: transfer.date,
        name: `${data.accounts?.find((account) => account.id === transfer.fromAccountId)?.name ?? "振替元"} → ${data.accounts?.find((account) => account.id === transfer.toAccountId)?.name ?? "振替先"}`,
        type:
          transfer.status === "reversed"
            ? "振替 · 取消済み"
            : "振替 · 生活支出に含まない",
        amount: transfer.amount,
        planned: false,
        isTransfer: true,
      })),
      ...(data.externalTransactions ?? [])
        .filter(
          (row) => row.kind === "refund" && row.pendingStatus !== "pending",
        )
        .map((row) => ({
          id: `refund-${row.id}`,
          date: row.date,
          name: row.description,
          type: "返金 · 新しい収入に含まない",
          amount: Math.abs(row.amount),
          planned: false,
        })),
      ...(data.accountAdjustments ?? []).map((row) => ({
        id: `adjustment-${row.id}`,
        date: row.date,
        name:
          data.accounts?.find((account) => account.id === row.accountId)
            ?.name ?? "口座残高",
        type: "残高調整 · 生活支出に含まない",
        amount: row.newBalance - row.previousBalance,
        planned: false,
      })),
    ];
    const planned = [
      ...finance.recurringDue.map((e) => ({
        id: e.id,
        date: e.dueDate,
        name: e.name,
        type: "固定費 · 確保済み",
        amount: -e.amount,
        planned: true,
      })),
      ...data.cards
        .map((c) => {
          const s = getCardSummary(data, c, today);
          return {
            id: `plan-${c.id}`,
            date: s.nextPaymentDate,
            name: c.name,
            type: "カード引落 · 概算",
            amount: -s.estimatedNextPaymentAmount,
            planned: true,
          };
        })
        .filter((c) => c.amount !== 0),
      ...data.debts.flatMap((d) => {
        const plan = nextDebtPayment(data, d, today);
        return plan
          ? [
              {
                id: `plan-${d.id}`,
                date: plan.date,
                name: d.lenderName,
                type: plan.date < today ? "返済予定 · 未確認" : "返済予定",
                amount: -plan.amount,
                planned: true,
              },
            ]
          : [];
      }),
    ];
    if (data.settings.salarySchedule) {
      const salary = data.settings.salarySchedule;
      let date = dateOnDay(monthKey(today), salary.payday);
      if (date < today) date = addMonthsDate(date, 1);
      planned.push({
        id: "salary",
        date,
        name: "給料日",
        type:
          salary.expectedAmount === null
            ? "給与予定 · 金額未設定"
            : "給与 · 予想",
        amount: salary.expectedAmount ?? 0,
        planned: true,
      });
    }
    return [...planned, ...actual].sort(
      (a, b) =>
        b.date.localeCompare(a.date) || Number(b.planned) - Number(a.planned),
    );
  }, [data, finance.recurringDue, today]);
  return (
    <div className="page">
      <header className="page-header">
        <button
          className="icon-button"
          aria-label="戻る"
          onClick={() => navigate(-1)}
        >
          <ArrowLeft />
        </button>
        <div>
          <span className="eyebrow">MONEY TIMELINE</span>
          <h1>お金のタイムライン</h1>
        </div>
      </header>
      <p className="page-intro">実績と、これからの予定。</p>
      {rows.length === 0 ? (
        <Empty icon={<CalendarDays />}>
          収入や支出、予定を登録すると
          <br />
          ここに並びます。
        </Empty>
      ) : (
        <div className="timeline">
          {rows.slice(0, limit).map((r) => (
            <div
              key={r.id}
              className={`timeline-item ${r.planned ? "planned" : ""}`}
            >
              <span className="timeline-dot" />
              <div className="timeline-date">
                {r.date} {r.planned && <span className="badge">予定</span>}
              </div>
              <div className="surface list-row">
                <div>
                  <b>{r.name}</b>
                  <small>{r.type}</small>
                </div>
                <strong className={r.amount > 0 ? "positive" : ""}>
                  {"isTransfer" in r
                    ? yen(r.amount)
                    : r.amount === 0 && r.planned
                      ? "未設定"
                      : `${r.amount > 0 ? "+" : ""}${yen(r.amount)}`}
                </strong>
              </div>
            </div>
          ))}
        </div>
      )}
      {rows.length > limit && (
        <button
          className="button button-secondary full"
          onClick={() => setLimit(limit + 80)}
        >
          さらに表示
        </button>
      )}
      <p className="hint">
        生活支出とカード引落は別の出来事です。カード引落は支出合計に二重計上しません。予定は入金・支払いを確認するまで残高に反映しません。
      </p>
    </div>
  );
}
