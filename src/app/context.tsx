import { createContext, useContext } from "react";
import type { AppData, Expense } from "../types";
import type { computeFinance } from "../domain/finance";
import type { useAppUpdate } from "../hooks/useAppUpdate";
export interface HistoryFilters {
  category?: string;
  month?: string;
  from?: string;
  to?: string;
  card?: string;
  account?: string;
}
export interface AppContextValue {
  historyFilters: HistoryFilters;
  openHistory: (filters: HistoryFilters) => void;
  data: AppData;
  finance: ReturnType<typeof computeFinance>;
  today: string;
  openExpense: (
    expense?: Expense,
    receipt?: boolean,
    input?: Partial<Expense>,
  ) => void;
  toast: (message: string, undo?: () => Promise<void>) => void;
  run: (action: () => Promise<void>, success?: string) => Promise<void>;
  appUpdate: ReturnType<typeof useAppUpdate>;
}
export const AppContext = createContext<AppContextValue | null>(null);
export function usePace() {
  const context = useContext(AppContext);
  if (!context) throw new Error("アプリの準備ができていません。");
  return context;
}
