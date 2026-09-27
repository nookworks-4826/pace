import { useState } from "react";
import {
  ArrowRight,
  Check,
  CreditCard,
  Landmark,
  ShieldCheck,
  Sparkles,
  Wallet,
} from "lucide-react";
import { usePace } from "../app/context";
import { updateSettings } from "../db";
import { APP_NAME } from "../types";
import { FinanceEditor } from "./Management";
import type { Editor } from "./Management";
import { SecuritySettings } from "./Security";
import { yen } from "../components/UI";
import { PaceJourney } from "../components/PaceJourney";

export function Onboarding() {
  const { data, finance, run } = usePace();
  const [step, setStep] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saving, setSaving] = useState(false);
  const steps = [
    {
      title: `自分のペースで、\nお金を整える。`,
      description:
        "口座にある金額だけではなく、カード未払い・固定費・返済予定を考慮して、今使っていい金額を分かりやすくします。",
      icon: Sparkles,
    },
    {
      title: "今、持っているお金",
      description:
        "銀行口座＋現金の合計を入力します。貯金として別にしてあるお金は除いてください。",
      icon: Wallet,
    },
    {
      title: "カードで使った分も、\n先に見えるように。",
      description: "利用するカードを追加します。カード番号の入力は不要です。",
      icon: CreditCard,
    },
    {
      title: "すでに使った、\nまだ引き落とされていない分",
      description:
        "現在のカード未払いを確認します。このアプリに記録する前の利用分を入力してください。",
      icon: CreditCard,
    },
    {
      title: "返すお金も、\n無理なく見通す。",
      description:
        "親などへの借入残高を入力します。正確に分からないときは概算として登録できます。",
      icon: Landmark,
    },
    {
      title: "次の給料日",
      description:
        "予想額は未入力でも大丈夫。実際に入金されるまで、使っていい金額には含めません。",
      icon: Wallet,
    },
    {
      title: "今月のペースを決める",
      description:
        "月予算を決めると、月末までの1日あたりの目安も計算できます。",
      icon: Sparkles,
    },
    {
      title: "いつもの支払いを先に確保",
      description:
        "スマホ・サブスクなどの固定費。支払日前から予定分を差し引きます。",
      icon: Wallet,
    },
    {
      title: "これからの楽しみに",
      description:
        "貯金目標と毎月の予定を決められます。実際に移した金額も記録できます。",
      icon: Sparkles,
    },
    {
      title: "あなたの情報を守る",
      description:
        "端末認証または6桁PINでアプリをロックできます。後から設定することもできます。",
      icon: ShieldCheck,
    },
    {
      title: "あなたのペースで、\nはじめましょう。",
      description:
        "使ったら、使った日に記録。金額はいつでも見直せます。分からなかった項目は、あとで設定できます。",
      icon: Check,
    },
  ];
  const current = steps[step];
  const Icon = current.icon;
  const modes: Partial<Record<number, Editor["mode"]>> = {
    1: "balance",
    2: "card",
    4: "debt",
    5: "salary",
    6: "budget",
    7: "recurring",
    8: "savings",
  };
  const next = () => setStep(Math.min(10, step + 1));
  const finish = async () => {
    if (saving) return;
    setSaving(true);
    await run(() => updateSettings({ onboardingCompleted: true }));
    setSaving(false);
  };
  return (
    <main className="onboarding">
      <div className="onboarding-top">
        <span className="brand">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
          {APP_NAME}
        </span>
        <span>{step + 1} / 11</span>
      </div>
      <div className="step-progress">
        {steps.map((_, i) => (
          <span key={i} className={i <= step ? "active" : ""} />
        ))}
      </div>
      {step === 0 || step === 10 ? (
        <PaceJourney />
      ) : (
        <div className="onboarding-illustration">
          <Icon size={48} strokeWidth={1.3} />
          <span className="orbit-ring" />
        </div>
      )}
      <div className="onboarding-copy">
        <p className="eyebrow">
          {step === 0
            ? "A LITTLE CLARITY, EVERY DAY"
            : step === 10
              ? "READY WHEN YOU ARE"
              : "A FEW THINGS TO BEGIN"}
        </p>
        <h1>{current.title}</h1>
        <p>{current.description}</p>
      </div>
      <div className="onboarding-content">
        {step === 1 && (
          <>
            <div className="onboarding-value">
              {finance.liquidBalance === null
                ? "まだ入力されていません"
                : yen(finance.liquidBalance)}
            </div>
            <p className="hint">
              不明な場合はあとで入力できます。仮の金額で計算することはありません。
            </p>
          </>
        )}
        {(step === 2 || step === 3) &&
          data.cards.map((c) => (
            <button
              className="settings-row surface"
              key={c.id}
              onClick={() => setEditor({ mode: "card", entity: c })}
            >
              <CreditCard size={20} />
              <span>{c.name}</span>
              <b>{yen(c.openingOutstanding)}</b>
            </button>
          ))}
        {step === 3 && !data.cards.length && (
          <p className="hint">
            カードはまだ登録されていません。あとでカード画面から追加できます。
          </p>
        )}
        {step === 4 &&
          data.debts.map((d) => (
            <div key={d.id} className="info-pair">
              <span>
                {d.lenderName} · {d.title}
              </span>
              <b>
                {d.isEstimated ? "約 " : ""}
                {yen(d.currentBalance)}
              </b>
            </div>
          ))}
        {step === 5 && data.settings.salarySchedule && (
          <div className="onboarding-value">
            毎月{data.settings.salarySchedule.payday}日
          </div>
        )}
        {step === 6 && finance.monthlyBudget !== null && (
          <div className="onboarding-value">{yen(finance.monthlyBudget)}</div>
        )}
        {step === 7 &&
          data.recurringExpenses.map((r) => (
            <div key={r.id} className="info-pair">
              <span>{r.name}</span>
              <b>{yen(r.amount)}</b>
            </div>
          ))}
        {step === 8 &&
          data.savingsGoals.map((g) => (
            <div key={g.id} className="info-pair">
              <span>{g.name}</span>
              <b>{yen(g.targetAmount)}</b>
            </div>
          ))}
        {step === 9 && <SecuritySettings />}
        {step === 10 && (
          <div className="onboarding-summary">
            <span>今使っていい金額</span>
            <strong>
              {finance.safeToSpend === null
                ? "現在残高を入力すると計算できます"
                : yen(Math.max(0, finance.safeToSpend))}
            </strong>
            <small>入力済みの情報から計算しています</small>
          </div>
        )}
      </div>
      <div className="onboarding-actions">
        {modes[step] && (
          <button
            className="button button-primary full"
            onClick={() => setEditor({ mode: modes[step]! })}
          >
            {step === 1
              ? "現在残高を入力"
              : step === 2
                ? "カードを追加"
                : step === 4
                  ? "借入を入力"
                  : step === 5
                    ? "給料日を設定"
                    : step === 6
                      ? "月予算を設定"
                      : step === 7
                        ? "固定費を追加"
                        : "貯金目標を追加"}
          </button>
        )}
        {step === 0 ? (
          <>
            <button className="button button-primary full" onClick={next}>
              はじめる
              <ArrowRight size={19} />
            </button>
            <button
              className="text-button centered"
              disabled={saving}
              onClick={() => void finish()}
            >
              設定をあとで行う
            </button>
          </>
        ) : step === 10 ? (
          <button
            className="button button-primary full"
            disabled={saving}
            onClick={() => void finish()}
          >
            今日の{APP_NAME}へ<ArrowRight size={19} />
          </button>
        ) : (
          <>
            <button
              className={`button ${modes[step] ? "button-secondary" : "button-primary"} full`}
              onClick={next}
            >
              {step === 1 && finance.liquidBalance === null
                ? "あとで入力する"
                : modes[step]
                  ? "次へ・あとで入力"
                  : "次へ"}
              <ArrowRight size={19} />
            </button>
            {[2, 4, 7].includes(step) && (
              <button
                className="text-button centered"
                onClick={() =>
                  void run(async () => {
                    await updateSettings({
                      setupReviewed: [
                        ...new Set([
                          ...data.settings.setupReviewed,
                          step === 2
                            ? "cards"
                            : step === 4
                              ? "debts"
                              : "recurring",
                        ]),
                      ],
                    });
                    next();
                  })
                }
              >
                {step === 2
                  ? "カードは使っていない"
                  : step === 4
                    ? "借入はない"
                    : "固定費はない"}
              </button>
            )}
          </>
        )}
        {step > 0 && (
          <button
            className="text-button centered"
            onClick={() => setStep(step - 1)}
          >
            戻る
          </button>
        )}
      </div>
      {editor && (
        <FinanceEditor editor={editor} onClose={() => setEditor(null)} />
      )}
    </main>
  );
}
