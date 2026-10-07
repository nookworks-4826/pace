import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import { usePace } from "../app/context";
import { db } from "../db";
import { backupHealthLabel } from "../domain/backupHealth";
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
  const { data } = usePace(),
    [receipts, setReceipts] = useState<number | null>(null);
  useEffect(() => {
    const sub = liveQuery(() => db.receipts.count()).subscribe({
      next: setReceipts,
      error: () => setReceipts(null),
    });
    return () => sub.unsubscribe();
  }, []);
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
          <p className="hint">家計記録・残高・取り込んだ明細を保護します。</p>
        </div>
      </section>
      <section className="surface">
        <h2>保存と送信</h2>
        <p>
          保存済みレシート：
          {receipts === null ? "確認できません" : `${receipts}件`} ·
          バックアップ：
          {backupHealthLabel(data.settings.practical?.backupHealth)}
        </p>
        <p className="hint">
          バックアップの確認日時：
          {data.settings.practical?.backupHealth?.checkedAt
            ? new Date(
                data.settings.practical.backupHealth.checkedAt,
              ).toLocaleString("ja-JP")
            : "未確認"}
          。外部AI・外部OCR・金融API・解析・広告は使っていません。
        </p>
        <ul className="privacy-facts">
          <li>広告やアクセス解析はありません。</li>
          <li>家計データを外部AIに送りません。</li>
          <li>
            レシートの文字は端末で読み取ります。画像保存は毎回選択し、初期状態はオフです。
          </li>
          <li>
            使い方の最適化・通知設定は暗号化して端末に保存します。AIや解析サーバーへの送信はありません。
          </li>
          <li>銀行やカードへ自動接続せず、手入力とCSVで管理します。</li>
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
