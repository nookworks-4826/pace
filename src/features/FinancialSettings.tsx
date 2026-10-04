import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ChevronRight,
  CreditCard,
  ExternalLink,
  FileSpreadsheet,
  Landmark,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { usePace } from "../app/context";
import { AsyncForm, Sheet, yen } from "../components/UI";
import { moneytree } from "../hooks/useFinancialConnections";
import { enableAccountManagement } from "../domain/financialActions";
import {
  disconnectFinancialConnection,
  syncFinancialConnection,
} from "../domain/financialSync";
import { FinancialProviderError } from "../providers/types";

function connectionError(error: unknown) {
  if (error instanceof FinancialProviderError) {
    if (error.code === "configurationRequired")
      return "自動連携はまだ利用できません。残高の登録やカード明細の取り込みを使えます。";
    if (error.code === "networkOrCors")
      return "連携先に接続できませんでした。インターネットにつながっているか確認し、もう一度お試しください。";
    if (error.code === "unsupported")
      return "このブラウザーでは自動連携を利用できません。残高の登録やカード明細の取り込みを使えます。";
    return error.message;
  }
  return error instanceof Error
    ? error.message
    : "連携できませんでした。保存済みの記録は残っています。";
}

function acquiredAt(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value)))
    return "まだ取得していません";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function FinancialSettings() {
  const { data, toast } = usePace();
  const configured = moneytree.isConfigured();
  const [operation, setOperation] = useState<"connect" | "refresh" | null>(
    null,
  );
  const [error, setError] = useState("");
  const [disconnect, setDisconnect] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const operationGuard = useRef(false);
  const connection = data.financialConnections?.find(
    (c) => c.providerId === "moneytree" && c.status !== "disconnected",
  );
  const sync = data.syncStates?.find(
    (s) => s.id === (connection?.id ?? "moneytree:default"),
  );
  const connectedAccounts =
    data.accounts?.filter(
      (a) => a.connectionId === connection?.id && a.isActive && !!connection,
    ) ?? [];
  const nextRefresh = sync?.nextRefreshAllowedAt
    ? Date.parse(sync.nextRefreshAllowedAt)
    : NaN;
  const nextRead = sync?.lastAttemptAt
    ? Date.parse(sync.lastAttemptAt) + 60_000
    : NaN;
  const waiting = nextRefresh > clock || nextRead > clock;
  const availableAt = Math.max(
    Number.isFinite(nextRefresh) ? nextRefresh : 0,
    Number.isFinite(nextRead) ? nextRead : 0,
  );
  const syncing = operation !== null || sync?.status === "syncing";
  const needsAuthentication =
    connection?.status === "reauthentication" ||
    sync?.status === "reauthentication";
  const feedback = error || sync?.message;
  const failed =
    !!error ||
    [
      "error",
      "offline",
      "maintenance",
      "rateLimited",
      "reauthentication",
    ].includes(sync?.status ?? "");

  useEffect(() => {
    if (!Number.isFinite(availableAt) || availableAt <= Date.now()) return;
    const timeout = setTimeout(
      () => setClock(Date.now()),
      Math.min(availableAt - Date.now() + 50, 2_147_483_647),
    );
    return () => clearTimeout(timeout);
  }, [availableAt, clock]);

  async function connect() {
    if (operationGuard.current || !configured) return;
    operationGuard.current = true;
    setOperation("connect");
    setError("");
    try {
      await enableAccountManagement();
      const result = await moneytree.connect();
      if (!result.authorizationUrl)
        throw new Error("連携先を開けませんでした。もう一度お試しください。");
      location.assign(result.authorizationUrl);
    } catch (cause) {
      setError(connectionError(cause));
    } finally {
      operationGuard.current = false;
      setOperation(null);
    }
  }

  async function refresh() {
    if (operationGuard.current || !configured || !connection) return;
    operationGuard.current = true;
    setOperation("refresh");
    setError("");
    try {
      await syncFinancialConnection(moneytree, connection, true);
      toast("更新を依頼しました");
    } catch (cause) {
      setError(connectionError(cause));
    } finally {
      operationGuard.current = false;
      setClock(Date.now());
      setOperation(null);
    }
  }

  return (
    <div className="page financial-settings">
      <header className="page-header">
        <Link className="icon-button" to="/settings" aria-label="設定へ戻る">
          <ArrowLeft />
        </Link>
        <div>
          <span className="eyebrow">銀行・カード</span>
          <h1>銀行・カードの連携</h1>
        </div>
      </header>

      <section className="surface connection-overview">
        <span className="settings-icon">
          <Landmark />
        </span>
        <h2>
          {configured
            ? connection
              ? "Moneytreeとの連携"
              : "残高・明細を自動で取り込む"
            : "自動連携はまだ利用できません"}
        </h2>
        {!configured ? (
          <p>
            現在のPaceは、自動連携の準備中です。いまは残高の登録とカード明細の取り込みを使えます。
          </p>
        ) : !connection ? (
          <>
            <p>
              Moneytreeの画面でログインし、Paceへの連携を許可します。Paceに銀行のパスワードを入力する必要はありません。
            </p>
            <button
              className="button button-primary full"
              disabled={syncing}
              onClick={() => void connect()}
            >
              {operation === "connect" ? (
                <LoaderCircle size={19} className="spin" />
              ) : (
                <Landmark size={19} />
              )}
              {operation === "connect"
                ? "Moneytreeを開いています…"
                : "残高・明細の連携を許可して進む"}
            </button>
          </>
        ) : (
          <>
            <div className="chips">
              <span className="chip">
                {needsAuthentication
                  ? "再認証が必要"
                  : connectedAccounts.length
                    ? `${connectedAccounts.length}件の口座を連携中`
                    : "口座情報を確認中"}
              </span>
              <span className="chip">Moneytree</span>
            </div>
            <p className="microcopy">
              最後の取得：{acquiredAt(sync?.lastSuccessAt)}
            </p>
            {connectedAccounts.length > 0 && (
              <div className="connection-account-list">
                {connectedAccounts.map((account) => (
                  <Link className="settings-row" key={account.id} to="/money">
                    <span className="settings-icon">
                      {account.kind === "CREDIT_CARD" ? (
                        <CreditCard />
                      ) : (
                        <Landmark />
                      )}
                    </span>
                    <span>
                      <b>{account.name}</b>
                      <small>
                        {account.snapshotBalance === null
                          ? "残高は未取得"
                          : `${account.kind === "CREDIT_CARD" ? "未払い" : "残高"} ${yen(account.snapshotBalance)}`}
                      </small>
                    </span>
                    <ChevronRight size={18} />
                  </Link>
                ))}
              </div>
            )}
            {!connectedAccounts.length && sync?.lastSuccessAt && (
              <p className="inline-alert">
                連携した口座がありません。Moneytreeで銀行・カードの登録とPaceへの許可を確認してください。
              </p>
            )}
            {needsAuthentication ? (
              <button
                className="button button-primary full"
                disabled={syncing}
                onClick={() => void connect()}
              >
                {operation === "connect" && (
                  <LoaderCircle size={19} className="spin" />
                )}
                {operation === "connect"
                  ? "Moneytreeを開いています…"
                  : "Moneytreeで再認証する"}
              </button>
            ) : (
              <button
                className="button button-primary full"
                disabled={syncing || waiting}
                onClick={() => void refresh()}
              >
                <RefreshCw size={18} className={syncing ? "spin" : ""} />
                {syncing
                  ? "残高・明細を取得しています…"
                  : waiting
                    ? "次の更新を待っています"
                    : "残高・明細を更新"}
              </button>
            )}
            {waiting && !needsAuthentication && (
              <p className="hint" role="status">
                次に更新できる時刻：
                {acquiredAt(new Date(availableAt).toISOString())}
              </p>
            )}
            <p className="hint">
              銀行・カードの情報は、更新を依頼してから反映されるまで時間がかかることがあります。
            </p>
            <button
              className="text-button danger"
              disabled={syncing}
              onClick={() => setDisconnect(true)}
            >
              連携を解除する
            </button>
          </>
        )}
        {feedback && (
          <p
            className={failed ? "inline-alert" : "hint"}
            role={failed ? "alert" : "status"}
          >
            {feedback}
          </p>
        )}
        {configured && (
          <a
            href="https://institutions.moneytree.jp/"
            target="_blank"
            rel="noreferrer"
            className="text-button"
          >
            対応する銀行・カードを確認 <ExternalLink size={14} />
          </a>
        )}
      </section>

      <section className="surface settings-group">
        <div className="settings-section-heading">
          <h2>いま使える管理方法</h2>
          <p className="hint">金融連携を使わなくても、Paceで管理できます。</p>
        </div>
        <Link className="settings-row" to="/money?add=account">
          <span className="settings-icon">
            <Wallet />
          </span>
          <span>
            <b>銀行・電子マネーの残高を登録</b>
            <small>名前と現在の残高を入れるだけ</small>
          </span>
          <ChevronRight size={18} />
        </Link>
        <Link className="settings-row" to="/manage/cards?import=1">
          <span className="settings-icon">
            <FileSpreadsheet />
          </span>
          <span>
            <b>カード明細（CSV）を取り込む</b>
            <small>カード会社のCSVファイルを選ぶ</small>
          </span>
          <ChevronRight size={18} />
        </Link>
        <Link className="settings-row" to="/money">
          <span className="settings-icon">
            <Landmark />
          </span>
          <span>
            <b>登録した口座・残高を見る</b>
            <small>残高の確認・チャージ・振替</small>
          </span>
          <ChevronRight size={18} />
        </Link>
      </section>

      <Link className="settings-row surface" to="/privacy">
        <span className="settings-icon">
          <ShieldCheck />
        </span>
        <span>
          <b>プライバシーとデータの保護</b>
          <small>暗号化・アプリロック・バックアップ</small>
        </span>
        <ChevronRight size={18} />
      </Link>

      {disconnect && connection && (
        <Sheet
          title="Moneytreeとの連携を解除"
          onClose={() => setDisconnect(false)}
        >
          <AsyncForm
            label="連携を解除する"
            onSubmit={async (form) => {
              await disconnectFinancialConnection(
                moneytree,
                connection.id,
                form.get("remove") === "on",
              );
              setDisconnect(false);
              setError("");
              toast("連携を解除しました。残高は手動管理に引き継ぎます。");
            }}
          >
            <p>
              Moneytreeの認可と端末内の認証情報を削除します。手入力の記録と現在の残高は残します。
            </p>
            <label className="check-field">
              <input name="remove" type="checkbox" />
              取り込んだ明細・支出・入金も削除する
            </label>
            <p className="hint">
              チェックを入れなければ、取り込んだ記録も残します。
            </p>
          </AsyncForm>
        </Sheet>
      )}
    </div>
  );
}
