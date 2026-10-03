import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRightLeft,
  Plus,
  Wallet,
  Landmark,
  CreditCard,
  Pencil,
  Undo2,
} from "lucide-react";
import { usePace } from "../app/context";
import {
  AsyncForm,
  Field,
  Sheet,
  stamp,
  money,
  textValue,
  yen,
} from "../components/UI";
import { db } from "../db";
import { getAccountBalances, previewTransfer } from "../domain/accounts";
import {
  enableAccountManagement,
  accountPresets,
  reconcileAccount,
  saveTransfer,
  reverseTransfer,
  mergeFinancialAccount,
} from "../domain/financialActions";
import type { Account, AccountKind } from "../types";
import { FinancialInbox } from "./FinancialInbox";
const kindLabels: Record<AccountKind, string> = {
  BANK: "銀行",
  CASH: "現金",
  EWALLET: "電子マネー",
  CREDIT_CARD: "カード未払い",
  SAVINGS: "貯金",
  OTHER: "その他",
};

function AccountEditor({
  account,
  preset,
  onClose,
}: {
  account?: Account;
  preset?: (typeof accountPresets)[number];
  onClose: () => void;
}) {
  const { data, today, toast, run } = usePace();
  const [kind, setKind] = useState<AccountKind>(
    account?.kind ?? preset?.kind ?? "BANK",
  );
  const [mapping, setMapping] = useState("");
  return (
    <Sheet
      title={account ? "口座・残高を編集" : "お金の置き場所を追加"}
      onClose={onClose}
    >
      <AsyncForm
        onSubmit={async (f) => {
          const name = textValue(f, "name").replace(/三菱東京UFJ/g, "三菱UFJ");
          if (!name) throw new Error("名前を入力してください。");
          const cardId =
            kind === "CREDIT_CARD" ? textValue(f, "card") : undefined;
          if (kind === "CREDIT_CARD" && !cardId)
            throw new Error(
              "対応するカードを選んでください。先にカード設定から追加できます。",
            );
          if (
            cardId &&
            data.accounts?.some(
              (a) =>
                a.id !== account?.id && a.isActive && a.creditCardId === cardId,
            )
          )
            throw new Error("このカードは別の口座に登録済みです。");
          const balance = money(f.get("balance"), true),
            now = new Date().toISOString();
          const row: Account = {
            ...(account ?? stamp()),
            name,
            kind,
            institutionName: kind === "BANK" ? name : "",
            currency: "JPY",
            snapshotBalance: balance,
            balanceAsOf: today,
            snapshotRecordedAt: now,
            balanceSource: "manual",
            creditCardId: cardId,
            isSpendable: kind !== "CREDIT_CARD" && f.get("spendable") === "on",
            isActive: true,
            automationLevel: "manual",
            updatedAt: now,
          };
          await db.transaction(
            "rw",
            db.accounts,
            db.accountAdjustments,
            async () => {
              if (account)
                await reconcileAccount(account, balance, today, "残高を確認");
              await db.accounts.put(row);
            },
          );
          onClose();
          toast("残高を保存しました");
        }}
      >
        <Field label="名前">
          <input
            name="name"
            required
            maxLength={100}
            defaultValue={account?.name ?? preset?.name}
            placeholder="銀行・現金・電子マネー"
          />
        </Field>
        <Field label="種類">
          <select
            value={kind}
            disabled={!!account?.connectionId}
            onChange={(e) => setKind(e.target.value as AccountKind)}
          >
            {Object.entries(kindLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        {kind === "CREDIT_CARD" && (
          <Field label="対応するカード">
            <select
              name="card"
              required
              defaultValue={account?.creditCardId ?? ""}
            >
              <option value="">選択してください</option>
              {data.cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Link to="/manage/cards" onClick={onClose}>
              カード設定を開く
            </Link>
          </Field>
        )}
        <Field label={kind === "CREDIT_CARD" ? "現在の未払い額" : "現在の残高"}>
          <input
            name="balance"
            type="number"
            inputMode="numeric"
            required
            min={0}
            max={999999999999}
            defaultValue={
              account
                ? (getAccountBalances(data, today).find(
                    (b) => b.account.id === account.id,
                  )?.balance ?? undefined)
                : undefined
            }
          />
        </Field>
        {kind !== "CREDIT_CARD" && (
          <label className="check-field">
            <input
              name="spendable"
              type="checkbox"
              defaultChecked={account?.isSpendable ?? kind !== "SAVINGS"}
            />
            今使えるお金に含める
          </label>
        )}
        {account?.balanceSource === "provider" && (
          <p className="hint">
            手動で確認した残高です。次回の自動取得でサービスの残高に置き換わります。
          </p>
        )}
        {account?.connectionId && (
          <div className="note-panel">
            <Field label="すでに管理中の同じ口座">
              <select
                value={mapping}
                onChange={(e) => setMapping(e.target.value)}
              >
                <option value="">必要な場合だけ選択</option>
                {data.accounts
                  ?.filter(
                    (a) =>
                      a.id !== account.id &&
                      !a.connectionId &&
                      a.kind === account.kind &&
                      a.isActive,
                  )
                  .map((a) => (
                    <option value={a.id} key={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </Field>
            <button
              type="button"
              className="button button-secondary"
              disabled={!mapping}
              onClick={() =>
                void run(async () => {
                  if (
                    !confirm(
                      "同じ口座として統合しますか？取得した残高を使い、過去の記録は引き継ぎます。",
                    )
                  )
                    return;
                  await mergeFinancialAccount(account.id, mapping);
                  onClose();
                  toast("同じ口座として統合しました");
                })
              }
            >
              既存の口座と統合する
            </button>
          </div>
        )}
        {account && (
          <button
            type="button"
            className="text-button danger"
            onClick={() =>
              void run(async () => {
                if (!confirm("残高の集計から外しますか？記録は残ります。"))
                  return;
                await db.accounts.update(account.id, { isActive: false });
                onClose();
              })
            }
          >
            この口座を集計から外す
          </button>
        )}
      </AsyncForm>
    </Sheet>
  );
}
export function TransferEditor({
  onClose,
  initialFrom,
  initialTo,
  initialAmount,
  externalIds,
}: {
  onClose: () => void;
  initialFrom?: string;
  initialTo?: string;
  initialAmount?: number;
  externalIds?: string[];
}) {
  const { data, today, toast } = usePace();
  const accounts = (data.accounts ?? []).filter((a) => a.isActive);
  const [from, setFrom] = useState(
    initialFrom ?? accounts.find((a) => a.id !== initialTo)?.id ?? "",
  );
  const [to, setTo] = useState(
    initialTo ?? accounts.find((a) => a.id !== from)?.id ?? "",
  );
  const [amount, setAmount] = useState(String(initialAmount ?? ""));
  const row = {
    ...stamp(),
    fromAccountId: from,
    toAccountId: to,
    amount: Number(amount),
    date: today,
    memo: "",
    status: "confirmed" as const,
    fromBalanceEffect:
      externalIds &&
      accounts.find((a) => a.id === from)?.balanceSource === "provider"
        ? ("snapshot" as const)
        : ("ledger" as const),
    toBalanceEffect:
      externalIds &&
      accounts.find((a) => a.id === to)?.balanceSource === "provider"
        ? ("snapshot" as const)
        : ("ledger" as const),
  };
  let preview: ReturnType<typeof previewTransfer> | null = null;
  try {
    preview = previewTransfer(data, row, today);
  } catch {
    /* Validated at save; no sensitive logs. */
  }
  return (
    <Sheet title="お金を移す（振替）" onClose={onClose}>
      <AsyncForm
        label="振替を記録"
        onSubmit={async (f) => {
          const fromAccount = accounts.find((a) => a.id === from),
            toAccount = accounts.find((a) => a.id === to);
          const transfer = {
            ...stamp(),
            fromAccountId: from,
            toAccountId: to,
            amount: money(f.get("amount")),
            date: textValue(f, "date"),
            memo: textValue(f, "memo"),
            status: "confirmed" as const,
            externalTransactionIds: externalIds,
            fromBalanceEffect:
              externalIds && fromAccount?.balanceSource === "provider"
                ? ("snapshot" as const)
                : ("ledger" as const),
            toBalanceEffect:
              externalIds && toAccount?.balanceSource === "provider"
                ? ("snapshot" as const)
                : ("ledger" as const),
          };
          await db.transaction(
            "rw",
            db.transfers,
            db.financialAudits,
            db.externalTransactions,
            async () => {
              await saveTransfer(transfer);
              for (const id of externalIds ?? [])
                await db.externalTransactions.update(id, {
                  kind: "transfer",
                  linkedRecordId: transfer.id,
                });
            },
          );
          onClose();
          toast("振替を記録しました · 支出には含めません", () =>
            reverseTransfer(transfer.id),
          );
        }}
      >
        <Field label="移動元">
          <select
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            required
          >
            <option value="">選択</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="移動先">
          <select value={to} onChange={(e) => setTo(e.target.value)} required>
            <option value="">選択</option>
            {accounts
              .filter((a) => a.id !== from)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="金額">
          <input
            name="amount"
            required
            type="number"
            min={1}
            max={999999999999}
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="日付">
          <input
            name="date"
            type="date"
            required
            defaultValue={today}
            max={today}
          />
        </Field>
        <Field label="メモ（任意）">
          <input
            name="memo"
            maxLength={500}
            placeholder="ATM・チャージ・カード引落など"
          />
        </Field>
        <p className="hint">
          支出・収入は0円。
          {accounts.find((a) => a.id === from)?.kind === "CREDIT_CARD"
            ? "電子マネー残高とカード未払いが同額増えます。"
            : "移動元の残高を減らし、移動先に加えます。"}
        </p>
        {preview && (
          <div className="note-panel" aria-live="polite">
            <p>
              {accounts.find((a) => a.id === from)?.name}:{" "}
              {preview.fromBefore === null ? "未確認" : yen(preview.fromBefore)}{" "}
              → {preview.fromAfter === null ? "未確認" : yen(preview.fromAfter)}
            </p>
            <p>
              {accounts.find((a) => a.id === to)?.name}:{" "}
              {preview.toBefore === null ? "未確認" : yen(preview.toBefore)} →{" "}
              {preview.toAfter === null ? "未確認" : yen(preview.toAfter)}
            </p>
            {externalIds && (
              <small>自動取得済みの側は残高から再計上しません。</small>
            )}
          </div>
        )}
      </AsyncForm>
    </Sheet>
  );
}
export function Money() {
  const { data, finance, today, run } = usePace();
  const [edit, setEdit] = useState<Account | true | null>(null);
  const [preset, setPreset] = useState<
    (typeof accountPresets)[number] | undefined
  >();
  const [transfer, setTransfer] = useState(false);
  const [query, setQuery] = useState("");
  const enabled = data.settings.financialAutomationEnabled;
  const balances = getAccountBalances(data, today);
  const ledger = (data.transfers ?? [])
    .filter((t) =>
      [
        t.memo,
        data.accounts?.find((a) => a.id === t.fromAccountId)?.name,
        data.accounts?.find((a) => a.id === t.toAccountId)?.name,
        t.amount,
      ]
        .join(" ")
        .includes(query),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  return (
    <div className="page money-page">
      <header className="page-header">
        <Link to="/" className="icon-button" aria-label="ホームへ">
          <ArrowLeft />
        </Link>
        <div>
          <span className="eyebrow">YOUR MONEY</span>
          <h1>お金の置き場所</h1>
        </div>
        <Link
          className="icon-button"
          to="/financial"
          aria-label="金融連携とプライバシー"
        >
          ⚙
        </Link>
      </header>
      {!enabled ? (
        <section className="surface automation-intro">
          <Wallet size={30} />
          <h2>銀行・現金・Suicaをまとめて見る</h2>
          <p>
            口座ごとの残高と振替を使えます。既存の合計残高は最初の1件に引き継ぎます。
          </p>
          <button
            className="button button-primary"
            onClick={() =>
              void run(enableAccountManagement, "口座ごとの管理を始めました")
            }
          >
            口座ごとの管理を始める
          </button>
        </section>
      ) : (
        <>
          <section className="surface money-total">
            <span>今使っていい金額</span>
            <strong>
              {finance.safeToSpend === null
                ? "残高を確認"
                : yen(finance.safeToSpend)}
            </strong>
            <small>カード未払い・確保するお金を差し引いています</small>
          </section>
          {finance.accountingWarnings?.map((w: string) => (
            <p className="inline-alert" key={w}>
              {w}
            </p>
          ))}
          {finance.reconciliationAlerts?.map((a) => (
            <button
              key={a.accountId}
              className="settings-row surface"
              onClick={() =>
                setEdit(
                  data.accounts!.find((account) => account.id === a.accountId)!,
                )
              }
            >
              <span>
                <b>
                  {
                    data.accounts?.find((account) => account.id === a.accountId)
                      ?.name
                  }
                  の未払いを確認
                </b>
                <small>
                  取得額 {yen(a.providerBalance)} · 台帳 {yen(a.ledgerBalance)}{" "}
                  · 差 {yen(a.difference)}
                  。取得前の利用・未確定・入力漏れを確認できます。
                </small>
              </span>
              <span>→</span>
            </button>
          ))}
          <div className="account-grid">
            {balances
              .filter((b) => b.account.isActive)
              .map((b) => (
                <button
                  key={b.account.id}
                  className="surface account-card"
                  onClick={() => setEdit(b.account)}
                >
                  <span className="account-icon">
                    {b.isLiability ? (
                      <CreditCard />
                    ) : b.account.kind === "BANK" ? (
                      <Landmark />
                    ) : (
                      <Wallet />
                    )}
                  </span>
                  <b>{b.account.name}</b>
                  <small>
                    {kindLabels[b.account.kind]} ·{" "}
                    {b.account.automationLevel === "automatic"
                      ? "自動取得"
                      : b.account.automationLevel === "semi"
                        ? "確認して入力"
                        : "手動"}
                  </small>
                  <strong>
                    {b.balance === null ? "未確認" : yen(b.balance)}
                  </strong>
                  <small>
                    {b.isStale ? "24時間以上前 · " : ""}
                    {b.lastUpdatedAt?.slice(0, 16).replace("T", " ") ??
                      "確認日時なし"}
                  </small>
                  <Pencil size={14} />
                </button>
              ))}
          </div>
          <button
            className="button button-secondary"
            onClick={() => {
              setPreset(undefined);
              setEdit(true);
            }}
          >
            <Plus size={18} />
            口座を追加
          </button>
          <div className="chips">
            {accountPresets
              .filter(
                (p) =>
                  !data.accounts?.some((a) => a.isActive && a.name === p.name),
              )
              .map((p) => (
                <button
                  key={p.name}
                  className="chip"
                  onClick={() => {
                    setPreset(p);
                    setEdit(true);
                  }}
                >
                  ＋ {p.name}
                </button>
              ))}
          </div>
          <button
            className="button button-primary"
            disabled={balances.filter((b) => b.account.isActive).length < 2}
            onClick={() => setTransfer(true)}
          >
            <ArrowRightLeft size={19} />
            振替・チャージ・ATM
          </button>
          <Link className="settings-row surface" to="/financial">
            <b>金融連携・通知・プライバシー</b>
            <span>→</span>
          </Link>
          <FinancialInbox />
          <section className="surface">
            <h2>振替の履歴</h2>
            <Field label="口座名・金額・メモを検索">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Suica・1000・ATM"
              />
            </Field>
            {ledger.slice(0, 60).map((t) => (
              <div className="transfer-row" key={t.id}>
                <div>
                  <b>
                    {data.accounts?.find((a) => a.id === t.fromAccountId)?.name}{" "}
                    → {data.accounts?.find((a) => a.id === t.toAccountId)?.name}
                  </b>
                  <small>
                    {t.date} ·{" "}
                    {t.status === "reversed" ? "取消済み" : "支出には含めない"}{" "}
                    · {t.memo}
                  </small>
                </div>
                <b>{yen(t.amount)}</b>
                {t.status === "confirmed" && (
                  <button
                    className="icon-button"
                    aria-label="振替を取り消す"
                    onClick={() =>
                      void run(() => reverseTransfer(t.id), "取り消しました")
                    }
                  >
                    <Undo2 size={17} />
                  </button>
                )}
              </div>
            ))}
            {!ledger.length && (
              <p className="hint">
                チャージやATMでお金を移したら、ここに記録できます。
              </p>
            )}
          </section>
          <section className="surface">
            <h2>数字が違う？</h2>
            <p>
              未確定のカード利用、現金の入力漏れ、振替の未確認を確認できます。
            </p>
            <div className="chips">
              {balances
                .filter((b) => b.account.isActive)
                .map((b) => (
                  <button
                    className="chip"
                    key={b.account.id}
                    onClick={() => setEdit(b.account)}
                  >
                    {b.account.name}を確認
                  </button>
                ))}
            </div>
            <Link to="/history">支出の履歴を確認 →</Link>
          </section>
        </>
      )}
      {edit && (
        <AccountEditor
          account={edit === true ? undefined : edit}
          preset={preset}
          onClose={() => setEdit(null)}
        />
      )}{" "}
      {transfer && <TransferEditor onClose={() => setTransfer(false)} />}
    </div>
  );
}
