import { useEffect, useState } from "react";
import { usePace } from "../app/context";
import { Field } from "../components/UI";
import { updateSettings } from "../db";
import {
  defaultPersonalization,
  orderHomeCards,
} from "../domain/personalization";
import { quickActionLabels, defaultQuickActions } from "../domain/quickActions";
import type { QuickActionId } from "../types";
import type { AppearanceSettings, HomeCardId } from "../types";
const appearance: AppearanceSettings = {
  accent: "blue",
  background: "tint",
  cards: "standard",
  density: "standard",
};
export function ExperienceSettings() {
  const { data, today, toast } = usePace();
  const [p, setPreferences] = useState(
      data.settings.personalization ?? defaultPersonalization,
    ),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setPreferences(data.settings.personalization ?? defaultPersonalization);
  }, [data.settings.personalization]);
  async function save(next: typeof p, message?: string) {
    setPreferences(next);
    setBusy(true);
    try {
      await updateSettings({ personalization: next });
      if (message) toast(message);
    } catch {
      setPreferences(data.settings.personalization ?? defaultPersonalization);
      toast("設定を保存できませんでした。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  }
  const ids = p.quickActions ?? defaultQuickActions,
    pins = p.pinnedQuickActions ?? [];
  return (
    <section className="surface experience-settings">
      <fieldset className="plain-fieldset" disabled={busy}>
        <h2>自分の使い方に合わせる</h2>
        <label className="check-field">
          <input
            type="checkbox"
            checked={p.enabled}
            onChange={(e) => void save({ ...p, enabled: e.target.checked })}
          />
          Paceが使い方に合わせて表示を最適化
        </label>
        <p className="hint">
          支払元の候補・ホームの操作・補助カードを調整します。今使っていい金額は常に上部に表示します。
        </p>
        <details>
          <summary>ホームの操作を選ぶ（最大5つ）</summary>
          {(Object.keys(quickActionLabels) as QuickActionId[]).map((id) => (
            <div className="quick-action-preference" key={id}>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={ids.includes(id)}
                  disabled={
                    (!ids.includes(id) && ids.length >= 5) ||
                    (ids.length === 1 && ids.includes(id))
                  }
                  onChange={(e) =>
                    void save({
                      ...p,
                      quickActions: e.target.checked
                        ? [...ids, id]
                        : ids.filter((x) => x !== id),
                      pinnedQuickActions: pins.filter((x) => x !== id),
                    })
                  }
                />
                {quickActionLabels[id]}
              </label>
              {ids.includes(id) && (
                <>
                  <button
                    className="text-button"
                    aria-pressed={pins.includes(id)}
                    onClick={() =>
                      void save({
                        ...p,
                        pinnedQuickActions: pins.includes(id)
                          ? pins.filter((x) => x !== id)
                          : [...pins, id],
                      })
                    }
                  >
                    {pins.includes(id) ? "固定中" : "固定"}
                  </button>
                  <button
                    className="text-button"
                    disabled={ids.indexOf(id) === 0}
                    aria-label={`${quickActionLabels[id]}を前へ`}
                    onClick={() => {
                      const next = [...ids],
                        i = next.indexOf(id);
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      void save({ ...p, quickActions: next });
                    }}
                  >
                    ↑
                  </button>
                </>
              )}
            </div>
          ))}
          <p className="hint">
            固定した位置を優先。最適化をOFFにすると選んだ順になります。
          </p>
        </details>
        <details>
          <summary>補助カードを固定</summary>
          {(["balances", "insight", "recent"] as HomeCardId[]).map((id) => (
            <label className="check-field" key={id}>
              <input
                type="checkbox"
                checked={p.pinnedCards.includes(id)}
                onChange={(e) =>
                  void save({
                    ...p,
                    homeCardOrder: orderHomeCards(data, today),
                    pinnedCards: e.target.checked
                      ? [...p.pinnedCards, id]
                      : p.pinnedCards.filter((x) => x !== id),
                  })
                }
              />
              {
                {
                  balances: "お金の内訳",
                  insight: "記録の傾向",
                  recent: "最近の支出",
                }[id]
              }
            </label>
          ))}
          <button
            className="text-button"
            onClick={() =>
              void save({ ...p, featureUses: {} }, "利用集計をリセットしました")
            }
          >
            利用集計をリセット
          </button>
        </details>
      </fieldset>
    </section>
  );
}
export function AppearanceControls() {
  const { data, run } = usePace(),
    current = data.settings.appearance ?? appearance;
  const choices: Record<keyof AppearanceSettings, Record<string, string>> = {
    accent: {
      blue: "Blue",
      sky: "Sky Blue",
      indigo: "Indigo",
      teal: "Teal",
      green: "Green",
      graphite: "Graphite",
      purple: "Purple",
      orange: "Orange",
    },
    background: {
      flat: "Flat",
      tint: "Soft Tint",
      gradient: "Gradient",
      glass: "Glass",
      glow: "Blur Glow",
    },
    cards: { standard: "Standard", soft: "Soft", glass: "Glass", flat: "Flat" },
    density: {
      compact: "Compact",
      standard: "Standard",
      comfortable: "Comfortable",
    },
  };
  return (
    <>
      {(Object.keys(choices) as (keyof AppearanceSettings)[]).map((key) => (
        <Field
          key={key}
          label={
            {
              accent: "アクセントカラー",
              background: "背景",
              cards: "カード",
              density: "表示密度",
            }[key]
          }
        >
          <select
            value={current[key]}
            onChange={(e) =>
              void run(() =>
                updateSettings({
                  appearance: { ...current, [key]: e.target.value },
                }),
              )
            }
          >
            {Object.entries(choices[key]).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      ))}
    </>
  );
}
