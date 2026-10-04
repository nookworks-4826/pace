import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ChevronRight,
  Database,
  Fingerprint,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import { lockVault } from "../domain/vault";

export function PrivacySettings() {
  return (
    <div className="page dedicated-settings privacy-settings-page">
      <header className="page-header">
        <Link className="icon-button" to="/settings" aria-label="設定へ戻る">
          <ArrowLeft />
        </Link>
        <div>
          <h1>プライバシー</h1>
          <p className="subtitle">自分のお金の情報を、自分で守る。</p>
        </div>
      </header>
      <section className="surface settings-summary">
        <ShieldCheck size={28} aria-hidden="true" />
        <div>
          <h2>この端末で暗号化して保存</h2>
          <p className="hint">
            家計記録・レシート・連携の認証情報を保護します。
          </p>
        </div>
      </section>
      <section className="surface">
        <h2>保存と送信</h2>
        <ul className="privacy-facts">
          <li>広告やアクセス解析はありません。</li>
          <li>家計データを外部AIに送りません。</li>
          <li>レシートの文字は端末で読み取ります。</li>
          <li>
            金融連携を許可した場合だけ、連携サービスから残高・明細を取得します。
          </li>
        </ul>
        <p className="hint">
          機種変更やブラウザデータの削除前には、バックアップを作成してください。
        </p>
      </section>
      <section className="surface settings-group">
        <Link className="settings-row" to="/settings?panel=security">
          <span className="settings-icon">
            <Fingerprint />
          </span>
          <span>
            <b>アプリロック</b>
            <small>PIN・指紋・顔認証・パスキー</small>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </Link>
        <Link className="settings-row" to="/settings?panel=data">
          <span className="settings-icon">
            <Database />
          </span>
          <span>
            <b>バックアップと書き出し</b>
            <small>データを手元に保存する</small>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </Link>
      </section>
      <button
        className="button button-secondary full"
        onClick={() => lockVault()}
      >
        <LockKeyhole size={19} aria-hidden="true" />
        今すぐ保管庫をロック
      </button>
    </div>
  );
}
