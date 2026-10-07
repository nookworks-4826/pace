import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { liveQuery } from "dexie";
import { ArrowLeft } from "lucide-react";
import { usePace } from "../app/context";
import {
  AsyncForm,
  Field,
  Sheet,
  stamp,
  textValue,
  yen,
} from "../components/UI";
import { db, saveExpense, updateSettings } from "../db";
import { payableAccounts } from "../domain/personalization";
import {
  recentChanges,
  undoChange,
  withUndo,
  type RecentChange,
} from "../domain/undo";
import { APP_VERSION, type Favorite, type Expense } from "../types";

export function IncomeDraft() {
  const { data, today, toast } = usePace(),
    [input, setInput] = useState<{
      amount: number;
      sourceAccountId: string;
    } | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (
        detail &&
        Number.isSafeInteger(detail.amount) &&
        detail.amount > 0 &&
        typeof detail.sourceAccountId === "string"
      )
        setInput(detail);
    };
    window.addEventListener("pace-income-draft", handler);
    return () => window.removeEventListener("pace-income-draft", handler);
  }, []);
  if (!input) return null;
  return (
    <Sheet title="差額を収入として記録" onClose={() => setInput(null)}>
      <AsyncForm
        label="収入を記録"
        onSubmit={async (f) => {
          const account = await db.accounts.get(input.sourceAccountId);
          if (
            !account?.isActive ||
            account.archivedAt ||
            account.kind === "CREDIT_CARD"
          )
            throw new Error("入金先を確認してください。");
          const undo = await withUndo("差額を収入として記録", async () => {
            await db.incomes.add({
              ...stamp(),
              amount: input.amount,
              date: today,
              source: textValue(f, "source") || "残高確認時の収入",
              memo: "残高確認の差額を本人が収入として登録",
              type: "other",
              sourceAccountId: account.id,
              balanceEffect: "ledger",
            });
          });
          setInput(null);
          toast("収入を記録しました", () => undoChange(undo.id));
        }}
      >
        <p>
          {data.accounts?.find((a) => a.id === input.sourceAccountId)?.name} ·{" "}
          {yen(input.amount)}
        </p>
        <Field label="入金の内容（任意）">
          <input name="source" maxLength={120} placeholder="入金・返金など" />
        </Field>
      </AsyncForm>
    </Sheet>
  );
}

