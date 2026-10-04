import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, CalendarDays, ChevronRight, Wallet } from "lucide-react";
import { usePace } from "../app/context";
import { AsyncForm, Field, money, textValue } from "../components/UI";
import { updateSettings } from "../db";
import { getBudgetCycle } from "../domain/budgetCycle";

const displayDate = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  return `${year}年${month}月${day}日`;
};
function validDay(value: string, label: string) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 31)
    throw new Error(`${label}は1〜31で入力してください。`);
  return day;
}

export function SalarySettings() {
  const { data, today, toast } = usePace();
  const settings = data.settings;
  const [mode, setMode] = useState(settings.budgetCycle?.mode ?? "calendar");
  const [startDay, setStartDay] = useState(
    String(
      settings.budgetCycle?.startDay ?? settings.salarySchedule?.payday ?? 1,
    ),
  );
  const [hasSalary, setHasSalary] = useState(settings.salarySchedule !== null);
  const [payday, setPayday] = useState(
    String(
      settings.salarySchedule?.payday ?? settings.budgetCycle?.startDay ?? 1,
    ),
  );
  const [variable, setVariable] = useState(
    settings.salarySchedule?.variableIncome ?? true,
  );
  let preview: ReturnType<typeof getBudgetCycle> | null = null;
  try {
    preview = getBudgetCycle(today, {
      mode,
      startDay: mode === "salary" ? validDay(startDay, "開始日") : 1,
    });
  } catch {
    // The form reports invalid days; an incomplete input has no period preview.
  }
  return (
    <div className="page dedicated-settings salary-settings-page">
      <header className="page-header">
        <Link className="icon-button" to="/settings" aria-label="設定へ戻る">
          <ArrowLeft />
        </Link>
        <div>
          <h1>給料日と予算の期間</h1>
          <p className="subtitle">お金の予定と、予算を区切る日。</p>
        </div>
      </header>
      <AsyncForm
        label="設定を保存"
        className="settings-page-form"
        onSubmit={async (form) => {
          const nextStartDay =
            mode === "salary"
              ? validDay(startDay, "予算の開始日")
              : (settings.budgetCycle?.startDay ??
                settings.salarySchedule?.payday ??
                1);
          const nextSalary = hasSalary
            ? {
                payday: validDay(payday, "給料日"),
                expectedAmount: textValue(form, "expected")
                  ? money(form.get("expected"), true)
                  : null,
                variableIncome: variable,
              }
            : null;
          await updateSettings({
            budgetCycle: { mode, startDay: nextStartDay },
            salarySchedule: nextSalary,
            setupReviewed: [...new Set([...settings.setupReviewed, "salary"])],
          });
          toast("給料日と予算の期間を保存しました");
        }}
      >
        <section className="surface">
          <h2>
            <CalendarDays size={21} aria-hidden="true" />
            予算の期間
          </h2>
          <Field label="予算を区切る日">
            <select
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as "calendar" | "salary")
              }
            >
              <option value="calendar">毎月1日〜月末</option>
              <option value="salary">給料日など、決めた日から1か月</option>
            </select>
          </Field>
          {mode === "salary" && (
            <Field label="毎月の開始日" hint="31日＝月末">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={31}
                step={1}
                required
                value={startDay}
                onChange={(event) => setStartDay(event.target.value)}
              />
            </Field>
          )}
          <div className="period-preview" aria-live="polite">
            <span className="hint">この設定での今の予算期間</span>
            <strong>
              {preview
                ? `${displayDate(preview.start)} 〜 ${displayDate(preview.end)}`
                : "開始日を1〜31で入力してください"}
            </strong>
          </div>
          {mode === "salary" && (
            <p className="hint">
              その日がない月は月末から始まります。給与が休日で前倒しされても、予算の区切りは変わりません。
            </p>
          )}
        </section>
        <section className="surface">
          <h2>
            <Wallet size={21} aria-hidden="true" />
            給料日の予定
          </h2>
          <label className="check-field setting-toggle">
            <input
              type="checkbox"
              checked={hasSalary}
              onChange={(event) => setHasSalary(event.target.checked)}
            />
            給料日の予定を表示する
          </label>
          {hasSalary && (
            <>
              <Field label="毎月の給料日" hint="31日＝月末">
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={31}
                  step={1}
                  required
                  value={payday}
                  onChange={(event) => setPayday(event.target.value)}
                />
              </Field>
              <Field label="予想の手取り額（任意）" hint="わからなければ空欄">
                <input
                  name="expected"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={999999999999}
                  step={1}
                  defaultValue={settings.salarySchedule?.expectedAmount ?? ""}
                  placeholder="円"
                />
              </Field>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={variable}
                  onChange={(event) => setVariable(event.target.checked)}
                />
                月によって金額が変わる
              </label>
            </>
          )}
          <p className="hint">
            予定だけでは残高は増えません。実際に入金されたら、収入を記録します。
          </p>
        </section>
      </AsyncForm>
      <Link className="settings-row surface" to="/manage/incomes">
        <span className="settings-icon">
          <Wallet />
        </span>
        <span>
          <b>収入を記録する</b>
          <small>実際に入ったお金</small>
        </span>
        <ChevronRight size={18} aria-hidden="true" />
      </Link>
    </div>
  );
}
