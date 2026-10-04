import { useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  ArrowLeft,
  CreditCard as CardIcon,
  Plus,
  ArrowUpRight,
  Landmark,
  Target,
  CalendarClock,
  Pencil,
  Trash2,
  Upload,
  Receipt,
} from "lucide-react";
import { usePace } from "../app/context";
import {
  AsyncForm,
  Empty,
  Field,
  Progress,
  Sheet,
  money,
  stamp,
  textValue,
  yen,
} from "../components/UI";
import { db, reconcileLiquidBalance, saveExpense, updateSettings } from "../db";
import {
  calculateCardOutstanding,
  calculateDebtBalance,
  calculateSavingsAmount,
  getCardSummary,
} from "../domain/finance";
import { paymentLabels } from "../types";
import type {
  CreditCard,
  Debt,
  Expense,
  Income,
  PaymentMethod,
  RecurringExpense,
  SavingsGoal,
} from "../types";
import { CardImport } from "./CardImport";
import { FixedCostSuggestions } from "./FixedCostSuggestions";

type Entity = CreditCard | Debt | SavingsGoal | RecurringExpense | Income;
type Mode =
  | "card"
  | "cardPayment"
  | "debt"
  | "repayment"
  | "savings"
  | "contribution"
  | "recurring"
  | "confirmRecurring"
  | "income"
  | "budget"
  | "balance"
  | "salary";
