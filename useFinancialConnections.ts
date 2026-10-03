import { useEffect } from "react";
import type { AppData } from "../types";
import { createMoneytreeProvider } from "../providers/moneytree";
import { consumeOAuthCallback } from "../providers/moneytree/pkce";
import { db } from "../db";
import {
  encryptedCredentials,
  syncFinancialConnection,
} from "../domain/financialSync";
export const moneytree = createMoneytreeProvider({
  store: encryptedCredentials,
});
// Authorization response is scrubbed before rendering or unlocking financial data.
let callback =
  typeof location === "undefined"
    ? null
    : consumeOAuthCallback(location.href, (url) =>
        history.replaceState(null, "", url),
      );
if (typeof window !== "undefined")
  window.addEventListener("pace:financial-reset", () => {
    callback = null;
  });
export function useFinancialConnections(data: AppData | null) {
  useEffect(() => {
    if (!data) return;
    const incoming = callback;
    callback = null;
    if (incoming)
      void (async () => {
        const now = new Date().toISOString();
        const epoch = moneytree.lifecycleEpoch();
        try {
          await moneytree.completeAuthorization(incoming);
          const connection = {
            id: "moneytree:default",
            createdAt: now,
            updatedAt: now,
            providerId: "moneytree" as const,
            status: "connected" as const,
            institutionIds: [],
            consentedAt: now,
          };
          await db.transaction("rw", db.financialConnections, async () => {
            if (moneytree.lifecycleEpoch() !== epoch)
              throw new Error("接続が変更されたため中止しました。");
            await db.financialConnections.put(connection);
          });
          await syncFinancialConnection(moneytree, connection);
        } catch (error) {
          if (moneytree.lifecycleEpoch() !== epoch) return;
          await db.syncStates.put({
            id: "moneytree:default",
            lastAttemptAt: now,
            lastSuccessAt: null,
            nextRefreshAllowedAt: null,
            status: "error",
            message:
              error instanceof Error ? error.message : "接続できませんでした。",
          });
        }
        if (moneytree.lifecycleEpoch() === epoch) location.hash = "#/financial";
      })();
  }, [Boolean(data)]);
  useEffect(() => {
    if (!data?.settings.financialAutomationEnabled) return;
    const c = data.financialConnections?.find(
      (c) => c.providerId === "moneytree" && c.status === "connected",
    );
    if (!c) return;
    const state = data.syncStates?.find((s) => s.id === c.id);
    // At most one read attempt per stale session; provider refresh budget remains separate.
    if (
      state?.lastAttemptAt &&
      Date.now() - Date.parse(state.lastAttemptAt) < 15 * 60_000
    )
      return;
    if (
      state?.lastSuccessAt &&
      Date.now() - Date.parse(state.lastSuccessAt) < 60 * 60_000
    )
      return;
    void syncFinancialConnection(moneytree, c, false).catch(() => {});
  }, [data?.settings.financialAutomationEnabled, data?.financialConnections]);
}
