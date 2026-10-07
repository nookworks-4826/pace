import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { saveAs } from "file-saver";
import { ArrowLeft, Bell, CalendarDays, ShieldCheck } from "lucide-react";
import { usePace } from "../app/context";
import { AsyncForm, Field, textValue } from "../components/UI";
import { updateSettings } from "../db";
import {
  buildDailyReminder,
  enableForegroundNotifications,
} from "../domain/reminders";
import type { ReminderSettings } from "../types";

const defaultReminder: ReminderSettings = {
  enabled: false,
  time: "08:00",
  privacyMode: "generic",
  delivery: "calendar",
};

export function NotificationSettings({embedded=false}:{embedded?:boolean} = {}) {
  const { data, today, toast } = usePace();
  const saved = data.settings.reminder ?? defaultReminder;
  const [enabled, setEnabled] = useState(saved.enabled);
  const [time, setTime] = useState(saved.time);
  const [delivery, setDelivery] = useState(saved.delivery);
  const [permission, setPermission] = useState(() =>
    "Notification" in window ? Notification.permission : null,
  );
  useEffect(() => {
    setEnabled(saved.enabled);
    setTime(saved.time);
    setDelivery(saved.delivery);
  }, [saved.enabled, saved.time, saved.delivery]);
  useEffect(() => {
    const refresh = () =>
      setPermission("Notification" in window ? Notification.permission : null);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const needsPermission =
    saved.enabled &&
    saved.delivery === "foreground" &&
    permission !== "granted";

  return (
    <div className={embedded?"notifications-embedded":"page dedicated-settings notifications-page"}>
      {!embedded&&<header className="page-header">
        <Link className="icon-button" to="/settings" aria-label="設定へ戻る">
          <ArrowLeft />
        </Link>
        <div>
          <h1>通知とリマインダー</h1>
          <p className="subtitle">お金を見直す時間を、自分で決める。</p>
        </div>
      </header>}
      <section className="surface settings-summary">
        <Bell size={26} aria-hidden="true" />
        <div>
          <h2>
            {!saved.enabled
              ? "端末への通知はオフ"
              : needsPermission && permission === null
                ? "この端末では通知を使えません"
                : needsPermission
                  ? "通知の許可が必要です"
                  : `毎日 ${saved.time}`}
          </h2>
          <p className="hint">
            {saved.enabled
              ? saved.delivery === "calendar"
                ? "カレンダーに追加するとお知らせします。"
                : "Paceを開いている間にお知らせします。"
              : "必要なときだけ使えます。"}
          </p>
        </div>
      </section>
      <section className="surface">
        <AsyncForm
          label={
            !enabled
              ? "設定を保存"
              : delivery === "calendar"
                ? "保存してカレンダーに追加"
                : "通知を設定"
          }
          onSubmit={async (form) => {
            const nextTime = enabled ? textValue(form, "time") : time;
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(nextTime))
              throw new Error("通知する時刻を選んでください。");
            if (enabled && delivery === "foreground") {
              try {
                await enableForegroundNotifications();
              } finally {
                setPermission(
                  "Notification" in window ? Notification.permission : null,
                );
              }
            }
            if (enabled && delivery === "calendar") {
              // Start the file download inside the submit gesture, including on iPhone.
              saveAs(
                new Blob([buildDailyReminder(nextTime, today)], {
                  type: "text/calendar;charset=utf-8",
                }),
                "pace-daily-reminder.ics",
              );
            }
            await updateSettings({
              reminder: {
                ...saved,
                enabled,
                time: nextTime,
                privacyMode: "generic",
                delivery,
              },
            });
            toast(
              enabled && delivery === "calendar"
                ? "予定ファイルを作成しました。カレンダーで追加してください。"
                : enabled
                  ? "通知を設定しました"
                  : "リマインダーをオフにしました",
            );
          }}
        >
          <label className="check-field setting-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            リマインダーを使う
          </label>
          {enabled && (
            <>
              <Field label="毎日知らせる時刻" hint="日本時間">
                <input
                  name="time"
                  type="time"
                  required
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                />
              </Field>
              <Field label="知らせ方">
                <select
                  value={delivery}
                  onChange={(event) =>
                    setDelivery(
                      event.target.value as ReminderSettings["delivery"],
                    )
                  }
                >
                  <option value="calendar">カレンダーの予定</option>
                  <option value="foreground" disabled={permission === null}>
                    Paceを開いている間の通知
                  </option>
                </select>
              </Field>
              <div className="note-panel reminder-note">
                <CalendarDays size={20} aria-hidden="true" />
                <span>
                  {delivery === "calendar"
                    ? "予定ファイルが開いたら、カレンダーに保存してください。通知はカレンダーの設定に従います。"
                    : "Paceを閉じている間は届きません。閉じていても知らせるには、カレンダーを選んでください。"}
                </span>
              </div>
              {delivery === "foreground" && permission !== "granted" && (
                <p className="hint">
                  {permission === null
                    ? "この端末ではカレンダーの予定を利用してください。"
                    : "「通知を設定」を押すと、端末に通知の許可を確認します。"}
                  {permission === "denied" &&
                    "ブロックされている場合は、ブラウザや端末の設定で許可してください。"}
                </p>
              )}
            </>
          )}
          <p className="hint reminder-privacy">
            <ShieldCheck size={16} aria-hidden="true" />
            通知に残高・支出・口座名は載せません。
          </p>
        </AsyncForm>
        <p className="hint">
          カレンダーに追加した予定は、時刻の変更やオフにするときもカレンダー側で編集・削除してください。
        </p>
      </section>
    </div>
  );
}