export type Editor = {
  mode: Mode;
  entity?: Entity;
  occurrenceId?: string;
  dueDate?: string;
};
export function FinanceEditor({
  editor,
  onClose,
  onSaved,
}: {
  editor: Editor;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { data, today, finance, toast } = usePace();
  const { mode, entity } = editor;
  const [method, setMethod] = useState<PaymentMethod>(
    (entity as RecurringExpense)?.paymentMethod ?? "bank",
  );
  const [cashReceived, setCashReceived] = useState(
    (entity as Debt)?.cashReceived ?? false,
  );
  const accountMode = data.settings.financialAutomationEnabled === true;
  const salaryCycle = finance.cycle.mode === "salary";
  const [repaymentActive, setRepaymentActive] = useState(
    entity ? (entity as Debt).reserveForCurrentBudget !== false : false,
  );
  const accountSelectionModes = [
    "income",
    "cardPayment",
    "repayment",
    "contribution",
    "recurring",
    "confirmRecurring",
  ];
  const needsAccount = accountMode && accountSelectionModes.includes(mode);
  const effectiveMethod =
    mode === "confirmRecurring"
      ? (entity as RecurringExpense).paymentMethod
      : method;
  const eligibleAccounts = (data.accounts ?? []).filter((account) => {
    if (!account.isActive) return false;
    if (mode === "cardPayment") return account.kind === "BANK";
    if (mode === "income" || mode === "repayment" || mode === "contribution")
      return account.kind !== "CREDIT_CARD" && account.isSpendable;
    return effectiveMethod === "creditCard"
      ? account.kind === "CREDIT_CARD" &&
          !!account.creditCardId &&
          (mode !== "confirmRecurring" ||
            account.creditCardId === (entity as RecurringExpense).creditCardId)
      : effectiveMethod === "cash"
        ? account.kind === "CASH"
        : effectiveMethod === "bank" || effectiveMethod === "debit"
          ? account.kind === "BANK"
          : account.kind === "EWALLET" || account.kind === "OTHER";
  });
  const accountField = needsAccount ? (
    <Field label={mode === "income" ? "入金先" : "支払元"}>
      <select
        key={`${mode}-${effectiveMethod}`}
        name="sourceAccountId"
        required
        defaultValue={
          (entity as Income | RecurringExpense)?.sourceAccountId ??
          (eligibleAccounts.length === 1 ? eligibleAccounts[0].id : "")
        }
      >
        <option value="">選択してください</option>
        {eligibleAccounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name}
          </option>
        ))}
      </select>
      {eligibleAccounts.length === 0 && (
        <Link className="text-button" to="/money" onClick={onClose}>
          口座を追加する
        </Link>
      )}
    </Field>
  ) : null;
  const titles: Record<Mode, string> = {
    card: "カードを設定",
    cardPayment: "カード引落を記録",
    debt: "借入を設定",
    repayment: "返済を記録",
    savings: "貯金目標を設定",
    contribution: "貯金への移動を記録",
    recurring: "固定費を設定",
    confirmRecurring: "固定費の支払いを確認",
    income: "収入を記録",
    budget: salaryCycle ? "今期の予算" : "今月の予算",
    balance: "残高を合わせる",
    salary: "給料日の予定",
  };
  const cat =
    (entity as RecurringExpense)?.categoryId ??
    data.categories.find((c) => c.name === "固定費")?.id ??
    data.categories[0]?.id;
  const [category, setCategory] = useState(cat);
  const amountField = (
    label: string,
    value?: number,
    allowZero = false,
    name = "amount",
  ) => (
    <Field label={label}>
      <input
        name={name}
        type="number"
        inputMode="numeric"
        required
        min={allowZero ? 0 : 1}
        max={999999999999}
        step="1"
        defaultValue={value}
        placeholder="0"
      />
    </Field>
  );
  const dateField = (
    value = today,
    label = "日付",
    name = "date",
    future = false,
  ) => (
    <Field label={label}>
      <input
        name={name}
        type="date"
        required
        max={future ? undefined : today}
        defaultValue={value}
      />
    </Field>
  );
  const memoField = (value = "") => (
    <Field label="メモ（任意）">
      <textarea name="memo" maxLength={1000} defaultValue={value} rows={2} />
    </Field>
  );
  const selectedBudget = data.budgets.find(
    (b) =>
      b.year === Number(finance.cycle.start.slice(0, 4)) &&
      b.month === Number(finance.cycle.start.slice(5, 7)),
  );
  async function submit(f: FormData) {
    const date = textValue(f, "date") || today;
    const now = new Date().toISOString();
    const sourceAccountId = textValue(f, "sourceAccountId") || undefined;
    const sourceAccount = eligibleAccounts.find(
      (account) => account.id === sourceAccountId,
    );
    if (needsAccount && !sourceAccount)
      throw new Error(
        mode === "income"
          ? "入金先の口座を選んでください。"
          : "支払元の口座を選んでください。",
      );
    if (
      [
        "income",
        "cardPayment",
        "repayment",
        "contribution",
        "confirmRecurring",
      ].includes(mode) &&
      date > today
    )
      throw new Error("実績には今日以前の日付を指定してください。");
    const a = f.has("amount")
      ? money(f.get("amount"), ["balance", "budget", "card"].includes(mode))
      : 0;
    if (
      a >= 100000 &&
      [
        "income",
        "repayment",
        "contribution",
        "cardPayment",
        "confirmRecurring",
      ].includes(mode) &&
      !confirm(`${yen(a)}で記録しますか？`)
    )
      return;
    switch (mode) {
      case "card": {
        const old = entity as CreditCard | undefined;
        await db.cards.put({
          ...old,
          ...(old ? {} : stamp()),
          id: old?.id ?? crypto.randomUUID(),
          createdAt: old?.createdAt ?? now,
          updatedAt: now,
          name: textValue(f, "name"),
          last4: textValue(f, "last4"),
          closingDay: Number(f.get("closingDay")),
          paymentDay: Number(f.get("paymentDay")),
          paymentMonthOffset: Number(f.get("offset")) as 1 | 2,
          openingOutstanding: money(f.get("opening"), true),
          isActive: f.get("active") === "on",
        });
        await updateSettings({
          setupReviewed: [
            ...new Set([...data.settings.setupReviewed, "cards"]),
          ],
        });
        break;
      }
      case "cardPayment": {
        const card = entity as CreditCard;
        const outstanding = calculateCardOutstanding(data, card.id, today);
        if (a > outstanding)
          throw new Error("現在の未払い額を超える引落は登録できません。");
        await db.cardPayments.add({
          ...stamp(),
          sourceAccountId,
          creditCardId: card.id,
          amount: a,
          date,
          memo: textValue(f, "memo"),
        });
        break;
      }
      case "debt": {
        const old = entity as Debt | undefined;
        const opening = money(f.get("opening"), true),
          original = money(f.get("original"));
        if (opening > original)
          throw new Error("開始時の残高は、元の借入額以下にしてください。");
        const repaid = data.repayments
          .filter((r) => r.debtId === old?.id)
          .reduce((s, r) => s + r.amount, 0);
        if (opening < repaid)
          throw new Error("開始時残高が記録済みの返済額を下回っています。");
        await db.debts.put({
          ...(old ?? stamp()),
          lenderName: textValue(f, "lender"),
          title: textValue(f, "name"),
          originalAmount: original,
          openingBalance: opening,
          currentBalance: opening - repaid,
          startedAt: textValue(f, "startedAt"),
          plannedMonthlyPayment: money(f.get("planned"), true),
          nextPaymentDate: textValue(f, "nextDate"),
          note: textValue(f, "memo"),
          isEstimated: f.get("estimated") === "on",
          cashReceived,
          reserveForCurrentBudget: repaymentActive,
          status: opening - repaid > 0 ? "active" : "paid",
          updatedAt: now,
        });
        await updateSettings({
          setupReviewed: [
            ...new Set([...data.settings.setupReviewed, "debts"]),
          ],
        });
        break;
      }
      case "repayment": {
        const debt = entity as Debt;
        const balance = calculateDebtBalance(debt, data.repayments, today);
        if (a > balance)
          throw new Error("借金残高を超える返済は登録できません。");
        await db.transaction("rw", db.debts, db.repayments, async () => {
          await db.repayments.add({
            id: crypto.randomUUID(),
            createdAt: now,
            updatedAt: now,
            sourceAccountId,
            debtId: debt.id,
            amount: a,
            date,
            memo: textValue(f, "memo"),
          });
          await db.debts.update(debt.id, {
            currentBalance: balance - a,
            status: balance - a === 0 ? "paid" : "active",
            updatedAt: now,
          });
        });
        break;
      }
      case "savings": {
        const old = entity as SavingsGoal | undefined;
        const opening = money(f.get("opening"), true);
        const contributed = data.savingsContributions
          .filter((c) => c.savingsGoalId === old?.id)
          .reduce((s, c) => s + c.amount, 0);
        await db.savingsGoals.put({
          id: old?.id ?? crypto.randomUUID(),
          createdAt: old?.createdAt ?? now,
          name: textValue(f, "name"),
          targetAmount: money(f.get("target")),
          openingAmount: opening,
          currentAmount: opening + contributed,
          targetDate: textValue(f, "targetDate"),
          monthlyTarget: money(f.get("planned"), true),
        });
        break;
      }
      case "contribution": {
        const goal = entity as SavingsGoal;
        await db.transaction(
          "rw",
          db.savingsGoals,
          db.savingsContributions,
          async () => {
            await db.savingsContributions.add({
              id: crypto.randomUUID(),
              createdAt: now,
              updatedAt: now,
              sourceAccountId,
              savingsGoalId: goal.id,
              amount: a,
              date,
              memo: textValue(f, "memo"),
            });
            const current =
              calculateSavingsAmount(goal, data.savingsContributions, today) +
              a;
            await db.savingsGoals.update(goal.id, {
              currentAmount: current,
              completedAt: current >= goal.targetAmount ? now : undefined,
            });
          },
        );
        break;
      }
      case "recurring": {
        const old = entity as RecurringExpense | undefined;
        const cardId = textValue(f, "card");
        if (method === "creditCard" && !cardId)
          throw new Error("利用カードを選んでください。");
        if (
          sourceAccount?.kind === "CREDIT_CARD" &&
          sourceAccount.creditCardId !== cardId
        )
          throw new Error("支払元と利用カードをそろえてください。");
        const start = textValue(f, "startDate"),
          end = textValue(f, "endDate");
        if (end && end < start)
          throw new Error("終了日は開始日以降にしてください。");
        await db.recurringExpenses.put({
          id: old?.id ?? crypto.randomUUID(),
          name: textValue(f, "name"),
          amount: a,
          categoryId: category,
          subcategoryId: textValue(f, "subcategory"),
          paymentMethod: method,
          creditCardId: method === "creditCard" ? cardId : undefined,
          sourceAccountId,
          frequency: textValue(f, "frequency") as "monthly" | "yearly",
          dueDay: Number(f.get("dueDay")),
          startDate: start,
          endDate: end || undefined,
          isActive: f.get("active") === "on",
          note: textValue(f, "memo"),
        });
        await updateSettings({
          setupReviewed: [
            ...new Set([...data.settings.setupReviewed, "recurring"]),
          ],
        });
        break;
      }
      case "confirmRecurring": {
        const recurring = entity as RecurringExpense;
        const occurrenceId = editor.occurrenceId!;
        if (await db.recurringOccurrences.get(occurrenceId))
          throw new Error("この支払いは確認済みです。");
        const expense: Expense = {
          ...stamp(),
          amount: a,
          date,
          merchant: recurring.name,
          description: "",
          categoryId: recurring.categoryId,
          subcategoryId: recurring.subcategoryId,
          paymentMethod: recurring.paymentMethod,
          creditCardId: recurring.creditCardId,
          sourceAccountId,
          balanceEffect: accountMode ? "ledger" : undefined,
          pendingStatus:
            recurring.paymentMethod === "creditCard" ? "pending" : undefined,
          memo: textValue(f, "memo"),
          isFixedCost: true,
          recurringOccurrenceId: occurrenceId,
        };
        await saveExpense(expense);
        break;
      }
      case "income": {
        const old = entity as Income | undefined;
        await db.incomes.put({
          ...(old ?? stamp()),
          amount: a,
          date,
          source: textValue(f, "source"),
          memo: textValue(f, "memo"),
          type: textValue(f, "type") as Income["type"],
          sourceAccountId,
          balanceEffect: old?.externalTransactionId
            ? (old.balanceEffect ?? "snapshot")
            : accountMode
              ? "ledger"
              : undefined,
          updatedAt: now,
        });
        break;
      }
      case "budget": {
        const categoryBudgets: Record<string, number> = {};
        for (const c of data.categories) {
          const v = Number(f.get(`cat-${c.id}`));
          if (v > 0) categoryBudgets[c.id] = money(f.get(`cat-${c.id}`));
        }
        if (Object.values(categoryBudgets).reduce((s, v) => s + v, 0) > a)
          throw new Error("カテゴリー予算の合計が期間の予算を超えています。");
        await db.budgets.put({
          ...(selectedBudget ?? stamp()),
          year: Number(finance.cycle.start.slice(0, 4)),
          month: Number(finance.cycle.start.slice(5, 7)),
          totalBudget: a,
          categoryBudgets,
          updatedAt: now,
        });
        break;
      }
      case "balance": {
        if (accountMode)
          throw new Error("「お金」画面で口座ごとに残高を合わせてください。");
        await reconcileLiquidBalance(a, today, textValue(f, "memo"));
        await updateSettings({
          setupReviewed: [
            ...new Set([...data.settings.setupReviewed, "balance"]),
          ],
        });
        break;
      }
      case "salary": {
        await updateSettings({
          salarySchedule: {
            payday: Number(f.get("payday")),
            expectedAmount: textValue(f, "expected")
              ? money(f.get("expected"), true)
              : null,
            variableIncome: f.get("variable") === "on",
          },
          setupReviewed: [
            ...new Set([...data.settings.setupReviewed, "salary"]),
          ],
        });
        break;
      }
    }
    onSaved?.();
    onClose();
    toast("保存しました");
  }
  return (
    <Sheet title={titles[mode]} onClose={onClose}>
      <AsyncForm onSubmit={submit}>
        {mode === "card" && (
          <>
            <Field label="カード名">
              <input
                name="name"
                required
                maxLength={60}
                defaultValue={(entity as CreditCard)?.name}
                placeholder="例：Visa"
              />
            </Field>
            <Field label="下4桁（任意）">
              <input
                name="last4"
                inputMode="numeric"
                pattern="[0-9]{4}|^$"
                maxLength={4}
                defaultValue={(entity as CreditCard)?.last4}
              />
            </Field>
            <div className="form-grid">
              <Field label="締め日（31＝月末）">
                <input
                  name="closingDay"
                  type="number"
                  min="1"
                  max="31"
                  required
                  defaultValue={(entity as CreditCard)?.closingDay}
                  placeholder="明細で確認して入力"
                />
              </Field>
              <Field label="支払日">
                <input
                  name="paymentDay"
                  type="number"
                  min="1"
                  max="31"
                  required
                  defaultValue={(entity as CreditCard)?.paymentDay ?? 10}
                />
              </Field>
            </div>
            <Field label="締め月から支払いまで">
              <select
                name="offset"
                defaultValue={(entity as CreditCard)?.paymentMonthOffset ?? 1}
              >
                <option value="1">翌月</option>
                <option value="2">翌々月</option>
              </select>
            </Field>
            {amountField(
              "記録開始前からのカード未払い",
              (entity as CreditCard)?.openingOutstanding ?? 0,
              true,
              "opening",
            )}
            <p className="hint">
              すでにこのアプリに記録したカード利用は含めません。請求額はカード会社の明細で確認してください。
            </p>
            <label className="check-field">
              <input
                name="active"
                type="checkbox"
                defaultChecked={(entity as CreditCard)?.isActive ?? true}
              />
              利用中のカード
            </label>
          </>
        )}
        {mode === "debt" && (
          <>
            <Field label="貸してくれた人・会社">
              <input
                required
                name="lender"
                defaultValue={(entity as Debt)?.lenderName}
                placeholder="例：親"
                maxLength={80}
              />
            </Field>
            <Field label="借入の内容">
              <input
                required
                name="name"
                defaultValue={(entity as Debt)?.title}
                placeholder="例：海外渡航費"
                maxLength={100}
              />
            </Field>
            <div className="form-grid">
              {amountField(
                "元の借入額",
                (entity as Debt)?.originalAmount,
                false,
                "original",
              )}
              {amountField(
                "記録開始時の返済残高",
                (entity as Debt)?.openingBalance,
                true,
                "opening",
              )}
            </div>
            {dateField(
              (entity as Debt)?.startedAt ?? today,
              "借入日",
              "startedAt",
            )}
            <label className="check-field">
              <input
                name="repaymentActive"
                type="checkbox"
                checked={repaymentActive}
                onChange={(event) => setRepaymentActive(event.target.checked)}
              />
              返済開始・今期のお金を確保する
            </label>
            {!repaymentActive && (
              <p className="hint">
                残高は表示します。返済開始までは使っていい金額から差し引きません。
              </p>
            )}
            {amountField(
              "毎月の返済予定",
              (entity as Debt)?.plannedMonthlyPayment ?? 0,
              true,
              "planned",
            )}
            {dateField(
              (entity as Debt)?.nextPaymentDate ?? today,
              "返済予定日",
              "nextDate",
              true,
            )}
            <label className="check-field">
              <input
                name="estimated"
                type="checkbox"
                defaultChecked={(entity as Debt)?.isEstimated}
              />
              残高は概算です
            </label>
            <label className="check-field">
              <input
                type="checkbox"
                checked={cashReceived}
                disabled={!!entity || accountMode}
                onChange={(e) => setCashReceived(e.target.checked)}
              />
              今回、現金を受け取る借入
            </label>
            <p className="hint">
              {accountMode
                ? "受け取った借入は「お金」画面で実際の口座残高を合わせてください。"
                : "既存の借金や、現在残高に含めた借入はオフにします。オンの場合は開始時残高を持っているお金に加えます。"}
            </p>
            {memoField((entity as Debt)?.note)}
          </>
        )}
        {mode === "savings" && (
          <>
            <Field label="目標名">
              <input
                required
                name="name"
                maxLength={80}
                defaultValue={(entity as SavingsGoal)?.name}
                placeholder="例：次の旅へ"
              />
            </Field>
            {amountField(
              "目標額",
              (entity as SavingsGoal)?.targetAmount,
              false,
              "target",
            )}
            {amountField(
              "すでに別にしてある貯金",
              (entity as SavingsGoal)?.openingAmount ?? 0,
              true,
              "opening",
            )}
            {amountField(
              "毎月の貯金予定",
              (entity as SavingsGoal)?.monthlyTarget ?? 0,
              true,
              "planned",
            )}
            <Field label="目標日（任意）">
              <input
                name="targetDate"
                type="date"
                defaultValue={(entity as SavingsGoal)?.targetDate}
              />
            </Field>
            <p className="hint">
              すでにある貯金は、現在の銀行＋現金残高から除いて入力してください。これからの移動は残高から差し引きます。
            </p>
          </>
        )}
        {mode === "recurring" && (
          <>
            <Field label="名前">
              <input
                name="name"
                required
                maxLength={100}
                defaultValue={(entity as RecurringExpense)?.name}
                placeholder="例：スマホ・サブスク"
              />
            </Field>
            {amountField("支払予定額", (entity as RecurringExpense)?.amount)}
            <div className="form-grid">
              <Field label="頻度">
                <select
                  name="frequency"
                  defaultValue={
                    (entity as RecurringExpense)?.frequency ?? "monthly"
                  }
                >
                  <option value="monthly">毎月</option>
                  <option value="yearly">毎年（開始月）</option>
                </select>
              </Field>
              <Field label="支払日（31＝月末）">
                <input
                  name="dueDay"
                  type="number"
                  min="1"
                  max="31"
                  defaultValue={(entity as RecurringExpense)?.dueDay ?? 27}
                  required
                />
              </Field>
            </div>
            {dateField(
              (entity as RecurringExpense)?.startDate ?? today,
              "管理開始日",
              "startDate",
              true,
            )}
            <Field label="終了日（任意）">
              <input
                name="endDate"
                type="date"
                defaultValue={(entity as RecurringExpense)?.endDate}
              />
            </Field>
            <Field label="カテゴリー">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {data.categories.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="内訳">
              <select
                name="subcategory"
                defaultValue={(entity as RecurringExpense)?.subcategoryId ?? ""}
              >
                <option value="">指定なし</option>
                {data.categories
                  .find((c) => c.id === category)
                  ?.subcategories.map((c) => (
                    <option value={c.id} key={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="支払方法">
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as PaymentMethod)}
              >
                {Object.entries(paymentLabels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            {method === "creditCard" && (
              <Field label="カード">
                <select
                  name="card"
                  required
                  defaultValue={(entity as RecurringExpense)?.creditCardId}
                >
                  <option value="">選択してください</option>
                  {data.cards.map((c) => (
                    <option value={c.id} key={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {accountField}
            <label className="check-field">
              <input
                name="active"
                type="checkbox"
                defaultChecked={(entity as RecurringExpense)?.isActive ?? true}
              />
              この固定費を有効にする
            </label>
            {memoField((entity as RecurringExpense)?.note)}
          </>
        )}
        {[
          "cardPayment",
          "repayment",
          "contribution",
          "confirmRecurring",
        ].includes(mode) && (
          <>
            <div className="note-panel">
              {mode === "cardPayment"
                ? `${(entity as CreditCard).name}の引落。生活支出には加算しません。`
                : mode === "repayment"
                  ? `${(entity as Debt).lenderName}への返済。生活支出とは分けて記録します。`
                  : mode === "contribution"
                    ? `${(entity as SavingsGoal).name}へ実際に移した金額を入力します。`
                    : `${(entity as RecurringExpense).name} · この支払いは発生しましたか？ 金額は変更できます。`}
            </div>
            {amountField(
              "実際の金額",
              mode === "confirmRecurring"
                ? (entity as RecurringExpense).amount
                : mode === "cardPayment"
                  ? calculateCardOutstanding(data, entity!.id, today)
                  : mode === "repayment"
                    ? Math.min(
                        (entity as Debt).plannedMonthlyPayment,
                        calculateDebtBalance(
                          entity as Debt,
                          data.repayments,
                          today,
                        ),
                      )
                    : (entity as SavingsGoal).monthlyTarget,
            )}
            {dateField()}
            {accountField}
            {memoField()}
          </>
        )}
        {mode === "income" && (
          <>
            {amountField("入金された金額", (entity as Income)?.amount)}
            <Field label="収入元">
              <input
                name="source"
                required
                maxLength={100}
                defaultValue={(entity as Income)?.source ?? "給料"}
                placeholder="例：アルバイト"
              />
            </Field>
            <Field label="種類">
              <select
                name="type"
                defaultValue={(entity as Income)?.type ?? "salary"}
              >
                <option value="salary">給料</option>
                <option value="temporary">臨時収入</option>
                <option value="other">その他</option>
              </select>
            </Field>
            {dateField((entity as Income)?.date)}
            {accountField}
            {memoField((entity as Income)?.memo)}
            <p className="hint">
              入金済みの金額だけを記録します。給与の予想額は給料日の設定へ。
            </p>
          </>
        )}
        {mode === "budget" && (
          <>
            {amountField(
              salaryCycle
                ? "今期の生活支出予算"
                : `${Number(today.slice(5, 7))}月の生活支出予算`,
              selectedBudget?.totalBudget,
              true,
            )}
            {salaryCycle && (
              <p className="hint">
                {finance.cycle.start}〜{finance.cycle.end}
              </p>
            )}
            <p className="hint">
              カード購入も含みます。返済・貯金・カード引落は含みません。0円の予算も設定できます。
            </p>
            <details>
              <summary>カテゴリーごとの予算（任意）</summary>
              {data.categories.map((c) => (
                <div key={c.id}>
                  {amountField(
                    c.name,
                    selectedBudget?.categoryBudgets[c.id] ?? 0,
                    true,
                    `cat-${c.id}`,
                  )}
                </div>
              ))}
            </details>
          </>
        )}
        {mode === "balance" && (
          <>
            <p className="hint">
              銀行＋現金など、今すぐ使える合計を入力します。貯金として別にしたお金は除きます。カード未払いは別に差し引くため、ここでは差し引きません。
            </p>
            {finance.liquidBalance !== null && (
              <div className="inline-total">
                <span>現在の計算残高</span>
                <strong>{yen(finance.liquidBalance)}</strong>
              </div>
            )}
            {amountField("実際の銀行＋現金残高", undefined, true)}
            {memoField()}
            <p className="hint">
              差額は調整履歴として保存し、収入・生活支出には含めません。
            </p>
          </>
        )}
        {mode === "salary" && (
          <>
            <Field label="給料日（31＝月末）">
              <input
                name="payday"
                required
                type="number"
                min="1"
                max="31"
                defaultValue={data.settings.salarySchedule?.payday ?? 10}
              />
            </Field>
            <Field label="予想額（不明なら空欄）">
              <input
                name="expected"
                type="number"
                min="0"
                max="999999999999"
                step="1"
                defaultValue={
                  data.settings.salarySchedule?.expectedAmount ?? ""
                }
              />
            </Field>
            <label className="check-field">
              <input
                name="variable"
                type="checkbox"
                defaultChecked={
                  data.settings.salarySchedule?.variableIncome ?? true
                }
              />
              月によって金額が変わる
            </label>
            <p className="hint">
              予想給与は使っていい金額に含めません。入金後に「収入を記録」してください。
            </p>
          </>
        )}
      </AsyncForm>
    </Sheet>
  );
}

export function Management() {
  const { section = "cards" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, finance, today, run, toast, openExpense } = usePace();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [importing, setImporting] = useState(false);
  const [pendingImport, setPendingImport] = useState(false);
  useEffect(() => {
    if (section === "cards" && searchParams.get("import") === "1")
      setImporting(true);
  }, [section, searchParams]);
  const closeImport = () => {
    setImporting(false);
    if (searchParams.has("import")) {
      const next = new URLSearchParams(searchParams);
      next.delete("import");
      setSearchParams(next, { replace: true });
    }
  };
  const meta: Record<string, { title: string; subtitle: string; mode: Mode }> =
    {
      cards: {
        title: "カード",
        subtitle: "使った分を、先に見えるように。",
        mode: "card",
      },
      debts: {
        title: "借入と返済",
        subtitle: "返す予定も、今の残高も。",
        mode: "debt",
      },
      savings: {
        title: "貯金",
        subtitle: "これからの楽しみに、少しずつ。",
        mode: "savings",
      },
      recurring: {
        title: "固定費",
        subtitle: "いつもの支払いを、先に確保。",
        mode: "recurring",
      },
      incomes: {
        title: "収入",
        subtitle: "実際に入ったお金を記録。",
        mode: "income",
      },
    };
  const current = meta[section] ?? meta.cards;
  async function removeEntity(type: string, id: string) {
    if (!confirm("削除すると残高や分析結果も再計算されます。削除しますか？"))
      return;
    await run(async () => {
      if (type === "card") {
        if (
          (data.accounts ?? []).some((account) => account.creditCardId === id)
        )
          throw new Error(
            "お金の置き場所と関連付けたカードは削除できません。編集で「利用中」をオフにしてください。",
          );
        if (
          data.expenses.some((e) => e.creditCardId === id) ||
          data.cardPayments.some((e) => e.creditCardId === id) ||
          data.recurringExpenses.some((e) => e.creditCardId === id) ||
          data.favorites.some((e) => e.creditCardId === id)
        )
          throw new Error(
            "履歴のあるカードは削除できません。編集で「利用中」をオフにしてください。",
          );
        const item = await db.cards.get(id);
        await db.cards.delete(id);
        if (item)
          toast("削除しました", async () => {
            await db.cards.put(item);
          });
      }
      if (type === "debt") {
        if (data.repayments.some((e) => e.debtId === id))
          throw new Error(
            "返済履歴がある借入は削除できません。返済履歴を先に整理してください。",
          );
        const item = await db.debts.get(id);
        await db.debts.delete(id);
        if (item)
          toast("削除しました", async () => {
            await db.debts.put(item);
          });
      }
      if (type === "savings") {
        if (data.savingsContributions.some((e) => e.savingsGoalId === id))
          throw new Error(
            "移動履歴がある目標は削除できません。移動履歴を先に整理してください。",
          );
        const item = await db.savingsGoals.get(id);
        await db.savingsGoals.delete(id);
        if (item)
          toast("削除しました", async () => {
            await db.savingsGoals.put(item);
          });
      }
      if (type === "recurring") {
        const item = await db.recurringExpenses.get(id);
        await db.recurringExpenses.update(id, { isActive: false });
        if (item)
          toast("固定費を終了しました。記録済みの支出は残ります", async () => {
            await db.recurringExpenses.put(item);
          });
      }
      if (type === "income") {
        const item = await db.incomes.get(id);
        const externalRows = (data.externalTransactions ?? []).filter(
          (row) => row.linkedRecordId === id,
        );
        await db.transaction(
          "rw",
          db.incomes,
          db.externalTransactions,
          async () => {
            await db.incomes.delete(id);
            for (const row of externalRows)
              await db.externalTransactions.put({
                ...row,
                kind: "ignored",
                linkedRecordId: undefined,
              });
          },
        );
        if (item)
          toast("削除しました", async () => {
            await db.transaction(
              "rw",
              db.incomes,
              db.externalTransactions,
              async () => {
                await db.incomes.put(item);
                await db.externalTransactions.bulkPut(externalRows);
              },
            );
          });
      }
    });
  }
  const editButtons = (mode: Mode, item: Entity) => (
    <div className="row-actions">
      <button
        className="icon-button"
        aria-label="編集"
        onClick={() => setEditor({ mode, entity: item })}
      >
        <Pencil size={18} />
      </button>
      <button
        className="icon-button"
        aria-label={mode === "recurring" ? "固定費を終了" : "削除"}
        onClick={() => void removeEntity(mode, item.id)}
      >
        <Trash2 size={17} />
      </button>
    </div>
  );
  return (
    <div className="page">
      <header className="page-header">
        <button
          className="icon-button"
          aria-label="戻る"
          onClick={() => navigate("/settings")}
        >
          <ArrowLeft />
        </button>
        <div>
          <span className="eyebrow">YOUR MONEY</span>
          <h1>{current.title}</h1>
        </div>
        <button
          className="icon-button tinted"
          aria-label={`${current.title}を追加`}
          onClick={() => setEditor({ mode: current.mode })}
        >
          <Plus />
        </button>
      </header>
      <p className="page-intro">{current.subtitle}</p>
      {section === "cards" && (
        <>
          <div className="dark-summary">
            <CardIcon />
            <span>カード未払い</span>
            <strong>{yen(finance.cardOutstanding)}</strong>
            <small>使っていい金額から差し引いています</small>
          </div>
          {data.cards.length === 0 && (
            <Empty
              icon={<CardIcon />}
              action={
                <button
                  className="button button-primary"
                  onClick={() => setEditor({ mode: "card" })}
                >
                  最初のカードを追加
                </button>
              }
            >
              カードはまだ登録されていません
            </Empty>
          )}
          {data.cards.map((card) => {
            const summary = getCardSummary(data, card, today);
            return (
              <section className="surface entity-card" key={card.id}>
                <div className="entity-heading">
                  <div className="entity-icon">
                    <CardIcon />
                  </div>
                  <div>
                    <h2>{card.name}</h2>
                    <small>
                      •••• {card.last4 || "────"} {!card.isActive && "· 休止中"}
                    </small>
                  </div>
                  {editButtons("card", card)}
                </div>
                <div className="entity-amount">{yen(summary.outstanding)}</div>
                <div className="info-pair">
                  <span>今月の利用</span>
                  <b>{yen(summary.monthlyUsage)}</b>
                </div>
                <div className="info-pair">
                  <span>次回予定 · {summary.nextPaymentDate}</span>
                  <b>{yen(summary.estimatedNextPaymentAmount)}</b>
                </div>
                <p className="hint">
                  支払額は締め日からの概算です。休日・請求調整は明細をご確認ください。
                </p>
                {summary.creditBalance > 0 && (
                  <p className="notice">
                    修正後の支払超過：{yen(summary.creditBalance)}
                    。カード会社の明細を確認してください。
                  </p>
                )}
                <button
                  className="button button-secondary full"
                  disabled={summary.outstanding === 0}
                  onClick={() =>
                    setEditor({ mode: "cardPayment", entity: card })
                  }
                >
                  引落を記録
                  <ArrowUpRight size={17} />
                </button>
                <details>
                  <summary>利用・引落履歴とカテゴリー</summary>
                  <div className="compact-list">
                    {data.expenses
                      .filter((e) => e.creditCardId === card.id)
                      .sort((a, b) => b.date.localeCompare(a.date))
                      .slice(0, 100)
                      .map((e) => (
                        <button
                          className="list-row"
                          key={e.id}
                          onClick={() => openExpense(e)}
                        >
                          <div>
                            <b>{e.merchant}</b>
                            <small>
                              {e.date} ·{" "}
                              {
                                data.categories.find(
                                  (c) => c.id === e.categoryId,
                                )?.name
                              }
                            </small>
                          </div>
                          <b>{yen(e.amount)}</b>
                        </button>
                      ))}
                    {data.categories.map((c) => {
                      const total = data.expenses
                        .filter(
                          (e) =>
                            e.creditCardId === card.id &&
                            e.categoryId === c.id &&
                            e.date.startsWith(today.slice(0, 7)),
                        )
                        .reduce((s, e) => s + e.amount, 0);
                      return total > 0 ? (
                        <div key={c.id} className="info-pair">
                          <span>{c.name} · 今月</span>
                          <b>{yen(total)}</b>
                        </div>
                      ) : null;
                    })}
                    {data.cardPayments
                      .filter((p) => p.creditCardId === card.id)
                      .map((p) => (
                        <div className="list-row" key={p.id}>
                          <div>
                            <b>引落 {yen(p.amount)}</b>
                            <small>{p.date}</small>
                          </div>
                          <button
                            className="icon-button"
                            aria-label="引落を取り消す"
                            onClick={() => {
                              if (
                                confirm(
                                  "この引落記録を削除し、残高を再計算しますか？",
                                )
                              )
                                void run(async () => {
                                  const externalRows = (
                                    data.externalTransactions ?? []
                                  ).filter(
                                    (row) => row.linkedRecordId === p.id,
                                  );
                                  await db.transaction(
                                    "rw",
                                    db.cardPayments,
                                    db.externalTransactions,
                                    async () => {
                                      await db.cardPayments.delete(p.id);
                                      for (const row of externalRows)
                                        await db.externalTransactions.put({
                                          ...row,
                                          kind: "ignored",
                                          linkedRecordId: undefined,
                                        });
                                    },
                                  );
                                  toast("引落を削除しました", async () => {
                                    await db.transaction(
                                      "rw",
                                      db.cardPayments,
                                      db.externalTransactions,
                                      async () => {
                                        await db.cardPayments.put(p);
                                        await db.externalTransactions.bulkPut(
                                          externalRows,
                                        );
                                      },
                                    );
                                  });
                                });
                            }}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      ))}
                  </div>
                  <button
                    className="text-button"
                    onClick={() => navigate(`/history?card=${card.id}`)}
                  >
                    全利用履歴を見る
                  </button>
                </details>
              </section>
            );
          })}
          <button
            className="button button-secondary full"
            disabled={!data.cards.length}
            onClick={() => setImporting(true)}
          >
            <Upload size={18} />
            カードCSVを取り込む
          </button>
        </>
      )}
      {section === "debts" && (
        <>
          {data.debts.length === 0 && (
            <Empty
              icon={<Landmark />}
              action={
                <button
                  className="button button-primary"
                  onClick={() => setEditor({ mode: "debt" })}
                >
                  借入を追加
                </button>
              }
            >
              借入の登録はありません
            </Empty>
          )}
          {data.debts.map((debt) => {
            const balance = calculateDebtBalance(debt, data.repayments, today);
            const paid = debt.originalAmount - balance;
            return (
              <section className="surface entity-card" key={debt.id}>
                <div className="entity-heading">
                  <div className="entity-icon">
                    <Landmark />
                  </div>
                  <div>
                    <h2>{debt.title}</h2>
                    <small>
                      {debt.lenderName}
                      {debt.isEstimated ? " · 概算" : ""}
                    </small>
                  </div>
                  {editButtons("debt", debt)}
                </div>
                <span className="muted">返済残高</span>
                <div className="entity-amount">
                  {debt.isEstimated ? "約 " : ""}
                  {yen(balance)}
                </div>
                <Progress
                  value={(paid / debt.originalAmount) * 100}
                  label="返済の進捗"
                />
                <div className="info-pair">
                  <span>
                    {yen(paid)} / {yen(debt.originalAmount)} 返済済み
                  </span>
                  <b>{Math.round((paid / debt.originalAmount) * 100)}%</b>
                </div>
                <div className="info-pair">
                  <span>
                    {debt.reserveForCurrentBudget === false
                      ? "返済開始前"
                      : `毎月の予定 · ${debt.nextPaymentDate}`}
                  </span>
                  <b>
                    {debt.reserveForCurrentBudget === false
                      ? "今期の確保なし"
                      : yen(debt.plannedMonthlyPayment)}
                  </b>
                </div>
                <button
                  className="button button-secondary full"
                  disabled={balance <= 0}
                  onClick={() => setEditor({ mode: "repayment", entity: debt })}
                >
                  返済を記録
                </button>
                <details>
                  <summary>返済履歴</summary>
                  {data.repayments
                    .filter((r) => r.debtId === debt.id)
                    .map((r) => (
                      <div className="list-row" key={r.id}>
                        <div>
                          <b>{yen(r.amount)}</b>
                          <small>
                            {r.date} {r.memo}
                          </small>
                        </div>
                        <button
                          className="icon-button"
                          aria-label="返済を取り消す"
                          onClick={() => {
                            if (
                              confirm(
                                "返済記録を削除し、残高を再計算しますか？",
                              )
                            )
                              void run(async () => {
                                await db.transaction(
                                  "rw",
                                  db.debts,
                                  db.repayments,
                                  async () => {
                                    await db.repayments.delete(r.id);
                                    await db.debts.update(debt.id, {
                                      currentBalance: balance + r.amount,
                                      status: "active",
                                    });
                                  },
                                );
                                toast("返済記録を削除しました", async () => {
                                  await db.transaction(
                                    "rw",
                                    db.repayments,
                                    db.debts,
                                    async () => {
                                      await db.repayments.put(r);
                                      await db.debts.put(debt);
                                    },
                                  );
                                });
                              });
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))}
                </details>
              </section>
            );
          })}
        </>
      )}
      {section === "savings" && (
        <>
          {data.savingsGoals.length === 0 && (
            <Empty
              icon={<Target />}
              action={
                <button
                  className="button button-primary"
                  onClick={() => setEditor({ mode: "savings" })}
                >
                  目標を追加
                </button>
              }
            >
              まだ貯金目標はありません
            </Empty>
          )}
          {data.savingsGoals.map((goal) => {
            const currentAmount = calculateSavingsAmount(
              goal,
              data.savingsContributions,
              today,
            );
            const left = Math.max(0, goal.targetAmount - currentAmount);
            const months = goal.targetDate
              ? Math.max(
                  1,
                  (Number(goal.targetDate.slice(0, 4)) -
                    Number(today.slice(0, 4))) *
                    12 +
                    Number(goal.targetDate.slice(5, 7)) -
                    Number(today.slice(5, 7)) +
                    1,
                )
              : 0;
            return (
              <section className="surface entity-card" key={goal.id}>
                <div className="entity-heading">
                  <div className="entity-icon">
                    <Target />
                  </div>
                  <div>
                    <h2>{goal.name}</h2>
                    <small>目標 {yen(goal.targetAmount)}</small>
                  </div>
                  {editButtons("savings", goal)}
                </div>
                <div className="entity-amount">{yen(currentAmount)}</div>
                <Progress
                  value={(currentAmount / goal.targetAmount) * 100}
                  label="貯金の進捗"
                />
                <div className="info-pair">
                  <span>あと {yen(left)}</span>
                  <b>
                    {Math.round((currentAmount / goal.targetAmount) * 100)}%
                  </b>
                </div>
                {goal.targetDate && (
                  <div className="info-pair">
                    <span>{goal.targetDate} まで</span>
                    <b>月 {yen(Math.ceil(left / months))} が目安</b>
                  </div>
                )}
                <div className="info-pair">
                  <span>毎月の貯金予定</span>
                  <b>{yen(goal.monthlyTarget)}</b>
                </div>
                <button
                  className="button button-secondary full"
                  onClick={() =>
                    setEditor({ mode: "contribution", entity: goal })
                  }
                >
                  貯金への移動を記録
                </button>
                <details>
                  <summary>移動履歴</summary>
                  {data.savingsContributions
                    .filter((c) => c.savingsGoalId === goal.id)
                    .map((c) => (
                      <div className="list-row" key={c.id}>
                        <div>
                          <b>{yen(c.amount)}</b>
                          <small>
                            {c.date} {c.memo}
                          </small>
                        </div>
                        <button
                          className="icon-button"
                          aria-label="移動を取り消す"
                          onClick={() => {
                            if (
                              confirm(
                                "移動記録を削除し、残高を再計算しますか？",
                              )
                            )
                              void run(async () => {
                                await db.transaction(
                                  "rw",
                                  db.savingsContributions,
                                  db.savingsGoals,
                                  async () => {
                                    await db.savingsContributions.delete(c.id);
                                    await db.savingsGoals.update(goal.id, {
                                      currentAmount: currentAmount - c.amount,
                                      completedAt: undefined,
                                    });
                                  },
                                );
                                toast("移動を削除しました", async () => {
                                  await db.transaction(
                                    "rw",
                                    db.savingsContributions,
                                    db.savingsGoals,
                                    async () => {
                                      await db.savingsContributions.put(c);
                                      await db.savingsGoals.put(goal);
                                    },
                                  );
                                });
                              });
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))}
                </details>
              </section>
            );
          })}
        </>
      )}
      {section === "recurring" && (
        <>
          <FixedCostSuggestions />
          <div className="note-panel">
            <CalendarClock size={20} />
            <span>
              {finance.cycle.mode === "salary" ? "今期" : "今月"}までの未確認分{" "}
              {yen(finance.upcomingFixedCosts)}{" "}
              を確保しています。支払日は自動確定しません。
            </span>
          </div>
          {finance.recurringDue.map((due) => (
            <section className="surface occurrence" key={due.id}>
              <span className="badge">
                {due.dueDate > today ? "予定・確保済み" : "支払いを確認"}
              </span>
              <div className="list-row">
                <div>
                  <b>{due.name}</b>
                  <small>{due.dueDate}</small>
                </div>
                <b>{yen(due.amount)}</b>
              </div>
              <p className="hint">この支払いは発生しましたか？</p>
              <div className="button-row">
                <button
                  className="button button-primary"
                  onClick={() =>
                    setEditor({
                      mode: "confirmRecurring",
                      entity: due.recurringExpense,
                      occurrenceId: due.id,
                      dueDate: due.dueDate,
                    })
                  }
                >
                  支払った・金額変更
                </button>
                <button
                  className="button button-secondary"
                  onClick={() =>
                    void run(async () => {
                      await db.recurringOccurrences.add({
                        id: due.id,
                        recurringExpenseId: due.recurringExpenseId,
                        dueDate: due.dueDate,
                        status: "skipped",
                      });
                      toast("今回はなしにしました", async () => {
                        await db.recurringOccurrences.delete(due.id);
                      });
                    })
                  }
                >
                  今回はなし
                </button>
              </div>
              <small>後で確認する場合は、そのまま閉じて大丈夫です。</small>
            </section>
          ))}
          {data.recurringExpenses.length === 0 && (
            <Empty
              icon={<CalendarClock />}
              action={
                <button
                  className="button button-primary"
                  onClick={() => setEditor({ mode: "recurring" })}
                >
                  固定費を追加
                </button>
              }
            >
              毎月・毎年の支払いをここへ
            </Empty>
          )}
          {data.recurringExpenses.map((r) => (
            <section className="surface entity-card" key={r.id}>
              <div className="entity-heading">
                <div>
                  <h2>{r.name}</h2>
                  <small>
                    {r.frequency === "monthly" ? "毎月" : "毎年"} · {r.dueDay}日
                    · {paymentLabels[r.paymentMethod]} {!r.isActive && "· 終了"}
                  </small>
                </div>
                {editButtons("recurring", r)}
              </div>
              <div className="entity-amount small">{yen(r.amount)}</div>
              <details>
                <summary>確認済みの支払い</summary>
                {data.recurringOccurrences
                  .filter((o) => o.recurringExpenseId === r.id)
                  .map((o) => (
                    <div className="list-row" key={o.id}>
                      <div>
                        <b>
                          {o.status === "paid" ? "支払い済み" : "今回はなし"}
                        </b>
                        <small>{o.dueDate}</small>
                      </div>
                      {o.status === "skipped" ? (
                        <button
                          className="text-button"
                          onClick={() =>
                            void run(async () => {
                              await db.recurringOccurrences.delete(o.id);
                            }, "未確認に戻しました")
                          }
                        >
                          元に戻す
                        </button>
                      ) : (
                        <button
                          className="text-button"
                          onClick={() => {
                            const e = data.expenses.find(
                              (x) => x.id === o.expenseId,
                            );
                            if (e) openExpense(e);
                          }}
                        >
                          支出を見る
                        </button>
                      )}
                    </div>
                  ))}
              </details>
            </section>
          ))}
        </>
      )}
      {section === "incomes" && (
        <>
          {data.incomes.length === 0 && (
            <Empty
              icon={<Receipt />}
              action={
                <button
                  className="button button-primary"
                  onClick={() => setEditor({ mode: "income" })}
                >
                  収入を追加
                </button>
              }
            >
              収入の記録はまだありません
            </Empty>
          )}
          {[...data.incomes]
            .sort((a, b) => b.date.localeCompare(a.date))
            .map((income) => (
              <div className="surface list-row" key={income.id}>
                <div>
                  <b>{income.source}</b>
                  <small>{income.date}</small>
                </div>
                <strong className="positive">+{yen(income.amount)}</strong>
                {editButtons("income", income)}
              </div>
            ))}
        </>
      )}
      <button
        className="button button-primary full add-entity"
        onClick={() => setEditor({ mode: current.mode })}
      >
        <Plus size={20} />
        {current.title}を追加
      </button>
      {((section === "cards" && data.cards.length === 0) ||
        (section === "debts" && data.debts.length === 0) ||
        (section === "recurring" && data.recurringExpenses.length === 0)) && (
        <button
          className="text-button centered"
          onClick={() =>
            void run(
              () =>
                updateSettings({
                  setupReviewed: [
                    ...new Set([...data.settings.setupReviewed, section]),
                  ],
                }),
              "該当なしとして確認しました",
            )
          }
        >
          {section === "cards"
            ? "カードは使っていない"
            : section === "debts"
              ? "借入はない"
              : "固定費はない"}
        </button>
      )}
      {editor && (
        <FinanceEditor
          editor={editor}
          onClose={() => {
            setEditor(null);
            setPendingImport(false);
          }}
          onSaved={() => {
            if (pendingImport) setImporting(true);
          }}
        />
      )}
      {importing && (
        <CardImport
          data={data}
          onClose={closeImport}
          onAddCard={() => {
            setImporting(false);
            setPendingImport(true);
            setEditor({ mode: "card" });
          }}
          onImported={() => {
            closeImport();
            toast("カード利用を取り込みました");
          }}
        />
      )}
    </div>
  );
}
