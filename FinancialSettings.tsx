import { useState } from "react";
import { Link } from "react-router-dom";
import { saveAs } from "file-saver";
import {
  ArrowLeft,
  ShieldCheck,
  Landmark,
  RefreshCw,
  Bell,
  LockKeyhole,
  ExternalLink,
} from "lucide-react";
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
import { db, updateSettings } from "../db";
import { moneytree } from "../hooks/useFinancialConnections";
import {
  enableAccountManagement,
  fixedCostCandidates,
} from "../domain/financialActions";
import {
  disconnectFinancialConnection,
  syncFinancialConnection,
} from "../domain/financialSync";
import { lockVault } from "../domain/vault";
import {
  buildDailyReminder,
  enableForegroundNotifications,
} from "../domain/reminders";
import type { RecurringExpense } from "../types";

export function FinancialSettings() {
  const { data, today, run, toast } = usePace();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
  const [candidate, setCandidate] = useState<
    (typeof fixedCostCandidates)[number] | null
  >(null);
  const [recurringDifference, setRecurringDifference] = useState<{
    recurring: RecurringExpense;
    actual: number;
    expenseId: string;
  } | null>(null);
  const connection = data.financialConnections?.find(
    (c) => c.providerId === "moneytree" && c.status !== "disconnected",
  );
  const sync = data.syncStates?.find(
    (s) => s.id === connection?.id || s.id === "moneytree:default",
  );
  const reminder = data.settings.reminder ?? {
    enabled: false,
    time: "08:00",
    privacyMode: "generic" as const,
    delivery: "calendar" as const,
  };
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
  return (
    <div className="page financial-settings">
      <header className="page-header">
        <Link className="icon-button" to="/money" aria-label="お金の置き場所へ">
          <ArrowLeft />
        </Link>
        <div>
          <span className="eyebrow">YOU ARE IN CONTROL</span>
          <h1>連携とプライバシー</h1>
        </div>
      </header>
      <section className="surface privacy-center">
        <ShieldCheck size={30} />
        <h2>{connection ? "許可した金融連携のみ" : "端末だけで管理中"}</h2>
        <p>
          記録・残高・連携の認証情報は、この端末の暗号化した保管庫に保存します。広告・解析・外部AIへの送信はありません。
        </p>
        <div className="chips">
          <span className="chip">端末内で暗号化</span>
          <span className="chip">レシートは外部送信なし</span>
        </div>
        <button className="button button-secondary" onClick={() => lockVault()}>
          <LockKeyhole size={18} />
          保管庫をロック
        </button>
      </section>
      <section className="surface">
        <h2>
          <Landmark size={21} />
          銀行・カードを連携
        </h2>
        <p>
          Moneytree
          LINKを使います。銀行のログイン情報はMoneytree側で入力し、Paceには保存しません。
        </p>
        <dl className="capability-list">
          <div>
            <dt>横浜銀行・三菱UFJ銀行</dt>
            <dd>Moneytreeの対応機関。正式設定後に連携可</dd>
          </div>
          <div>
            <dt>三井住友カード・モバイルSuica</dt>
            <dd>Moneytreeの対応機関。残高・明細は取得時点の情報</dd>
          </div>
          <div>
            <dt>三菱UFJ系カード</dt>
            <dd>カードの商品名を確認してから選択</dd>
          </div>
          <div>
            <dt>PayPay</dt>
            <dd>手動管理。ウォレット残高・利用履歴の自動取得は未対応</dd>
          </div>
        </dl>
        <a
          href="https://institutions.moneytree.jp/"
          target="_blank"
          rel="noreferrer"
          className="text-button"
        >
          対応状況を確認 <ExternalLink size={14} />
        </a>
        {!moneytree.isConfigured() && (
          <p className="inline-alert">
            この配布版は金融連携の正式な接続設定が未設定です。銀行・カードの手動管理は利用できます。
          </p>
        )}
        {!connection ? (
          <>
            <label className="check-field">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              Moneytreeへの接続と残高・明細の取得を許可する
            </label>
            <button
              className="button button-primary"
              disabled={!consent || !moneytree.isConfigured() || busy}
              onClick={() => {
                setBusy(true);
                void run(async () => {
                  await enableAccountManagement();
                  const result = await moneytree.connect();
                  if (result.authorizationUrl)
                    location.assign(result.authorizationUrl);
                }).finally(() => setBusy(false));
              }}
            >
              Moneytreeに接続
            </button>
          </>
        ) : (
          <>
            <p className="microcopy">
              {connection.status === "connected" ? "接続済み" : "再認証が必要"}{" "}
              · 最後の取得{" "}
              {sync?.lastSuccessAt?.slice(0, 16).replace("T", " ") ??
                "まだ取得していません"}
            </p>
            {sync && <p role="status">{sync.message}</p>}
            <button
              className="button button-primary"
              disabled={
                busy ||
                sync?.status === "syncing" ||
                !!(
                  sync?.nextRefreshAllowedAt &&
                  Date.parse(sync.nextRefreshAllowedAt) > Date.now()
                )
              }
              onClick={() => {
                setBusy(true);
                void run(() =>
                  syncFinancialConnection(moneytree, connection, true),
                ).finally(() => setBusy(false));
              }}
            >
              <RefreshCw size={17} />
              更新を依頼
            </button>
            {sync?.nextRefreshAllowedAt && (
              <small>
                次の更新依頼：
                {new Date(sync.nextRefreshAllowedAt).toLocaleString("ja-JP")}
              </small>
            )}
            {connection.status === "reauthentication" && (
              <button
                className="button button-secondary"
                onClick={() =>
                  void run(async () => {
                    const r = await moneytree.connect();
                    if (r.authorizationUrl) location.assign(r.authorizationUrl);
                  })
                }
              >
                再認証する
              </button>
            )}
            <button
              className="text-button danger"
              onClick={() => setDisconnect(true)}
            >
              金融連携を解除
            </button>
          </>
        )}
        <p className="hint">
          更新依頼後、情報が反映されるまで時間がかかることがあります。利用可能な更新回数に合わせて間隔を空けます。
        </p>
      </section>
      <section className="surface">
        <h2>PayPay・Suica</h2>
        <p>チャージは使ったお金ではなく振替。支払いを支出として記録します。</p>
        <div className="action-row">
          <a className="button button-secondary" href="paypay://passbook">
            PayPayウォレットを開く
          </a>
          <Link className="button button-secondary" to="/money">
            チャージを振替で記録
          </Link>
        </div>
        <p className="hint">
          SuicaのチャージはWallet／モバイルSuicaで操作し、Paceに戻って振替を記録してください。
        </p>
      </section>
      <section className="surface">
        <h2>給与のサイクル</h2>
        <AsyncForm
          label="サイクルを保存"
          onSubmit={async (f) => {
            await updateSettings({
              budgetCycle: {
                mode: textValue(f, "mode") as "calendar" | "salary",
                startDay: Number(f.get("day")),
              },
            });
            toast("サイクルを保存しました");
          }}
        >
          <Field label="予算の期間">
            <select
              name="mode"
              defaultValue={data.settings.budgetCycle?.mode ?? "calendar"}
            >
              <option value="salary">給料日から次の給料日前日</option>
              <option value="calendar">カレンダーの月</option>
            </select>
          </Field>
          <Field label="サイクル開始日">
            <input
              name="day"
              type="number"
              min={1}
              max={31}
              required
              defaultValue={data.settings.budgetCycle?.startDay ?? 10}
            />
          </Field>
          <p className="hint">
            10日なら10日〜翌月9日。実際の給与が休日に前倒しされても期間は変えません。予定収入を残高に加えません。
          </p>
        </AsyncForm>
      </section>
      <section className="surface">
        <h2>固定費の候補</h2>
        <p className="hint">
          必要なものを選び、支払日と支払元を確認して追加します。
        </p>
        <div className="chips">
          {fixedCostCandidates
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
      <section className="surface">
        <h2>
          <Bell size={21} />
          毎日のリマインダー
        </h2>
        <AsyncForm
          label="リマインダーを保存"
          onSubmit={async (f) => {
            const enabled = f.get("enabled") === "on",
              delivery = textValue(f, "delivery") as "calendar" | "foreground";
            if (enabled && delivery === "foreground")
              await enableForegroundNotifications();
            await updateSettings({
              reminder: {
                enabled,
                time: textValue(f, "time"),
                privacyMode: "generic",
                delivery,
              },
            });
            toast("保存しました");
          }}
        >
          <label className="check-field">
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={reminder.enabled}
            />
            リマインダーを使う
          </label>
          <Field label="時刻">
            <input
              name="time"
              required
              type="time"
              defaultValue={reminder.time}
            />
          </Field>
          <Field label="通知方法">
            <select name="delivery" defaultValue={reminder.delivery}>
              <option value="calendar">カレンダーに毎日の予定を追加</option>
              <option value="foreground">アプリを開いている間の通知</option>
            </select>
          </Field>
          <p className="hint">
            通知文は「今日のPaceを確認してください」。残高は通知に載せません。PWAだけでは、アプリを閉じた状態で毎日時刻どおりの通知を予約できません。
          </p>
        </AsyncForm>
        {reminder.enabled && reminder.delivery === "calendar" && (
          <button
            className="button button-secondary"
            onClick={() =>
              saveAs(
                new Blob([buildDailyReminder(reminder.time, today)], {
                  type: "text/calendar;charset=utf-8",
                }),
                "pace-daily-reminder.ics",
              )
            }
          >
            カレンダー用ファイルを作成
          </button>
        )}
        <p className="hint">
          OFFにした場合、追加済みのカレンダーの予定はカレンダー側で削除してください。
        </p>
      </section>
      {disconnect && connection && (
        <Sheet title="金融連携を解除" onClose={() => setDisconnect(false)}>
          <AsyncForm
            label="認可を取り消して解除"
            onSubmit={async (f) => {
              await disconnectFinancialConnection(
                moneytree,
                connection.id,
                f.get("remove") === "on",
              );
              setDisconnect(false);
              toast("連携を解除しました。残高は手動管理に引き継ぎます。");
            }}
          >
            <p>
              Moneytreeの認可と端末内の認証情報を削除します。手入力の記録は残します。
            </p>
            <label className="check-field">
              <input name="remove" type="checkbox" />
              取得した明細・支出・入金も削除する
            </label>
          </AsyncForm>
        </Sheet>
      )}
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
                {data.accounts
                  ?.filter((a) => a.isActive)
                  .map((a) => (
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
    </div>
  );
}
