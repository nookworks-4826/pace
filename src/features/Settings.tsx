import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { saveAs } from "file-saver";
import {
  Bookmark,
  CalendarClock,
  CalendarDays,
  ChevronRight,
  CreditCard,
  Database,
  Download,
  FileSpreadsheet,
  Fingerprint,
  HelpCircle,
  Landmark,
  Palette,
  Receipt,
  ShieldCheck,
  Target,
  Trash2,
  Upload,
  Wallet,
  Tags,
  Plus,
  RefreshCw,
} from "lucide-react";
import { usePace } from "../app/context";
import { AsyncForm, Field, Sheet, textValue, yen } from "../components/UI";
import { clearAllData, db, restoreAppData, updateSettings } from "../db";
import {
  buildCSV,
  buildExcel,
  createBackup,
  encryptBackup,
  parseBackup,
} from "../domain/backup";
import { disableLock } from "../domain/security";
import { APP_NAME, APP_VERSION } from "../types";
import type { AppData, Category } from "../types";
import { FinanceEditor } from "./Management";
import type { Editor } from "./Management";
import { SecuritySettings } from "./Security";

export function Settings() {
  const { data, today, run, toast, appUpdate } = usePace();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [panel, setPanel] = useState("");
  const [ready, setReady] = useState<{ blob: Blob; name: string } | null>(null);
  const [restoring, setRestoring] = useState<AppData | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<Category | null>(null);
  const [categoryEditor, setCategoryEditor] = useState(false);
  const [deleteStep, setDeleteStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const exportFile = async (type: "json" | "csv" | "excel") => {
    setBusy(true);
    await run(async () => {
      const blob =
        type === "excel"
          ? await buildExcel(data)
          : new Blob([type === "csv" ? buildCSV(data) : createBackup(data)], {
              type:
                type === "csv" ? "text/csv;charset=utf-8" : "application/json",
            });
      setReady({
        blob,
        name: `pace-${today}${type === "json" ? "-backup.json" : type === "csv" ? ".csv" : ".xlsx"}`,
      });
    }, "ファイルを用意しました。保存ボタンから保存できます");
    setBusy(false);
  };
  const row = (
    icon: ReactNode,
    label: string,
    action: () => void,
    note?: string,
  ) => (
    <button className="settings-row" onClick={action}>
      <span className="settings-icon">{icon}</span>
      <span>
        <b>{label}</b>
        {note && <small>{note}</small>}
      </span>
      <ChevronRight size={17} />
    </button>
  );
  const link = (icon: ReactNode, label: string, url: string) => (
    <Link className="settings-row" to={url}>
      <span className="settings-icon">{icon}</span>
      <b>{label}</b>
      <ChevronRight size={17} />
    </Link>
  );
  return (
    <div className="page settings-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">MAKE IT YOURS</span>
          <h1>設定</h1>
        </div>
      </header>
      <div className="privacy-card">
        <ShieldCheck size={24} />
        <div>
          <b>お金の情報は、暗号化した保管庫に。</b>
          <p>
            {data.financialConnections?.some((c) => c.status === "connected")
              ? "許可した金融連携だけを使用します。"
              : "金融連携は任意。広告・解析はありません。"}
          </p>
        </div>
      </div>
      <h2 className="settings-label">お金の設定</h2>
      <div className="surface settings-group">
        {link(<Wallet />, "銀行・現金・電子マネー", "/money")}
        {link(<ShieldCheck />, "金融連携・通知・プライバシー", "/financial")}
        {row(<Wallet />, "残高を合わせる", () =>
          setEditor({ mode: "balance" }),
        )}
        {link(<CreditCard />, "カード", "/manage/cards")}
        {link(<Landmark />, "借入と返済", "/manage/debts")}
        {link(<Target />, "貯金目標", "/manage/savings")}
        {link(<CalendarClock />, "固定費・サブスク", "/manage/recurring")}
        {link(<Receipt />, "収入", "/manage/incomes")}
        {row(<CalendarDays />, "給料日の予定", () =>
          setEditor({ mode: "salary" }),
        )}
        {row(<Target />, "月の予算", () => setEditor({ mode: "budget" }))}
        {link(<CalendarDays />, "お金のタイムライン", "/timeline")}
      </div>
      <h2 className="settings-label">入力と表示</h2>
      <div className="surface settings-group">
        {row(<Tags />, "カテゴリー", () => setPanel("categories"))}
        {row(<Bookmark />, "お気に入り", () => setPanel("favorites"))}
        {row(<Palette />, "テーマと表示", () => setPanel("theme"))}
        {row(<Fingerprint />, "アプリロック", () => setPanel("security"))}
        {row(
          <HelpCircle />,
          "初回ヒントをもう一度見る",
          () =>
            void run(
              () => updateSettings({ helpDismissed: false }),
              "ホームにヒントを再表示します",
            ),
        )}
      </div>
      <h2 className="settings-label">データ管理</h2>
      <div className="surface settings-group">
        {row(
          <Database />,
          "バックアップと書き出し",
          () => {
            setPanel("data");
            setReady(null);
          },
          data.settings.lastBackupAt
            ? `前回作成：${data.settings.lastBackupAt.slice(0, 10)}`
            : "バックアップはまだありません",
        )}
        {row(<Upload />, "バックアップを復元", () => {
          setPanel("restore");
          setRestoring(null);
          setFile(null);
        })}
        {row(<Trash2 />, "全データを削除", () => {
          setPanel("delete");
          setDeleteStep(0);
        })}
        {row(<HelpCircle />, `${APP_NAME}について`, () => setPanel("about"))}
      </div>
      <h2 className="settings-label">アプリの更新</h2>
      <div className="surface settings-group">
        <button
          className="settings-row"
          disabled={appUpdate.busy}
          onClick={() =>
            void (appUpdate.available
              ? appUpdate.apply().then((message) => {
                  if (message) toast(message);
                })
              : appUpdate.check())
          }
        >
          <span className="settings-icon">
            <RefreshCw className={appUpdate.busy ? "spin" : ""} />
          </span>
          <span>
            <b>
              {appUpdate.busy
                ? "処理しています…"
                : appUpdate.available
                  ? "更新を適用"
                  : "更新を確認"}
            </b>
            <small>現在のバージョン {APP_VERSION}</small>
          </span>
          <ChevronRight size={17} />
        </button>
      </div>
      <p className="page-footnote" role="status">
        {appUpdate.message}
      </p>
      <p className="page-footnote">
        {APP_NAME} {APP_VERSION} · 自分のペースで、お金を整える。
      </p>
      {panel && (
        <Sheet
          title={
            (
              {
                theme: "テーマと表示",
                security: "アプリロック",
                data: "バックアップと書き出し",
                restore: "バックアップを復元",
                delete: "全データを削除",
                about: `${APP_NAME}について`,
                categories: "カテゴリー",
                favorites: "お気に入り",
              } as Record<string, string>
            )[panel] ?? panel
          }
          onClose={() => setPanel("")}
        >
          {panel === "theme" && (
            <>
              <Field label="カラーモード">
                <select
                  value={data.settings.colorMode}
                  onChange={(e) =>
                    void run(() =>
                      updateSettings({
                        colorMode: e.target
                          .value as AppData["settings"]["colorMode"],
                      }),
                    )
                  }
                >
                  <option value="system">システムに合わせる</option>
                  <option value="light">ライト</option>
                  <option value="dark">ダーク</option>
                </select>
              </Field>
              <div className="theme-picker">
                {(["default", "midnight", "forest", "mono"] as const).map(
                  (t) => (
                    <button
                      key={t}
                      data-swatch={t}
                      className={data.settings.theme === t ? "selected" : ""}
                      onClick={() =>
                        void run(() => updateSettings({ theme: t }))
                      }
                    >
                      <span />
                      {
                        {
                          default: "サニー",
                          midnight: "スカイ",
                          forest: "ミント",
                          mono: "ニュートラル",
                        }[t]
                      }
                    </button>
                  ),
                )}
              </div>
            </>
          )}
          {panel === "security" && <SecuritySettings />}
          {panel === "data" && (
            <>
              <p className="note-panel">
                端末内保存のため、ブラウザデータ削除で失われる可能性があります。定期的なバックアップをおすすめします。
              </p>
              <div className="data-actions">
                <button
                  disabled={busy}
                  className="button button-secondary"
                  onClick={() => void exportFile("json")}
                >
                  <Download size={19} />
                  JSONバックアップを作成
                </button>
                <button
                  disabled={busy}
                  className="button button-secondary"
                  onClick={() => void exportFile("csv")}
                >
                  <FileSpreadsheet size={19} />
                  CSVを作成
                </button>
                <button
                  disabled={busy}
                  className="button button-secondary"
                  onClick={() => void exportFile("excel")}
                >
                  <FileSpreadsheet size={19} />
                  Excelを作成
                </button>
              </div>
              <details>
                <summary>暗号化バックアップを作成</summary>
                <AsyncForm
                  label="暗号化ファイルを作成"
                  onSubmit={async (f) => {
                    const password = String(f.get("password") ?? "");
                    if (password !== String(f.get("confirm") ?? ""))
                      throw new Error("パスワードが一致しません。");
                    setReady({
                      blob: new Blob([await encryptBackup(data, password)], {
                        type: "application/octet-stream",
                      }),
                      name: `pace-${today}.pacebackup`,
                    });
                    toast("暗号化しました。保存ボタンから保存できます");
                  }}
                >
                  <Field label="パスワード（8文字以上）">
                    <input
                      name="password"
                      type="password"
                      minLength={8}
                      maxLength={1024}
                      autoComplete="new-password"
                      required
                    />
                  </Field>
                  <Field label="もう一度入力">
                    <input
                      name="confirm"
                      type="password"
                      minLength={8}
                      maxLength={1024}
                      autoComplete="new-password"
                      required
                    />
                  </Field>
                  <p className="hint">
                    パスワードは保存しません。忘れると復元できません。PINとは別のパスワードをおすすめします。
                  </p>
                </AsyncForm>
              </details>
              {ready && (
                <div className="download-ready">
                  <b>保存の準備ができました</b>
                  <small>{ready.name}</small>
                  <button
                    className="button button-primary full"
                    onClick={() => {
                      saveAs(ready.blob, ready.name);
                      if (
                        ready.name.endsWith(".json") ||
                        ready.name.endsWith(".pacebackup")
                      )
                        void run(() =>
                          updateSettings({
                            lastBackupAt: new Date().toISOString(),
                          }),
                        );
                    }}
                  >
                    <Download size={18} />
                    ファイルを保存
                  </button>
                  <p className="hint">
                    iPhoneで開いた場合は、共有から「ファイルに保存」を選んでください。保存先にファイルがあることをご確認ください。
                  </p>
                </div>
              )}
              <p className="hint">
                iPadへ移す場合：バックアップを作成 → AirDropやファイルで移す →
                iPadで復元。自動同期はしません。
              </p>
            </>
          )}
          {panel === "restore" && (
            <>
              {!restoring ? (
                <AsyncForm
                  label="内容を確認"
                  onSubmit={async (f) => {
                    if (!file)
                      throw new Error("バックアップファイルを選んでください。");
                    if (file.size > 50 * 1024 * 1024)
                      throw new Error("50MB以下のファイルを選んでください。");
                    setRestoring(
                      await parseBackup(
                        await file.text(),
                        String(f.get("password") ?? "") || undefined,
                      ),
                    );
                  }}
                >
                  <Field label="バックアップファイル">
                    <input
                      type="file"
                      accept=".json,.pacebackup,application/json,application/octet-stream"
                      required
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    />
                  </Field>
                  <Field label="暗号化パスワード（暗号化した場合）">
                    <input
                      name="password"
                      type="password"
                      maxLength={1024}
                      autoComplete="off"
                    />
                  </Field>
                  <p className="hint">
                    復元前に内容を検証します。検証に失敗しても現在のデータは変わりません。
                  </p>
                </AsyncForm>
              ) : (
                <AsyncForm
                  label="確認した内容で置き換える"
                  onSubmit={async () => {
                    if (
                      !confirm(
                        "現在の全データをこのバックアップで置き換えます。現在のデータをバックアップ済みですか？",
                      )
                    )
                      return;
                    await restoreAppData({
                      ...restoring,
                      settings: {
                        ...restoring.settings,
                        onboardingCompleted: true,
                      },
                    });
                    setPanel("");
                    toast("バックアップを復元しました");
                  }}
                >
                  <div className="restore-summary">
                    <h3>復元する内容</h3>
                    <p>
                      支出 {restoring.expenses.length}件 · 収入{" "}
                      {restoring.incomes.length}件
                    </p>
                    <p>
                      カード {restoring.cards.length}件 · 借入{" "}
                      {restoring.debts.length}件
                    </p>
                    <p>
                      固定費 {restoring.recurringExpenses.length}件 · 貯金目標{" "}
                      {restoring.savingsGoals.length}件
                    </p>
                  </div>
                  <p className="notice">
                    現在のデータは置き換わります。必要であれば先にバックアップしてください。この端末のロック設定は維持します。
                  </p>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => {
                      setPanel("data");
                      setReady(null);
                    }}
                  >
                    先に現在のデータをバックアップ
                  </button>
                </AsyncForm>
              )}
            </>
          )}
          {panel === "delete" && (
            <>
              <p className="notice">
                支出・収入・予定・家計設定など、この端末のデータを削除します。削除後は元に戻せません。暗号化保管庫とパスフレーズは維持します。金融サービス側の認可も取り消す場合は、先に「連携とプライバシー」で解除してください。
              </p>
              <button
                className="button button-secondary full"
                onClick={() => setPanel("data")}
              >
                先にバックアップする
              </button>
              {deleteStep === 0 ? (
                <button
                  className="button button-danger full"
                  onClick={() => setDeleteStep(1)}
                >
                  全データ削除に進む
                </button>
              ) : (
                <AsyncForm
                  label="全データを削除する"
                  onSubmit={async (f) => {
                    if (textValue(f, "confirm") !== "削除")
                      throw new Error("「削除」と入力してください。");
                    await clearAllData();
                    disableLock();
                    window.dispatchEvent(new Event("pace-lock-changed"));
                    setPanel("");
                    toast("この端末のデータを削除しました");
                  }}
                >
                  <Field label="最終確認：「削除」と入力">
                    <input name="confirm" autoComplete="off" required />
                  </Field>
                </AsyncForm>
              )}
            </>
          )}
          {panel === "about" && (
            <div className="about-content">
              <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
              <h2>{APP_NAME}</h2>
              <p>今使っていい金額を、いつでも。</p>
              <p>
                カードの未払い、固定費、返済、貯金の予定を見えるようにして、自分のお金のペースを確かめるアプリです。
              </p>
              <h3>端末内で暗号化して保存</h3>
              <p>
                家計記録・レシート・連携の認証情報は暗号化したIndexedDBに保存します。本人が金融連携を許可した場合だけ、Moneytreeの公式APIで口座・残高・明細を取得します。レシートの外部送信、広告、アクセス解析、家計データの端末間自動同期はありません。
              </p>
              <h3>バックアップについて</h3>
              <p>
                端末内保存のため、ブラウザデータ削除で失われる可能性があります。定期バックアップをおすすめします。機種変更前にも書き出してください。
              </p>
              <h3>ホーム画面に追加</h3>
              <p>
                iPhoneのSafariで開き、共有
                →「ホーム画面に追加」→「追加」。初回の読み込み後は、電波がなくても記録できます。
              </p>
              <p>
                GalaxyのChromeではメニュー
                →「ホーム画面に追加」または「アプリをインストール」を選びます。表示名はブラウザによって異なります。
              </p>
              <h3>指紋・顔認証</h3>
              <p>
                Galaxyの指紋認証やiPhoneのFace ID・Touch
                IDに対応するデバイス認証を、設定の「アプリロック」から登録できます。利用できる方法は端末とブラウザによって異なります。
              </p>
              <h3>金額の考え方</h3>
              <p>
                今使っていい金額は入力済み情報からの計算です。未入力のカード・固定費等は差し引けません。予想給与は残高に加えません。
              </p>
              <small>Version {APP_VERSION}</small>
            </div>
          )}
          {panel === "categories" && (
            <>
              <p className="hint">
                名前や内訳を編集できます。利用済みカテゴリーは削除せず非表示にします。
              </p>
              {data.categories.map((c) => (
                <div className="list-row" key={c.id}>
                  <button
                    className="text-button"
                    onClick={() => {
                      setCategory(c);
                      setCategoryEditor(true);
                    }}
                  >
                    <span
                      className="color-dot"
                      style={{ background: c.color }}
                    />
                    {c.name}
                    {c.archived ? " · 非表示" : ""}
                  </button>
                  {c.id !== "uncategorized" && (
                    <button
                      className="icon-button"
                      aria-label={c.archived ? "表示する" : "非表示にする"}
                      onClick={() =>
                        void run(async () => {
                          await db.categories.update(c.id, {
                            archived: !c.archived,
                          });
                        })
                      }
                    >
                      <Tags size={17} />
                    </button>
                  )}
                </div>
              ))}
              <button
                className="button button-secondary full"
                onClick={() => {
                  setCategory(null);
                  setCategoryEditor(true);
                }}
              >
                <Plus size={17} />
                カテゴリーを追加
              </button>
              <button
                className="text-button"
                onClick={() => {
                  if (
                    confirm(
                      "店名から学習した分類をリセットしますか？ 支出のカテゴリーは変わりません。",
                    )
                  )
                    void run(
                      () => db.merchantRules.clear(),
                      "学習した分類をリセットしました",
                    );
                }}
              >
                学習した分類をリセット
              </button>
            </>
          )}
          {panel === "favorites" && (
            <>
              {data.favorites.length === 0 ? (
                <p className="empty-state">
                  支出入力の「メモ・お気に入り」から追加できます。
                </p>
              ) : (
                data.favorites.map((f) => (
                  <div className="list-row" key={f.id}>
                    <div>
                      <b>{f.name}</b>
                      <small>{yen(f.amount)}</small>
                    </div>
                    <button
                      className="icon-button"
                      aria-label={`${f.name}をお気に入りから削除`}
                      onClick={() =>
                        void run(async () => {
                          await db.favorites.delete(f.id);
                          toast("お気に入りを削除しました", async () => {
                            await db.favorites.put(f);
                          });
                        })
                      }
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                ))
              )}
            </>
          )}
        </Sheet>
      )}
      {categoryEditor && (
        <Sheet
          title={category ? "カテゴリーを編集" : "カテゴリーを追加"}
          onClose={() => setCategoryEditor(false)}
        >
          <AsyncForm
            onSubmit={async (f) => {
              const names = textValue(f, "subs")
                .split(/[、,\n]/)
                .map((s) => s.trim())
                .filter(Boolean);
              if (new Set(names).size !== names.length)
                throw new Error("内訳の名前が重複しています。");
              const subs = names.map((name, i) => ({
                id: category?.subcategories[i]?.id ?? crypto.randomUUID(),
                name,
              }));
              if (
                category?.subcategories.some(
                  (sub) =>
                    !subs.some((s) => s.id === sub.id) &&
                    [
                      ...data.expenses,
                      ...data.recurringExpenses,
                      ...data.favorites,
                      ...data.merchantRules,
                    ].some(
                      (e) =>
                        e.categoryId === category.id &&
                        e.subcategoryId === sub.id,
                    ),
                )
              )
                throw new Error(
                  "使われている内訳は削除できません。名前の変更はできます。",
                );
              await db.categories.put({
                id: category?.id ?? crypto.randomUUID(),
                name: textValue(f, "name"),
                color: textValue(f, "color"),
                icon: category?.icon ?? "CircleEllipsis",
                subcategories: subs,
                archived: category?.archived ?? false,
              });
              setCategoryEditor(false);
              toast("カテゴリーを保存しました");
            }}
          >
            <Field label="カテゴリー名">
              <input
                name="name"
                maxLength={40}
                required
                defaultValue={category?.name}
              />
            </Field>
            <Field label="色">
              <input
                name="color"
                type="color"
                defaultValue={category?.color ?? "#577CAE"}
              />
            </Field>
            <Field
              label="内訳（1行に1つ）"
              hint="使用済みの内訳を並べ替えると名称が変わります。並び順は保持してください。"
            >
              <textarea
                name="subs"
                rows={7}
                defaultValue={category?.subcategories
                  .map((s) => s.name)
                  .join("\n")}
              />
            </Field>
          </AsyncForm>
        </Sheet>
      )}
      {editor && (
        <FinanceEditor editor={editor} onClose={() => setEditor(null)} />
      )}
    </div>
  );
}
