import type { PersonalizationSettings, QuickActionId } from "../types";
export const quickActionLabels: Record<QuickActionId, string> = {
  expense: "支出",
  receipt: "レシート",
  transfer: "振替",
  balance: "残高確認",
  income: "収入",
  history: "履歴",
  fixed: "固定費",
  inbox: "あとで整理",
};
export const defaultQuickActions: QuickActionId[] = [
  "receipt",
  "transfer",
  "balance",
];
export function orderedQuickActions(
  p: PersonalizationSettings,
): QuickActionId[] {
  const ids = (p.quickActions ?? defaultQuickActions).slice(0, 5),
    pins = p.pinnedQuickActions ?? [];
  if (!p.enabled) return ids;
  const movable = ids
    .filter((id) => !pins.includes(id))
    .sort((a, b) => (p.featureUses[b] ?? 0) - (p.featureUses[a] ?? 0));
  return ids.map((id) => (pins.includes(id) ? id : movable.shift()!));
}
