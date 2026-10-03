import type { BudgetCycleConfig } from "../types";
import {
  addDaysDate,
  addMonthsDate,
  dateKey,
  dateOnDay,
  daysBetween,
  monthEnd,
  monthKey,
  monthStart,
  todayJST,
} from "./dates";

export interface BudgetCycle {
  mode: "calendar" | "salary";
  startDay: number;
  start: string;
  end: string;
  nextStart: string;
  totalDays: number;
  elapsedDays: number;
  remainingDaysIncludingToday: number;
  key: string;
}

/** A budget period follows its configured calendar day, never an assumed salary deposit. */
export function getBudgetCycle(
  today = todayJST(),
  config?: BudgetCycleConfig,
): BudgetCycle {
  const current = dateKey(today);
  const mode = config?.mode ?? "calendar";
  const startDay = mode === "salary" ? config!.startDay : 1;
  if (!Number.isInteger(startDay) || startDay < 1 || startDay > 31)
    throw new Error("期間の開始日は1〜31で入力してください。");
  let start = monthStart(current);
  let nextStart = monthStart(addMonthsDate(start, 1));
  let end = monthEnd(current);
  if (mode === "salary") {
    const thisMonthStart = dateOnDay(monthKey(current), startDay);
    const startMonth =
      current >= thisMonthStart
        ? monthKey(current)
        : monthKey(addMonthsDate(monthStart(current), -1));
    start = dateOnDay(startMonth, startDay);
    // Recalculate from the configured day so February does not shift later periods.
    nextStart = dateOnDay(
      monthKey(addMonthsDate(`${startMonth}-01`, 1)),
      startDay,
    );
    end = addDaysDate(nextStart, -1);
  }
  return {
    mode,
    startDay,
    start,
    end,
    nextStart,
    totalDays: daysBetween(start, end) + 1,
    elapsedDays: daysBetween(start, current) + 1,
    remainingDaysIncludingToday: daysBetween(current, end) + 1,
    key: start,
  };
}

export function isInBudgetCycle(value: string, cycle: BudgetCycle): boolean {
  const day = dateKey(value);
  return day >= cycle.start && day <= cycle.end;
}

export function getCycleBudgetMonth(cycle: BudgetCycle) {
  const [year, month] = cycle.start.slice(0, 7).split("-").map(Number);
  return { year, month };
}
