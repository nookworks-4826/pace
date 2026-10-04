import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ChevronRight,
  FileSpreadsheet,
  Landmark,
  ShieldCheck,
  Wallet,
} from "lucide-react";

export function FinancialSettings() {
  return (
    <div className="page financial-settings">
      <header className="page-header">
        <Link className="icon-button" to="/settings" aria-label="設定へ戻る">
          <ArrowLeft />
        </Link>
        <div>
          <span className="eyebrow">自分のペースで管理</span>
          <h1>口座・カードの管理</h1>
        </div>
      </header>

      <section className="surface connection-overview">
        <span className="settings-icon">
          <Wallet />
        </span>
        <h2>使っているお金をまとめる</h2>
        <p>残高は自分で登録、カード明細はCSVで取り込みます。</p>
        <Link className="button button-primary full" to="/money?add=account">
          <Wallet size={19} />
          口座・残高を登録する
        </Link>
      </section>

      <section className="surface settings-group">
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
    </div>
  );
}
