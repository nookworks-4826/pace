import { useEffect, useState } from "react";
import { Fingerprint, KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { AsyncForm, Field, textValue } from "../components/UI";
import {
  disableLock,
  getLockConfig,
  checkDeviceAuthSupport,
  deviceAuthSupportText,
  registerDeviceAuth,
  registerPasskey,
  isPasskeyRegistered,
  setPin,
  verifyDeviceAuth,
  verifyPin,
} from "../domain/security";
import type { DeviceAuthSupport } from "../domain/security";
import { usePace } from "../app/context";
import { updateSettings } from "../db";
import { APP_NAME } from "../types";

export function LockScreen({
  onUnlocked,
  error: configError,
}: {
  onUnlocked: () => void;
  error?: string;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  let kind = "none";
  let passkey = false;
  try {
    kind = getLockConfig().kind;
    passkey = isPasskeyRegistered();
  } catch {
    /* configError is shown without access */
  }
  return (
    <div className="lock-screen">
      <img
        className="lock-logo"
        src={`${import.meta.env.BASE_URL}icon.svg`}
        alt=""
      />
      <h1>{APP_NAME}</h1>
      <p>あなたのお金を、あなたの手元に。</p>
      <div className="lock-panel">
        <LockKeyhole size={27} />
        <h2>ロックを解除</h2>
        {configError ? (
          <p className="form-error">{configError}</p>
        ) : kind === "device" ? (
          <>
            <button
              className="button button-primary full"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void verifyDeviceAuth()
                  .then((ok) => {
                    if (ok) onUnlocked();
                    else
                      setError(
                        "認証を完了できませんでした。もう一度お試しください。",
                      );
                  })
                  .catch((e: unknown) =>
                    setError(
                      e instanceof Error ? e.message : "認証できませんでした。",
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              <Fingerprint size={22} />
              {busy
                ? "確認しています…"
                : passkey
                  ? "パスキーで解除"
                  : "デバイスで認証"}
            </button>
          </>
        ) : (
          <AsyncForm
            label="ロックを解除"
            onSubmit={async (f) => {
              if (await verifyPin(textValue(f, "pin"))) onUnlocked();
              else
                throw new Error("PINが一致しません。もう一度ご確認ください。");
            }}
          >
            <Field label="6桁のPIN">
              <input
                name="pin"
                aria-label="6桁のPIN"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                className="pin-input"
              />
            </Field>
          </AsyncForm>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <details>
          <summary>認証できないとき</summary>
          <p className="hint">
            設定したPINまたは端末の認証で解除します。PINを忘れた場合は、保存済みバックアップを別の端末で復元してください。ブラウザデータを消すと、この端末の家計データも消えます。
          </p>
          {kind === "device" && (
            <p className="hint">
              Galaxyでは指紋、iPhoneではFace ID・Touch
              IDと画面ロックの設定を確認してください。認証画面に端末のPIN・パスコードが表示された場合は、それも利用できます。登録したパスキーを保存先から削除せず、設定したときと同じブラウザ・URLで開いてください。
            </p>
          )}
        </details>
      </div>
      <small>
        <ShieldCheck size={14} />
        家計データはこの端末内に保存されます
      </small>
    </div>
  );
}

export function SecuritySettings() {
  const { data, run, toast } = usePace();
  const [support, setSupport] = useState<DeviceAuthSupport | null>(null);
  const [checkRevision, setCheckRevision] = useState(0);
  const [kind, setKind] = useState(() => getLockConfig().kind);
  const [passkey, setPasskey] = useState(isPasskeyRegistered);
  const [choice, setChoice] = useState<
    "pin" | "device" | "passkey" | "none" | null
  >(null);
  const [confirmed, setConfirmed] = useState<{
    at: number;
    config: string;
  } | null>(null);
  const [changing, setChanging] = useState(false);
  const choose = (value: typeof choice) => {
    setConfirmed(null);
    setChoice(value);
  };
  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      const result = await checkDeviceAuthSupport();
      if (active) setSupport(result);
      pending = false;
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [checkRevision]);
  const notify = () => {
    setKind(getLockConfig().kind);
    setPasskey(isPasskeyRegistered());
    setConfirmed(null);
    setChoice(null);
    window.dispatchEvent(new Event("pace-lock-changed"));
    toast("ロック設定を保存しました");
  };
  return (
    <div className="security-settings">
      <div className="note-panel">
        <ShieldCheck size={22} />
        <span>
          現在：
          {kind === "none"
            ? "ロックなし"
            : kind === "pin"
              ? "6桁PIN"
              : passkey
                ? "パスキー"
                : "デバイス認証"}
        </span>
      </div>
      {kind === "device" && !choice && (
        <AsyncForm
          label="認証を試す"
          onSubmit={async () => {
            if (!(await verifyDeviceAuth()))
              throw new Error(
                "認証を完了できませんでした。もう一度お試しください。",
              );
            toast(
              passkey
                ? "パスキーで認証できました"
                : "デバイス認証を確認できました",
            );
          }}
          children={null}
        />
      )}
      <div className="security-options">
        <button
          className={`button ${choice === "passkey" ? "button-primary" : "button-secondary"}`}
          disabled={support !== "available" || changing}
          onClick={() => choose("passkey")}
        >
          <KeyRound size={19} /> パスキー
        </button>
        <button
          className={`button ${choice === "device" ? "button-primary" : "button-secondary"}`}
          disabled={support !== "available" || changing}
          onClick={() => choose("device")}
        >
          <Fingerprint size={19} />
          デバイス認証
        </button>
        <button
          className={`button ${choice === "pin" ? "button-primary" : "button-secondary"}`}
          disabled={changing}
          onClick={() => choose("pin")}
        >
          <LockKeyhole size={19} />
          6桁PIN
        </button>
        <button
          className="text-button"
          disabled={kind === "none" || changing}
          onClick={() => choose("none")}
        >
          ロックなし
        </button>
      </div>
      {support !== "available" && (
        <p className="hint" role="status">
          {support === null
            ? "認証への対応状況を確認しています…"
            : deviceAuthSupportText[support]}
        </p>
      )}
      {support !== "available" && (
        <button
          className="text-button"
          disabled={support === null}
          onClick={() => {
            setSupport(null);
            setCheckRevision((value) => value + 1);
          }}
        >
          もう一度確認
        </button>
      )}
      {choice && (
        <AsyncForm
          key={`${choice}-${Boolean(confirmed)}`}
          label={
            choice === "passkey"
              ? kind !== "none" && !confirmed
                ? "現在のロックで確認"
                : "パスキーを登録"
              : choice === "none"
                ? "ロックを解除する"
                : choice === "device"
                  ? "デバイス認証を設定"
                  : "PINを設定"
          }
          onSubmit={async (f) => {
            setChanging(true);
            try {
              // A separate button press after reauthentication preserves the user
              // gesture required by some Safari/passkey providers for create().
              if (choice === "passkey" && confirmed) {
                if (
                  Date.now() - confirmed.at > 60_000 ||
                  confirmed.config !== JSON.stringify(getLockConfig())
                ) {
                  setConfirmed(null);
                  throw new Error("もう一度、現在のロックで確認してください。");
                }
                await registerPasskey();
                notify();
                return;
              }
              if (
                kind === "pin" &&
                !(await verifyPin(textValue(f, "currentPin")))
              )
                throw new Error("現在のPINが一致しません。");
              if (kind === "device" && !(await verifyDeviceAuth()))
                throw new Error("現在のデバイス認証を完了してください。");
              if (choice === "passkey") {
                if (kind !== "none") {
                  setConfirmed({
                    at: Date.now(),
                    config: JSON.stringify(getLockConfig()),
                  });
                  return;
                }
                await registerPasskey();
              } else if (choice === "pin") {
                const pin = textValue(f, "newPin");
                if (pin !== textValue(f, "confirmPin"))
                  throw new Error("2回のPINが一致しません。");
                await setPin(pin);
              } else if (choice === "device") await registerDeviceAuth();
              else disableLock();
              notify();
            } finally {
              setChanging(false);
            }
          }}
        >
          {kind === "pin" && !confirmed && (
            <Field label="現在のPIN">
              <input
                type="password"
                name="currentPin"
                inputMode="numeric"
                autoComplete="off"
                pattern="[0-9]{6}"
                maxLength={6}
                required
              />
            </Field>
          )}
          {choice === "pin" && (
            <>
              <Field label="新しい6桁PIN">
                <input
                  type="password"
                  name="newPin"
                  inputMode="numeric"
                  autoComplete="new-password"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                />
              </Field>
              <Field label="PINをもう一度">
                <input
                  type="password"
                  name="confirmPin"
                  inputMode="numeric"
                  autoComplete="new-password"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                />
              </Field>
            </>
          )}
        </AsyncForm>
      )}
      {choice && !changing && (
        <button className="text-button" onClick={() => choose(null)}>
          変更をやめる
        </button>
      )}
      <Field label="アプリを離れてから再認証するまで">
        <select
          value={data.settings.lockAfterSeconds}
          onChange={(e) =>
            void run(() =>
              updateSettings({
                lockAfterSeconds: Number(e.target.value) as 0 | 60 | 300 | 900,
              }),
            )
          }
        >
          <option value="0">すぐ</option>
          <option value="60">1分</option>
          <option value="300">5分</option>
          <option value="900">15分</option>
        </select>
      </Field>
      <details className="security-help">
        <summary>ヘルプ</summary>
        <div className="device-auth-guide">
          <strong>
            <Fingerprint size={18} /> 指紋・顔認証などに対応
          </strong>
          <p className="hint">
            Galaxyの指紋認証、iPhoneのFace ID・Touch
            IDなどを利用できます。実際の方法は端末とブラウザによって異なり、端末の画面ロックで確認する場合もあります。
          </p>
          <details>
            <summary>Galaxyでパスキーを使う準備</summary>
            <ol>
              <li>
                Galaxyの設定で「指紋」を検索し、画面ロックと指紋を登録します。
              </li>
              <li>
                普段Paceを使うChromeなどの対応ブラウザで、このアプリのHTTPSの公開URLを開きます。
              </li>
              <li>
                「パスキー」→「パスキーを登録」を押し、端末が表示する保存先と本人確認の案内に従います。
              </li>
            </ol>
            <p className="hint">
              指紋の画像や生体情報をアプリが取得・保存することはありません。認証の保存先はOSの設定に従います。ブラウザを切り替えると家計データの保存領域も変わるため、普段使うブラウザで設定してください。
            </p>
          </details>
          <details>
            <summary>iPhoneでパスキーを使う準備</summary>
            <ol>
              <li>
                iPhoneの設定でFace IDまたはTouch IDとパスコードを設定します。
              </li>
              <li>
                「パスワード」など、利用するパスキーの保存先を有効にします。
              </li>
              <li>
                普段使うPaceを開き、「パスキー」→「パスキーを登録」を押して、端末の案内に従います。
              </li>
            </ol>
          </details>
          <p className="hint">
            パスキーはPaceを開く鍵です。保存先の設定によって鍵が同期されても、家計データはこの端末内に残り、他の端末へ自動では移りません。
          </p>
        </div>
        <p className="hint">
          アプリの起動時は毎回認証します。このロックは画面の閲覧を防ぐためのもので、端末内データ自体は暗号化しません。PINはソルト付きハッシュで保存します。バックアップは別途暗号化できます。
        </p>
        <p className="hint">
          PIN・デバイス認証・パスキーは、いずれか1つを設定します。家計データのバックアップにパスキーは含みません。復元先では改めて登録してください。ロックを変更・解除しても、保存先にあるパスキー自体は自動では削除されません。
        </p>
      </details>
    </div>
  );
}
