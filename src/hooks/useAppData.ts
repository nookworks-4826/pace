import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import type { AppData } from "../types";
import { db, initializeDb, readAppData } from "../db";

export function useAppData(): { data: AppData | null; error: string | null } {
  const [data, setData] = useState<AppData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void initializeDb()
      .then(() => {
        if (cancelled) return;
        const subscription = liveQuery(() => readAppData(false)).subscribe({
          next: (value) => {
            setData(value);
            setError(null);
          },
          error: () => {
            db.vaultSession.readOnly = true;
            setError(
              "端末の保存領域を読み込めませんでした。Safariのプライベートブラウズや空き容量を確認してください。",
            );
          },
        });
        unsubscribe = () => subscription.unsubscribe();
      })
      .catch(() => {
        if (!cancelled)
          setError(
            "暗号化・データの形式・参照関係の確認を完了できませんでした。元の記録は変更していません。端末の空き容量を確認してください。",
          );
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
  return { data, error };
}
