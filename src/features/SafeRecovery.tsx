import { useState } from "react";
import { saveAs } from "file-saver";
import { db } from "../db";
export function SafeRecovery({ message }: { message: string }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function preserve() {
    setBusy(true);
    setError("");
    try {
      const native = db.backendDB(),
        names = Array.from(native.objectStoreNames),
        tx = native.transaction(names, "readonly");
      const tables: Record<string, unknown[]> = {};
      await Promise.all(
        names.map(
          (name) =>
            new Promise<void>((resolve, reject) => {
              const request = tx.objectStore(name).getAll();
              request.onsuccess = () => {
                tables[name] = request.result;
                resolve();
              };
              request.onerror = () =>
                reject(new Error("元の保存データを読み出せませんでした。"));
            }),
        ),
      );
      if (!tables.vaultMeta?.length)
        throw new Error(
          "暗号化の状態を確認できないため、書き出しを中止しました。",
        );
      saveAs(
        new Blob(
          [
            JSON.stringify({
              format: "pace-encrypted-recovery",
              databaseVersion: native.version,
              tables,
            }),
          ],
          { type: "application/octet-stream" },
        ),
        "pace-protected-recovery.json",
      );
    } catch {
      setError(
        "保護用ファイルを作成できませんでした。元のデータは変更していません。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="page">
      <section className="surface">
        <h1>データを保護して停止しました</h1>
        <p>{message}</p>
        <p>読み取り専用です。記録の追加・修復・削除は行いません。</p>
        <div className="button-row">
          <button
            className="button button-primary"
            onClick={() => location.reload()}
          >
            もう一度確認
          </button>
          <button
            className="button button-secondary"
            disabled={busy}
            onClick={() => void preserve()}
          >
            元の暗号化データを保存
          </button>
        </div>
        <p className="hint">
          保護用ファイルは通常のバックアップとは別形式です。この画面から自動復元はできません。保管庫のパスフレーズと以前のバックアップを保管してください。
        </p>
        {error && <p role="alert">{error}</p>}
      </section>
    </main>
  );
}
