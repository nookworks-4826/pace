import { useCallback, useMemo, useRef, useState } from "react";
import { ArrowLeft, FileSpreadsheet } from "lucide-react";
import type { AppData, Expense } from "../types";
import { db } from "../db";
import {
  createImportPreview,
  importKey,
  parseCsv,
  type ImportColumnMap,
} from "../domain/cardImport";
import { todayJST } from "../domain/dates";
import { suggestCategory } from "../domain/categorization";
import { Sheet } from "../components/UI";
import "./analytics.css";

interface CardImportProps {
  data: AppData;
  onClose: () => void;
  onImported: () => void;
  onAddCard?: () => void;
}
const yen = (amount: number) =>
  new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(
    amount,
  );

export function CardImport({
  data,
  onClose,
  onImported,
  onAddCard,
}: CardImportProps) {
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [encoding, setEncoding] = useState<"utf-8" | "shift_jis">("utf-8");
  const [rows, setRows] = useState<string[][]>([]);
  const [fileName, setFileName] = useState("");
  const [columns, setColumns] = useState<ImportColumnMap>({
    date: 0,
    amount: 1,
    merchant: 2,
  });
  const [cardId, setCardId] = useState(
    data.cards.find((card) => card.isActive)?.id ?? "",
  );
  const [error, setError] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [visible, setVisible] = useState(100);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const close = useCallback(() => {
    if (!busy.current) onClose();
  }, [onClose]);
  const preview = useMemo(
    () =>
      createImportPreview(
        rows.slice(1),
        columns,
        data.expenses,
        cardId,
        todayJST(),
      ),
    [rows, columns, data.expenses, cardId],
  );
  const chosen = preview.filter((row) => selected.has(row.line) && !row.error);
  const duplicates = preview.filter((row) => row.duplicate).length;
  const invalid = preview.filter((row) => row.error).length;
  const total = chosen.reduce((value, row) => value + row.amount, 0);
  function decode(buffer: ArrayBuffer, codec: "utf-8" | "shift_jis") {
    setError("");
    setPreviewing(false);
    setRows([]);
    setSelected(new Set());
    try {
      const parsed = parseCsv(
        new TextDecoder(codec, { fatal: true }).decode(buffer),
      );
      if (parsed.length < 2 || parsed[0].length < 3)
        throw new Error(
          "見出しと、日付・金額・店名を含む3列以上のデータが必要です。",
        );
      if (parsed.length > 20001)
        throw new Error(
          "一度に取り込めるのは20,000件までです。ファイルを分けてください。",
        );
      const findColumn = (pattern: RegExp, fallback: number) => {
        const found = parsed[0].findIndex((header) => pattern.test(header));
        return found >= 0 ? found : fallback;
      };
      setColumns({
        date: findColumn(/日付|利用日|取引日|date/i, 0),
        amount: findColumn(/利用金額|金額|amount/i, 1),
        merchant: findColumn(
          /店名|利用先|ご利用店|加盟店|merchant|description/i,
          2,
        ),
      });
      setRows(parsed);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name !== "TypeError"
          ? cause.message
          : "この文字コードでは読み込めませんでした。「Shift JIS」に切り替えてお試しください。",
      );
    }
  }
  async function readFile(file: File | undefined) {
    if (!file) return;
    setError("");
    setRows([]);
    setPreviewing(false);
    setBytes(null);
    if (file.size > 5 * 1024 * 1024) {
      setError("5MB以下のCSVを選んでください。");
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      setBytes(buffer);
      setFileName(file.name);
      decode(buffer, encoding);
    } catch {
      setError("ファイルを読み込めませんでした。もう一度選んでください。");
    }
  }
  function showPreview() {
    if (new Set(Object.values(columns)).size !== 3) {
      setError("日付・金額・店名には、それぞれ別の列を指定してください。");
      return;
    }
    if (!data.cards.some((card) => card.id === cardId && card.isActive)) {
      setError("取り込むカードを選んでください。");
      return;
    }
    setError("");
    setSelected(
      new Set(
        preview
          .filter((row) => !row.error && !row.duplicate)
          .map((row) => row.line),
      ),
    );
    setVisible(100);
    setPreviewing(true);
  }
  async function importExpenses() {
    if (busy.current || !chosen.length) return;
    busy.current = true;
    setSaving(true);
    setError("");
    try {
      const now = new Date().toISOString();
      const expenses: Expense[] = chosen.map((row) => {
        const suggestion = suggestCategory(
          row.merchant,
          data.merchantRules,
          data.categories,
        );
        const fallback =
          data.categories.find(
            (category) =>
              category.id === "uncategorized" || category.name === "未分類",
          ) ?? data.categories.at(-1);
        return {
          id: crypto.randomUUID(),
          amount: row.amount,
          date: row.date,
          merchant: row.merchant,
          description: "",
          categoryId:
            suggestion.confidence === "high"
              ? suggestion.categoryId
              : (fallback?.id ?? "uncategorized"),
          subcategoryId:
            suggestion.confidence === "high" ? suggestion.subcategoryId : "",
          paymentMethod: "creditCard",
          creditCardId: cardId,
          memo: "CSVから取り込み",
          isFixedCost: false,
          createdAt: now,
          updatedAt: now,
        };
      });
      await db.transaction("rw", db.expenses, db.cards, async () => {
        const card = await db.cards.get(cardId);
        if (!card?.isActive)
          throw new Error("取り込み先のカードを確認してください。");
        const current = await db.expenses
          .where("creditCardId")
          .equals(cardId)
          .toArray();
        const originallyKnown = new Set(
          data.expenses
            .filter(
              (item) =>
                item.creditCardId === cardId &&
                item.paymentMethod === "creditCard",
            )
            .map((item) =>
              importKey(item.date, item.amount, item.merchant, cardId),
            ),
        );
        const newlyExisting = new Set(
          current
            .map((item) =>
              importKey(item.date, item.amount, item.merchant, cardId),
            )
            .filter((key) => !originallyKnown.has(key)),
        );
        if (
          expenses.some((item) =>
            newlyExisting.has(
              importKey(item.date, item.amount, item.merchant, cardId),
            ),
          )
        )
          throw new Error(
            "プレビュー後に同じ支出が追加されました。戻って内容を確認してください。",
          );
        await db.expenses.bulkAdd(expenses);
      });
      onImported();
    } catch (cause) {
      setError(
        cause instanceof Error &&
          (cause.message.includes("カードを確認") ||
            cause.message.includes("プレビュー後"))
          ? cause.message
          : "取り込めませんでした。データは追加されていません。内容を確認してお試しください。",
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  return (
    <Sheet title="カードCSVを取り込む" onClose={close} wide>
      <div className="card-import-sheet">
        <p className="eyebrow">CARD STATEMENT</p>
        <p className="muted">
          購入した日の支出として記録し、カード未払いへ反映します。ファイルはこの端末だけで読み込みます。
        </p>
        {!data.cards.some((card) => card.isActive) ? (
          <div className="card-import-start">
            <h2>取り込むカードを登録</h2>
            <p className="hint">
              カード名を登録すると、この画面に戻って明細を選べます。
            </p>
            {onAddCard && (
              <button
                className="button button-primary full"
                onClick={onAddCard}
              >
                カードを追加して続ける
              </button>
            )}
          </div>
        ) : !previewing ? (
          <>
            <label className="card-import-file">
              <FileSpreadsheet size={22} /> 明細のCSVファイル
              <input
                type="file"
                ref={fileInput}
                accept=".csv,text/csv"
                onChange={(event) => void readFile(event.target.files?.[0])}
              />
            </label>
            <div className="card-import-fields">
              <label className="field">
                文字コード
                <select
                  value={encoding}
                  onChange={(event) => {
                    const codec = event.target.value as "utf-8" | "shift_jis";
                    setEncoding(codec);
                    if (bytes) decode(bytes, codec);
                  }}
                >
                  <option value="utf-8">UTF-8</option>
                  <option value="shift_jis">
                    Shift JIS（日本のカード明細）
                  </option>
                </select>
              </label>
              <label className="field">
                取り込むカード
                <select
                  value={cardId}
                  onChange={(event) => setCardId(event.target.value)}
                >
                  <option value="" disabled>
                    カードを選択
                  </option>
                  {data.cards
                    .filter((card) => card.isActive)
                    .map((card) => (
                      <option key={card.id} value={card.id}>
                        {card.name}
                        {card.last4 ? ` · ${card.last4}` : ""}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            {!data.cards.some((card) => card.isActive) && (
              <p className="card-import-warning">
                先にカード画面でカードを追加してください。
              </p>
            )}
            {rows.length > 1 && (
              <>
                <p className="muted">
                  {fileName} · {rows.length - 1}行<br />
                  1行目を見出しとして、それぞれの列を指定してください。
                </p>
                <div className="card-import-mapping">
                  {(["date", "amount", "merchant"] as const).map((key) => (
                    <label className="field" key={key}>
                      {key === "date"
                        ? "日付"
                        : key === "amount"
                          ? "金額"
                          : "店名"}
                      <select
                        value={columns[key]}
                        onChange={(event) =>
                          setColumns((previous) => ({
                            ...previous,
                            [key]: Number(event.target.value),
                          }))
                        }
                      >
                        {rows[0].map((header, index) => (
                          <option key={index} value={index}>
                            {index + 1}. {header || "見出しなし"}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <p className="card-import-info">
                  例：{rows[1]?.[columns.date] ?? "—"} /{" "}
                  {rows[1]?.[columns.merchant] ?? "—"} /{" "}
                  {rows[1]?.[columns.amount] ?? "—"}
                </p>
              </>
            )}
            <p className="card-import-info">
              日付は「2026/9/24」など西暦で指定します。返金・取消・分割手数料の個別処理には対応していません。現在の未払い残高に含めて登録済みの利用は取り込むと重複するため、開始残高に含まれない明細を選んでください。
            </p>
          </>
        ) : (
          <>
            <button
              className="button button-secondary"
              onClick={() => {
                setPreviewing(false);
                setError("");
              }}
              disabled={saving}
            >
              <ArrowLeft size={16} />
              列の指定に戻る
            </button>
            <p className="card-import-info">
              {preview.length}件中 {invalid}件は読込対象外。重複候補{" "}
              {duplicates}
              件は最初から選択を外しています。同じ日・金額・店名・カードで判定しています。
            </p>
            {duplicates > 0 && (
              <p className="card-import-warning">
                重複候補でも、別の利用であることを確認した行は選択して追加できます。
              </p>
            )}
            <div className="card-import-selection">
              <strong>
                {chosen.length}件を選択 · {yen(total)}
              </strong>
              <button
                className="button button-secondary"
                disabled={saving}
                onClick={() =>
                  setSelected(
                    selected.size
                      ? new Set()
                      : new Set(
                          preview
                            .filter((row) => !row.error && !row.duplicate)
                            .map((row) => row.line),
                        ),
                  )
                }
              >
                {selected.size ? "選択を解除" : "通常の行を選択"}
              </button>
            </div>
            <div className="card-import-preview">
              {preview.slice(0, visible).map((row) => (
                <label
                  className={`card-import-row ${row.error ? "has-error" : ""}`}
                  key={row.line}
                >
                  <input
                    type="checkbox"
                    aria-label={`${row.line}行目 ${row.merchant} ${yen(row.amount)}${row.duplicate ? " 重複候補" : ""}`}
                    disabled={saving || Boolean(row.error)}
                    checked={selected.has(row.line) && !row.error}
                    onChange={(event) =>
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (event.target.checked) next.add(row.line);
                        else next.delete(row.line);
                        return next;
                      })
                    }
                  />
                  <div>
                    <strong>{row.merchant || "店名なし"}</strong>
                    <small>
                      {row.date.replaceAll("-", "/")} · {row.line}行目
                      {row.duplicate ? " · 重複の可能性" : ""}
                      {row.error ? ` · ${row.error}` : ""}
                    </small>
                  </div>
                  <b>{row.amount ? yen(row.amount) : "—"}</b>
                </label>
              ))}
            </div>
            {visible < preview.length && (
              <button
                className="button button-secondary"
                onClick={() => setVisible((value) => value + 100)}
              >
                次の100件を表示（残り{preview.length - visible}件）
              </button>
            )}
          </>
        )}
        {error && (
          <p className="card-import-error" role="alert">
            {error}
          </p>
        )}
        <footer className="card-import-footer">
          {previewing ? (
            <>
              <button
                className="button button-primary"
                disabled={saving || !chosen.length}
                onClick={() => void importExpenses()}
              >
                {saving
                  ? "取り込み中…"
                  : `${chosen.length}件 · ${yen(total)}を取り込む`}
              </button>
              <p>
                確認した支出をまとめて追加します。修正・削除は履歴からできます。
              </p>
            </>
          ) : (
            <button
              className="button button-primary"
              disabled={rows.length < 2 || !cardId}
              onClick={showPreview}
            >
              内容をプレビュー
            </button>
          )}
        </footer>
      </div>
    </Sheet>
  );
}
export default CardImport;
