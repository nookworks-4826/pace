import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Bell, ShieldCheck } from "lucide-react";
import { usePace } from "../app/context";
import { AsyncForm, Field } from "../components/UI";
import { saveReminderPreferences } from "../domain/reminderActions";
import {
  notificationConfig,
  reminderGroups,
  reminderLabels,
  privateNotificationMessage,
  applyNotificationIntensity,
} from "../domain/notificationCenter";
import type { ReminderKind, ReminderRule } from "../types";
import { ReminderCenter } from "./ReminderCenter";
import { NotificationSettings as LegacyDailyReminder } from "./NotificationSettings";
export function NotificationCenterSettings() {
  const { data, toast } = usePace(),
    [config, setConfig] = useState(() =>
      structuredClone(notificationConfig(data)),
    );
  const setRule = (kind: ReminderKind, next: Partial<ReminderRule>) =>
    setConfig((old) => ({
      ...old,
      rules: {
        ...old.rules,
        [kind]: { ...old.rules[kind], ...next, explicitlyConfigured: true },
      },
    }));
  return (
    <div className="page dedicated-settings">
      <header className="page-header">
        <Link to="/settings" className="icon-button" aria-label="設定へ戻る">
          <ArrowLeft />
        </Link>
        <div>
          <h1>通知センター</h1>
          <p className="subtitle">必要な確認を、必要な時間に。</p>
        </div>
        <Bell />
      </header>
      <ReminderCenter />
      <p className="note-panel">
        <ShieldCheck size={18} />
        アプリ内リマインダーは端末内だけで判定します。Paceを閉じている間は時刻通知を保証できません。
      </p>
      <AsyncForm
        label="通知設定を保存"
        onSubmit={async () => {
          await saveReminderPreferences(config);
          toast("通知設定を保存しました");
        }}
      >
        <section className="surface">
          <h2>通知の量</h2>
          <Field label="通知の量">
            <select
              value={config.intensity ?? "standard"}
              onChange={(e) =>
                setConfig(
                  applyNotificationIntensity(
                    config,
                    e.target.value as NonNullable<typeof config.intensity>,
                  ),
                )
              }
            >
              <option value="quiet">静かに</option>
              <option value="standard">標準</option>
              <option value="active">しっかり確認</option>
            </select>
          </Field>
          <p className="hint">
            静かには日々の通知を控えます。個別に変更したON/OFF・時刻を優先し、通知を勝手にONにはしません。
          </p>
        </section>
        <section className="surface">
          <h2>通知しない時間</h2>
          <label className="check-field">
            <input
              type="checkbox"
              checked={config.quietEnabled}
              onChange={(e) =>
                setConfig({ ...config, quietEnabled: e.target.checked })
              }
            />
            Quiet Hoursを使う
          </label>
          <div className="form-grid">
            <Field label="開始">
              <input
                type="time"
                required
                value={config.quietStart}
                onChange={(e) =>
                  setConfig({ ...config, quietStart: e.target.value })
                }
              />
            </Field>
            <Field label="終了">
              <input
                type="time"
                required
                value={config.quietEnd}
                onChange={(e) =>
                  setConfig({ ...config, quietEnd: e.target.value })
                }
              />
            </Field>
          </div>
        </section>
        {reminderGroups.map((group) => (
          <section className="surface" key={group.name}>
            <h2>{group.name}</h2>
            {group.kinds.map((kind) => {
              const r = config.rules[kind];
              return (
                <details className="notification-rule" key={kind}>
                  <summary>
                    {reminderLabels[kind]}
                    <span>
                      {r.enabled ? "ON" : "OFF"} · {r.time}
                    </span>
                  </summary>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) =>
                        setRule(kind, { enabled: e.target.checked })
                      }
                    />
                    このリマインダーを使う
                  </label>
                  <div className="form-grid">
                    <Field label="時刻（日本時間）">
                      <input
                        type="time"
                        required
                        value={r.time}
                        onChange={(e) =>
                          setRule(kind, { time: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="頻度">
                      <select
                        value={r.frequency}
                        onChange={(e) =>
                          setRule(kind, {
                            frequency: e.target
                              .value as ReminderRule["frequency"],
                          })
                        }
                      >
                        <option value="daily">毎日（指定曜日）</option>
                        <option value="weekly">週1回（最初の指定曜日）</option>
                        <option value="monthly">月1回</option>
                      </select>
                    </Field>
                  </div>
                  <fieldset className="weekday-picker">
                    <legend>曜日</legend>
                    {["日", "月", "火", "水", "木", "金", "土"].map(
                      (day, i) => (
                        <label key={i}>
                          <input
                            type="checkbox"
                            checked={r.days.includes(i)}
                            onChange={(e) =>
                              setRule(kind, {
                                days: e.target.checked
                                  ? [...r.days, i]
                                  : r.days.filter((d) => d !== i),
                              })
                            }
                          />
                          {day}
                        </label>
                      ),
                    )}
                  </fieldset>
                  {r.frequency === "monthly" &&
                    kind !== "payday" &&
                    kind !== "card" && (
                      <Field label="毎月の日">
                        <input
                          type="number"
                          min="1"
                          max="31"
                          required
                          value={r.monthDay}
                          onChange={(e) =>
                            setRule(kind, { monthDay: Number(e.target.value) })
                          }
                        />
                      </Field>
                    )}
                  {(kind === "payday" || kind === "card") && (
                    <p className="hint">
                      給料日・各カードの支払日を使います。初期設定の日が10日とは限りません。
                    </p>
                  )}
                  <Field label="スヌーズ">
                    <select
                      value={r.snoozeMinutes}
                      onChange={(e) =>
                        setRule(kind, { snoozeMinutes: Number(e.target.value) })
                      }
                    >
                      {[15, 30, 60, 180, 1440].map((n) => (
                        <option key={n} value={n}>
                          {n === 1440 ? "1日" : `${n}分`}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={r.showAmount}
                      onChange={(e) =>
                        setRule(kind, { showAmount: e.target.checked })
                      }
                    />
                    アプリ内の通知に金額を表示
                  </label>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={r.badge}
                      onChange={(e) =>
                        setRule(kind, { badge: e.target.checked })
                      }
                    />
                    アプリ内の未確認件数に含める
                  </label>
                  <p className="hint">
                    ロック画面のプレビュー：{privateNotificationMessage(kind)}
                  </p>
                  <p className="hint">
                    条件が発生したときだけ表示します。端末の通知には金額を載せません。
                  </p>
                </details>
              );
            })}
          </section>
        ))}
      </AsyncForm>
      <details className="surface">
        <summary>アプリを開いている間の通知・カレンダー</summary>
        <p className="hint">
          汎用の毎日リマインダーです。カレンダーの予定はPace外に保存されるため、Quiet
          Hours・スヌーズ・ON/OFFはカレンダーで管理してください。
        </p>
        <LegacyDailyReminder embedded />
      </details>
    </div>
  );
}
