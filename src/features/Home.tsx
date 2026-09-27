import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronRight,
  CreditCard,
  Info,
  Landmark,
  Plus,
  Settings2,
  ShieldCheck,
  Sun,
  Target,
  Wallet,
} from "lucide-react";
import { usePace } from "../app/context";
import { Empty, Progress, SectionTitle, Sheet, yen } from "../components/UI";
import { db, updateSettings } from "../db";
import { addMonthsDate, dateOnDay, monthKey } from "../domain/dates";
import {
  calculateDebtBalance,
  calculateSavingsAmount,
  getCardSummary,
  nextDebtPayment,
} from "../domain/finance";
import { APP_NAME } from "../types";
import { FinanceEditor } from "./Management";
import type { Editor } from "./Management";
import { ExpenseRow } from "./History";
import { SpendingPreview } from "./SpendingPreview";
import { moneyAllocation } from "../domain/spendingPreview";

export function Home() {
  const { data, finance: f, today, openExpense, run } = usePace();
  const navigate = useNavigate();
  const [details, setDetails] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const allocation = moneyAllocation(f);
  const negative = f.safeToSpend !== null && f.safeToSpend < 0;
  const attention = !negative && f.pace.ratio !== null && f.pace.ratio > 1.25;
  const remainingDays =
    new Date(
      Number(today.slice(0, 4)),
      Number(today.slice(5, 7)),
      0,
    ).getDate() -
    Number(today.slice(8)) +
    1;
  const dateLabel = new Intl.DateTimeFormat("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Tokyo",
  }).format(new Date(`${today}T12:00:00+09:00`));
  const totalDebt = data.debts.reduce(
    (sum, d) => sum + calculateDebtBalance(d, data.repayments, today),
    0,
  );
  const totalSavings = data.savingsGoals.reduce(
    (sum, g) =>
      sum + calculateSavingsAmount(g, data.savingsContributions, today),
    0,
  );
  let payday = data.settings.salarySchedule
    ? dateOnDay(monthKey(today), data.settings.salarySchedule.payday)
    : null;
  if (payday && payday < today)
    payday = dateOnDay(
      monthKey(addMonthsDate(today, 1)),
      data.settings.salarySchedule!.payday,
    );
  const upcoming = [
    ...f.recurringDue.map((r) => ({
      id: r.id,
      date: r.dueDate,
      name: r.name,
      amount: r.amount,
      type: "固定費 · 確保済み",
      href: "/manage/recurring",
    })),
    ...data.cards
      .map((c) => {
        const s = getCardSummary(data, c, today);
        return {
          id: c.id,
          date: s.nextPaymentDate,
          name: c.name,
          amount: s.estimatedNextPaymentAmount,
          type: "カード引落 · 概算",
          href: "/manage/cards",
        };
      })
      .filter((c) => c.amount > 0),
    ...data.debts.flatMap((d) => {
      const plan = nextDebtPayment(data, d, today);
      return plan
        ? [
            {
              id: d.id,
              date: plan.date,
              name: `${d.lenderName}への返済`,
              amount: plan.amount,
              type: plan.date < today ? "返済予定 · 未確認" : "返済予定",
              href: "/manage/debts",
            },
          ]
        : [];
    }),
    ...(payday
      ? [
          {
            id: "salary",
            date: payday,
            name: "給料日",
            amount: -(data.settings.salarySchedule?.expectedAmount ?? 0),
            type: "給与 · 予想",
            href: "/manage/incomes",
          },
        ]
      : []),
  ]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);
  const checks = [
    {
      id: "balance",
      label: "現在残高",
      ok: f.liquidBalance !== null,
      action: () => setEditor({ mode: "balance" }),
    },
    {
      id: "salary",
      label: "給料日",
      ok: !!data.settings.salarySchedule,
      action: () => setEditor({ mode: "salary" }),
    },
    {
      id: "cards",
      label: "カード",
      ok:
        data.settings.setupReviewed.includes("cards") || data.cards.length > 0,
      action: () => navigate("/manage/cards"),
    },
    {
      id: "debts",
      label: "借入",
      ok:
        data.settings.setupReviewed.includes("debts") || data.debts.length > 0,
      action: () => navigate("/manage/debts"),
    },
    {
      id: "recurring",
      label: "固定費",
      ok:
        data.settings.setupReviewed.includes("recurring") ||
        data.recurringExpenses.length > 0,
      action: () => navigate("/manage/recurring"),
    },
  ];
  const completed = checks.filter((c) => c.ok).length;
  const recent = [...data.expenses]
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
    )
    .slice(0, 4);
  const prior = monthKey(addMonthsDate(today, -1));
  const priorExp = data.expenses.filter((e) => e.date.startsWith(prior));
  const priorIncome = data.incomes
    .filter((e) => e.date.startsWith(prior))
    .reduce((s, i) => s + i.amount, 0);
  const priorSpent = priorExp.reduce((s, e) => s + e.amount, 0);
  return (
    <div className="page home-page">
      <header className="home-header">
        <Link className="brand" to="/">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
          {APP_NAME}
          <span className="brand-dot" />
        </Link>
        <div className="home-actions">
          {data.settings.colorMode !== "light" && (
            <button
              className="icon-button tinted"
              aria-label="明るい表示にする"
              title="明るい表示にする"
              onClick={() =>
                void run(() => updateSettings({ colorMode: "light" }))
              }
            >
              <Sun size={22} />
            </button>
          )}
          <Link to="/settings" className="icon-button" aria-label="設定">
            <Settings2 size={22} />
          </Link>
        </div>
      </header>
      <div className="greeting">
        <div>
          <p className="eyebrow">TODAY, AT YOUR PACE</p>
          <h1>{dateLabel}</h1>
        </div>
        <span className="private-label">
          <ShieldCheck size={14} />
          端末内に保存
        </span>
      </div>
      <button
        className={`hero-card ${negative ? "is-negative" : attention ? "is-caution" : ""}`}
        onClick={() => setDetails(true)}
      >
        <div className="hero-top">
          <span>今使っていい金額</span>
          <Info size={18} />
        </div>
        {f.safeToSpend === null ? (
          <div className="hero-unset">
            現在残高を入力すると
            <br />
            計算できます
          </div>
        ) : (
          <>
            <div
              className="hero-amount"
              key={f.safeToSpend}
              style={
                yen(Math.max(0, f.safeToSpend)).length > 10
                  ? { fontSize: "clamp(1.35rem,6.8vw,2.8rem)" }
                  : undefined
              }
            >
              {yen(Math.max(0, f.safeToSpend))}
            </div>
            <div className="hero-status">
              <span className="status-line" />
              {negative
                ? `不足 ${yen(-f.safeToSpend)}`
                : completed < 5
                  ? "未確認の情報があります · 暫定"
                  : f.monthlyBudget !== null
                    ? f.pace.label
                    : "予定のお金を確保しています"}
            </div>
          </>
        )}
        {allocation && f.liquidBalance !== null && f.liquidBalance > 0 && (
          <div className="money-allocation">
            <div className="money-allocation-track" aria-hidden="true">
              <span style={{ width: `${allocation.freeRatio * 100}%` }} />
            </div>
            <div className="money-allocation-labels">
              <span>
                <i />
                使える分
              </span>
              <span>
                <i />
                予定・未払い分
              </span>
            </div>
          </div>
        )}
        <div className="hero-footer">
          <span>持っているお金</span>
          <strong>
            {f.liquidBalance === null ? "未入力" : yen(f.liquidBalance)}
          </strong>
          <ChevronRight size={16} />
        </div>
      </button>
      <section className="today-card surface">
        <div className="today-top">
          <div>
            <p className="muted">今日の目安</p>
            <div
              className="daily-number"
              style={
                f.dailyAllowance !== null && yen(f.dailyAllowance).length > 10
                  ? { fontSize: "clamp(1rem,4.6vw,1.4rem)" }
                  : undefined
              }
            >
              {f.dailyAllowance === null ? "—" : yen(f.dailyAllowance)}
            </div>
          </div>
          <div className="today-remaining">
            <span>今日はあと</span>
            <strong
              style={
                f.todayRemaining !== null && yen(f.todayRemaining).length > 10
                  ? { fontSize: "clamp(.9rem,4vw,1.2rem)" }
                  : undefined
              }
            >
              {f.todayRemaining === null ? "—" : yen(f.todayRemaining)}
            </strong>
          </div>
        </div>
        <Progress
          value={
            f.dailyAllowance
              ? (f.todaySpent / f.dailyAllowance) * 100
              : f.todaySpent > 0
                ? 100
                : 0
          }
          label="今日の目安に対する支出"
        />
        <div className="today-bottom">
          <span>
            今日使った額 <b>{yen(f.todaySpent)}</b>
          </span>
          <span>
            {f.dailyAllowance
              ? `${Math.round((f.todaySpent / f.dailyAllowance) * 100)}%`
              : "—"}
          </span>
        </div>
        {f.dailyAllowance === null ? (
          <button
            className="text-button"
            onClick={() => setEditor({ mode: "balance" })}
          >
            現在残高を入力する
            <ArrowUpRight size={15} />
          </button>
        ) : (
          <p className="daily-caption">
            {negative
              ? "予定を含めると残高が不足しています。内訳を確認できます。"
              : f.todaySpent > f.dailyAllowance
                ? `今日の目安を${yen(f.todaySpent - f.dailyAllowance)}上回っています。`
                : `月末まであと${remainingDays}日。今日の時点で再計算しています。`}
          </p>
        )}
      </section>
      <button
        className="button button-primary primary-add"
        onClick={() => openExpense()}
      >
        <Plus size={23} />
        支出を記録
      </button>
      {!data.settings.helpDismissed && (
        <div className="help-tip">
          <span>
            カード払いも、使った日に記録。金額をタップすると内訳を確認できます。
          </span>
          <button
            className="text-button"
            onClick={() =>
              void run(() => updateSettings({ helpDismissed: true }))
            }
          >
            わかりました
          </button>
        </div>
      )}
      <SpendingPreview />
      {f.todaySpent === 0 &&
        !data.dailyCheckIns.find(
          (c) => c.date === today && c.noSpendingConfirmed,
        ) && (
          <button
            className="check-in"
            onClick={() =>
              void run(async () => {
                await db.dailyCheckIns.put({
                  date: today,
                  noSpendingConfirmed: true,
                  confirmedAt: new Date().toISOString(),
                });
              }, "今日の確認を保存しました")
            }
          >
            <Check size={18} />
            <span>今日は使っていない</span>
            <small>今日の記録を確認</small>
          </button>
        )}
      {f.todaySpent === 0 &&
        data.dailyCheckIns.find(
          (c) => c.date === today && c.noSpendingConfirmed,
        ) && (
          <p className="confirmed-check">
            <Check size={16} />
            今日は使っていない · 確認済み
          </p>
        )}
      <SectionTitle
        title={`${Number(today.slice(5, 7))}月のまとめ`}
        action="分析を見る"
        onClick={() => navigate("/analytics")}
      />
      <div className="month-summary surface">
        <div>
          <span>
            <ArrowDownLeft size={15} />
            収入
          </span>
          <strong>{yen(f.monthlyIncomeTotal)}</strong>
          <button
            className="text-button"
            onClick={() => setEditor({ mode: "income" })}
          >
            収入を記録
          </button>
        </div>
        <div>
          <span>
            <ArrowUpRight size={15} />
            生活支出
          </span>
          <strong>{yen(f.monthlyExpenseTotal)}</strong>
          <small>カード購入を含む</small>
        </div>
        <div>
          <span>今月あと</span>
          <strong>
            {f.monthlyBudgetRemaining === null
              ? "未設定"
              : yen(f.monthlyBudgetRemaining)}
          </strong>
          <button
            className="text-button"
            onClick={() => setEditor({ mode: "budget" })}
          >
            {f.monthlyBudget === null ? "予算を設定" : "予算を変更"}
          </button>
        </div>
        <div>
          <span>カード未払い</span>
          <strong>{yen(f.cardOutstanding)}</strong>
          <small>引落前のお金</small>
        </div>
      </div>
      {data.settings.lastSeenMonth !== monthKey(today) &&
        priorExp.length > 0 && (
          <div className="surface month-review">
            <span className="eyebrow">LAST MONTH</span>
            <h2>{Number(prior.slice(5, 7))}月の振り返り</h2>
            <p>
              収入 {yen(priorIncome)} · 支出 {yen(priorSpent)}
            </p>
            <p>収支 {yen(priorIncome - priorSpent)}</p>
            <div className="button-row">
              <button
                className="text-button"
                onClick={() => navigate(`/analytics?month=${prior}&report=1`)}
              >
                レポートを見る
              </button>
              <button
                className="text-button"
                onClick={() =>
                  void run(() =>
                    updateSettings({ lastSeenMonth: monthKey(today) }),
                  )
                }
              >
                閉じる
              </button>
            </div>
          </div>
        )}
      <SectionTitle
        title="これから"
        action="すべて見る"
        onClick={() => navigate("/timeline")}
      />
      <section className="surface upcoming-list">
        {upcoming.length === 0 ? (
          <Empty icon={<CalendarDays />}>
            予定はまだありません。
            <br />
            給料日や固定費を設定できます。
          </Empty>
        ) : (
          upcoming.map((item) => (
            <Link className="upcoming-row" key={item.id} to={item.href}>
              <div className="date-block">
                <small>{Number(item.date.slice(5, 7))}月</small>
                <b>{Number(item.date.slice(8))}</b>
              </div>
              <div>
                <strong>{item.name}</strong>
                <small>{item.type}</small>
              </div>
              <div className="upcoming-amount">
                <b>
                  {item.id === "salary"
                    ? item.amount < 0
                      ? `+${yen(-item.amount)}`
                      : "額は未設定"
                    : `−${yen(item.amount)}`}
                </b>
                <span>予定</span>
              </div>
            </Link>
          ))
        )}
      </section>
      <SectionTitle title="お金の行き先" />
      <div className="money-destinations">
        <Link to="/manage/cards" className="surface destination">
          <CreditCard />
          <span>カード未払い</span>
          <strong>{yen(f.cardOutstanding)}</strong>
          <ChevronRight size={16} />
        </Link>
        <Link to="/manage/debts" className="surface destination">
          <Landmark />
          <span>返済残高</span>
          <strong>{yen(totalDebt)}</strong>
          <ChevronRight size={16} />
        </Link>
        <Link to="/manage/savings" className="surface destination">
          <Target />
          <span>貯金</span>
          <strong>{yen(totalSavings)}</strong>
          <ChevronRight size={16} />
        </Link>
      </div>
      {completed < 5 && (
        <section className="setup-card">
          <div className="section-heading">
            <h2>{APP_NAME}をもっと正確に</h2>
            <small>{completed} / 5 完了</small>
          </div>
          <Progress value={(completed / 5) * 100} label="セットアップ進捗" />
          <div className="setup-checks">
            {checks.map((c) => (
              <button
                key={c.id}
                onClick={c.action}
                className={c.ok ? "done" : ""}
              >
                {c.ok ? <Check size={14} /> : <Plus size={14} />} {c.label}
              </button>
            ))}
          </div>
          <p className="hint">
            未入力の予定があると、使っていい金額が実際より多く表示されることがあります。
          </p>
        </section>
      )}
      <SectionTitle
        title="最近の支出"
        action="履歴を見る"
        onClick={() => navigate("/history")}
      />
      <div className="surface transaction-list">
        {recent.length ? (
          recent.map((e) => <ExpenseRow key={e.id} expense={e} />)
        ) : (
          <Empty
            icon={<Wallet />}
            action={
              <button className="text-button" onClick={() => openExpense()}>
                最初の支出を追加
                <Plus size={17} />
              </button>
            }
          >
            まだ支出はありません。
            <br />
            使ったらここから記録できます。
          </Empty>
        )}
      </div>
      <button className="balance-help" onClick={() => setDetails(true)}>
        <Info size={15} />
        この金額が違う？
      </button>
      {details && (
        <Sheet title="今使っていい金額の内訳" onClose={() => setDetails(false)}>
          <p className="hint">
            持っているお金から、すでに使った分と今月までに必要な予定を差し引きます。予想の給与は含みません。
          </p>
          <div className="breakdown">
            {[
              {
                label: "現在使えるお金",
                value: f.liquidBalance,
                mode: "balance",
                url: "",
              },
              {
                label: "カード未払い",
                value: -f.cardOutstanding,
                url: "/manage/cards",
              },
              {
                label: "固定費 · 未確認分",
                value: -f.upcomingFixedCosts,
                url: "/manage/recurring",
              },
              {
                label: "今月の返済予定 · 残り",
                value: -f.debtReserve,
                url: "/manage/debts",
              },
              {
                label: "今月の貯金予定 · 残り",
                value: -f.savingsReserve,
                url: "/manage/savings",
              },
            ].map((row) => (
              <button
                key={row.label}
                onClick={() => {
                  setDetails(false);
                  if (row.mode) setEditor({ mode: "balance" });
                  else navigate(row.url);
                }}
              >
                <span>{row.label}</span>
                <strong>
                  {row.value === null ? "未入力" : yen(row.value)}
                </strong>
                <ChevronRight size={16} />
              </button>
            ))}
            <div className="breakdown-total">
              <span>今使っていい金額</span>
              <strong>
                {f.safeToSpend === null ? "計算待ち" : yen(f.safeToSpend)}
              </strong>
            </div>
          </div>
          {negative && (
            <p className="notice">
              不足 {yen(-f.safeToSpend!)}
              。ホームの使っていい金額は0円と表示します。
            </p>
          )}
          <p className="hint">
            今日の目安＝「今使っていい金額」と「今月の予算残り」の小さい方 ÷
            今日を含む残り{remainingDays}
            日（四捨五入）。予算がなければ使っていい金額から計算します。支出入力後に目安も更新されます。
          </p>
          <button
            className="button button-primary full"
            onClick={() => {
              setDetails(false);
              setEditor({ mode: "balance" });
            }}
          >
            残高を合わせる
          </button>
        </Sheet>
      )}
      {editor && (
        <FinanceEditor editor={editor} onClose={() => setEditor(null)} />
      )}
    </div>
  );
}