export function ExpenseInboxPage() {
  const { data, openExpense, run, toast } = usePace();
  const [selected, setSelected] = useState<string[]>([]),
    [category, setCategory] = useState("uncategorized");
  const [rows, setRows] = useState<Expense[]>([]);
  const [total, setTotal] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  useEffect(() => {
    // Use the Inbox primary-key index and fetch only this page's financial rows.
    const subscription = liveQuery(() =>
      db.transaction("r", db.expenseInbox, db.expenses, async () => {
        const total = await db.expenseInbox.count();
        const queue = await db.expenseInbox.orderBy(":id").limit(100).toArray();
        const expenses = await db.expenses.bulkGet(
          queue.map((x) => x.expenseId),
        );
        if (expenses.some((x) => !x))
          throw new Error("未整理の参照を確認できません。");
        return {
          total,
          rows: (expenses as Expense[]).sort(
            (a, b) =>
              b.date.localeCompare(a.date) ||
              b.createdAt.localeCompare(a.createdAt),
          ),
        };
      }),
    ).subscribe({
      next: (value) => {
        setTotal(value.total);
        setRows(value.rows);
        setLoadState("ready");
      },
      error: () => {
        setLoadState("failed");
        toast("未整理の記録を読み込めませんでした。履歴から確認できます。");
      },
    });
    return () => subscription.unsubscribe();
  }, []);
  async function finish(classify: boolean) {
    const undo = await withUndo("あとで整理を確認", async () => {
      for (const id of selected) {
        const expense = await db.expenses.get(id);
        if (!expense)
          throw new Error("記録が変わりました。開き直してください。");
        await saveExpense({
          ...expense,
          categoryId: classify ? category : expense.categoryId,
          subcategoryId: classify ? "" : expense.subcategoryId,
          reviewed: true,
          ocrNeedsReview: false,
          paymentNeedsReview: false,
          updatedAt: new Date().toISOString(),
        });
      }
    });
    setSelected([]);
    toast("確認済みにしました", () => undoChange(undo.id));
  }
  return (
    <div className="page">
      <header className="page-header">
        <Link className="icon-button" to="/" aria-label="ホームへ戻る">
          <ArrowLeft />
        </Link>
        <h1>
          あとで整理 <small>{total}件</small>
        </h1>
      </header>
      <p className="hint">
        金額と支払元は残高に反映済みです。店名・分類・読み取り結果を確認できます。
      </p>
      {loadState === "loading" && (
        <p className="hint">記録を確認しています。</p>
      )}
      {loadState === "failed" && (
        <p className="hint">
          読み込みに失敗しました。履歴から記録を確認してください。
        </p>
      )}
      {rows.length > 0 && (
        <section className="surface">
          <div className="chips">
            <button
              className="chip"
              onClick={() => setSelected(rows.slice(0, 100).map((x) => x.id))}
            >
              100件まで選ぶ
            </button>
            <button className="chip" onClick={() => setSelected([])}>
              選択を解除
            </button>
          </div>
          <Field label="まとめて分類">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {data.categories
                .filter((c) => !c.archived)
                .map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </Field>
          <div className="button-row">
            <button
              className="button button-secondary"
              disabled={!selected.length || category === "uncategorized"}
              onClick={() => void run(() => finish(true))}
            >
              分類して確認済み
            </button>
            <button
              className="button button-secondary"
              disabled={!selected.length}
              onClick={() => void run(() => finish(false))}
            >
              この内容で確認済み
            </button>
          </div>
        </section>
      )}
      {rows.slice(0, 100).map((e) => (
        <section className="surface" key={e.id}>
          <label className="check-field">
            <input
              type="checkbox"
              checked={selected.includes(e.id)}
              onChange={(event) =>
                setSelected(
                  event.target.checked
                    ? [...selected, e.id]
                    : selected.filter((id) => id !== e.id),
                )
              }
            />
            <b>
              {e.merchant} · {yen(e.amount)}
            </b>
          </label>
          <p className="hint">
            {e.date} ·{" "}
            {data.accounts?.find((a) => a.id === e.sourceAccountId)?.name ??
              "支払方法を確認"}{" "}
            · {data.categories.find((c) => c.id === e.categoryId)?.name}
          </p>
          <button className="text-button" onClick={() => openExpense(e)}>
            店名・分類を編集
          </button>
        </section>
      ))}
      {loadState === "ready" && !rows.length && (
        <p className="empty-state">整理する記録はありません。</p>
      )}
      {total > 100 && (
        <p className="hint">
          100件ずつ表示します。確認すると次の記録を表示します。
        </p>
      )}
    </div>
  );
}
export function RecentChangesPage() {
  const { run, toast } = usePace(),
    [rows, setRows] = useState<RecentChange[]>([]),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const sub = liveQuery(() => recentChanges()).subscribe({
      next: setRows,
      error: () => toast("変更の記録を読み込めませんでした。"),
    });
    return () => sub.unsubscribe();
  }, []);
  return (
    <div className="page">
      <header className="page-header">
        <Link className="icon-button" to="/settings" aria-label="設定へ戻る">
          <ArrowLeft />
        </Link>
        <h1>最近の変更</h1>
      </header>
      <p className="hint">
        直近20件。記録が後から変わった操作は上書きしません。
      </p>
      {rows.map((row) => (
        <section className="surface" key={row.id}>
          <b>{row.label}</b>
          <p className="hint">
            {new Date(row.createdAt).toLocaleString("ja-JP")} ·{" "}
            {row.undone ? "取消済み" : ""}
          </p>
          <button
            className="button button-secondary"
            disabled={row.undone || busy}
            onClick={() => {
              setBusy(true);
              void run(async () => {
                await undoChange(row.id);
                toast("元に戻しました");
              }).finally(() => setBusy(false));
            }}
          >
            元に戻す
          </button>
        </section>
      ))}
      {!rows.length && <p className="empty-state">最近の変更はありません。</p>}
    </div>
  );
}
export function FavoriteEditor({
  favorite,
  onClose,
}: {
  favorite?: Favorite;
  onClose: () => void;
}) {
  const { data, toast } = usePace();
  const accounts = payableAccounts(data);
  return (
    <Sheet
      title={favorite ? "お気に入りを編集" : "お気に入りを追加"}
      onClose={onClose}
    >
      <AsyncForm
        label="お気に入りを保存"
        onSubmit={async (f) => {
          const amount = Number(f.get("amount") || 0);
          if (
            !Number.isSafeInteger(amount) ||
            amount < 0 ||
            amount > 999999999999
          )
            throw new Error("金額を確認してください。");
          const source = accounts.find((a) => a.id === f.get("source"));
          const row: Favorite = {
            id: favorite?.id ?? crypto.randomUUID(),
            name: textValue(f, "name"),
            amount,
            merchant: textValue(f, "merchant"),
            memo: textValue(f, "memo"),
            categoryId: textValue(f, "category"),
            subcategoryId: "",
            paymentMethod: source
              ? source.kind === "CREDIT_CARD"
                ? "creditCard"
                : source.kind === "CASH"
                  ? "cash"
                  : source.kind === "BANK"
                    ? "bank"
                    : "other"
              : (favorite?.paymentMethod ?? "cash"),
            sourceAccountId: source?.id,
            creditCardId: source?.creditCardId,
            paymentChannel: "direct",
          };
          if (!row.name) throw new Error("名前を入力してください。");
          await db.favorites.put(row);
          onClose();
          toast("お気に入りを保存しました");
        }}
      >
        <Field label="名前">
          <input
            name="name"
            required
            maxLength={80}
            defaultValue={favorite?.name}
          />
        </Field>
        <Field label="金額（任意）">
          <input
            name="amount"
            inputMode="numeric"
            type="number"
            min="0"
            max="999999999999"
            defaultValue={favorite?.amount || undefined}
          />
        </Field>
        <Field label="支払元（任意）">
          <select name="source" defaultValue={favorite?.sourceAccountId ?? ""}>
            <option value="">入力するときに選ぶ</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="カテゴリー">
          <select
            name="category"
            defaultValue={favorite?.categoryId ?? "uncategorized"}
          >
            {data.categories
              .filter((c) => !c.archived)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="店名（任意）">
          <input
            name="merchant"
            maxLength={120}
            defaultValue={favorite?.merchant}
          />
        </Field>
        <Field label="メモ（任意）">
          <textarea
            name="memo"
            maxLength={1000}
            defaultValue={favorite?.memo}
          />
        </Field>
      </AsyncForm>
    </Sheet>
  );
}
export function PracticalWelcome() {
  const { data, run } = usePace(),
    [skipped, setSkipped] = useState(false);
  if (
    skipped ||
    !data.settings.onboardingCompleted ||
    data.settings.practical?.welcomedVersion === APP_VERSION
  )
    return null;
  return (
    <section className="surface" aria-label="更新のお知らせ">
      <h2>Paceを更新しました</h2>
      <p>記録を引き継ぎました。前回の入力や「あとで整理」が使えます。</p>
      <p className="hint">
        更新前の暗号化バックアップを残しておくことをおすすめします。
      </p>
      <div className="button-row">
        <button
          className="button button-primary"
          onClick={() => {
            setSkipped(true);
            void run(() =>
              updateSettings({
                practical: {
                  ...data.settings.practical,
                  welcomedVersion: APP_VERSION,
                },
              }),
            );
          }}
        >
          使い始める
        </button>
        <Link className="button button-secondary" to="/settings?panel=data">
          バックアップを確認
        </Link>
        <button
          className="text-button"
          onClick={() => {
            setSkipped(true);
            void run(() =>
              updateSettings({
                practical: {
                  ...data.settings.practical,
                  welcomedVersion: APP_VERSION,
                },
              }),
            );
          }}
        >
          あとで
        </button>
      </div>
    </section>
  );
}
