import { quickActionLabels, orderedQuickActions } from "../domain/quickActions";
import type { QuickActionId } from "../types";
import { Link, useNavigate } from "react-router-dom";
import { Pin } from "lucide-react";
import { usePace } from "../app/context";
import {
  orderHomeCards,
  spendingInsight,
  defaultPersonalization,
  payableAccounts,
} from "../domain/personalization";
import { recordFeatureUse } from "../domain/experienceActions";
import { yen } from "../components/UI";
import { ExpenseRow } from "./History";
import { updateSettings } from "../db";
import { addDaysDate } from "../domain/dates";
import type { HomeCardId } from "../types";
export function HomeQuickActions({
  onReceipt,
  onTransfer,
  onBalance,
  onIncome,
}: {
  onReceipt: () => void;
  onTransfer: () => void;
  onBalance: () => void;
  onIncome: () => void;
}) {
  const { data, run, openExpense } = usePace(),
    navigate = useNavigate(),
    p = data.settings.personalization ?? defaultPersonalization;
  const actions: Record<QuickActionId, () => void> = {
    expense: () => openExpense(),
    receipt: onReceipt,
    transfer: onTransfer,
    balance: onBalance,
    income: onIncome,
    history: () => navigate("/history"),
    fixed: () => navigate("/manage/recurring"),
    inbox: () => navigate("/inbox"),
  };
  return (
    <div className="home-quick-actions">
      {orderedQuickActions(p).map((id) => (
        <button
          key={id}
          className="chip"
          onClick={() => {
            actions[id]();
            void run(() => recordFeatureUse(id));
          }}
        >
          {quickActionLabels[id]}
        </button>
      ))}
    </div>
  );
}
export function AdaptiveHome() {
  const { data, finance, today, run } = usePace(),
    p = data.settings.personalization ?? defaultPersonalization;
  const recentCash = data.expenses.filter(
    (e) => e.date >= addDaysDate(today, -28) && e.date <= today,
  );
  const cashFrequent =
    recentCash.length >= 5 &&
    recentCash.filter((e) => e.paymentMethod === "cash").length /
      recentCash.length >=
      0.5;
  const accountOrder = payableAccounts(data).map((a) => a.id);
  const balances = [...finance.accountBalances].sort(
    (a, b) =>
      (accountOrder.indexOf(a.account.id) < 0
        ? 999
        : accountOrder.indexOf(a.account.id)) -
      (accountOrder.indexOf(b.account.id) < 0
        ? 999
        : accountOrder.indexOf(b.account.id)),
  );
  const titles: Record<HomeCardId, string> = {
    balances: "お金の内訳",
    insight: "記録の傾向",
    recent: "最近の支出",
  };
  return (
    <div className="adaptive-home">
      {orderHomeCards(data, today).map((id) => (
        <section className="surface adaptive-card" key={id}>
          <header>
            <h2>{titles[id]}</h2>
            <button
              className="icon-button"
              aria-label={`${titles[id]}を${p.pinnedCards.includes(id) ? "固定解除" : "固定"}`}
              aria-pressed={p.pinnedCards.includes(id)}
              onClick={() =>
                void run(() =>
                  updateSettings({
                    personalization: {
                      ...p,
                      homeCardOrder: orderHomeCards(data, today),
                      pinnedCards: p.pinnedCards.includes(id)
                        ? p.pinnedCards.filter((x) => x !== id)
                        : [...p.pinnedCards, id],
                    },
                  }),
                )
              }
            >
              <Pin size={17} />
            </button>
          </header>
          {id === "balances" && (
            <>
              <div className="balance-mini-list">
                {balances
                  .filter((b) => b.account.isActive && !b.account.archivedAt)
                  .slice(0, 4)
                  .map((b) => (
                    <Link
                      key={b.account.id}
                      to="/money?verify=1"
                      onClick={() =>
                        void run(() => recordFeatureUse("balance"))
                      }
                    >
                      <span>
                        {b.account.name}
                        <small>
                          {b.isStale
                            ? "確認推奨"
                            : b.lastUpdatedAt
                              ? `${b.lastUpdatedAt.slice(5, 10).replace("-", "/")}に確認`
                              : "未確認"}
                        </small>
                      </span>
                      <b>{b.balance === null ? "未確認" : yen(b.balance)}</b>
                    </Link>
                  ))}
              </div>
              <Link className="text-button" to="/money">
                すべての残高を確認 →
              </Link>
              {p.enabled &&
                cashFrequent &&
                !p.pinnedCards.includes("balances") &&
                orderHomeCards(data, today)[0] === "balances" && (
                  <p className="hint">
                    現金の記録が多いため、残高を見やすく表示しています。
                  </p>
                )}
            </>
          )}
          {id === "insight" && (
            <>
              <p>{spendingInsight(data, today)}</p>
              <Link
                className="text-button"
                to="/analytics"
                onClick={() => void run(() => recordFeatureUse("insight"))}
              >
                内訳を確認 →
              </Link>
            </>
          )}
          {id === "recent" && (
            <>
              {[...data.expenses]
                .sort(
                  (a, b) =>
                    b.date.localeCompare(a.date) ||
                    b.createdAt.localeCompare(a.createdAt),
                )
                .slice(0, 3)
                .map((e) => (
                  <ExpenseRow key={e.id} expense={e} />
                ))}
              {!data.expenses.length && (
                <p className="hint">
                  最初の支出を記録すると、ここに表示します。
                </p>
              )}
              <Link
                className="text-button"
                to="/history"
                onClick={() => void run(() => recordFeatureUse("history"))}
              >
                履歴を見る →
              </Link>
            </>
          )}
        </section>
      ))}
    </div>
  );
}
