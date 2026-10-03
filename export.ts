import { APP_NAME, paymentLabels, type AppData } from "../../types";
import { monthKey, monthEnd, todayJST } from "../dates";
import { calculateCardOutstanding, calculateRefundTotal } from "../finance";
import { calculateAccountBalance } from "../accounts";

type Cell = string | number;
function accountName(data: AppData, accountId?: string): string {
  return data.accounts?.find((row) => row.id === accountId)?.name ?? "";
}
function exportSource(row: {
  providerId?: string;
  externalTransactionId?: string;
  receiptId?: string;
}): string {
  return row.providerId === "moneytree"
    ? "Moneytree"
    : row.providerId === "mock"
      ? "検証データ"
      : row.receiptId
        ? "レシート"
        : "手入力";
}
function sourceColumns(
  data: AppData,
  row: {
    sourceAccountId?: string;
    providerId?: string;
    externalTransactionId?: string;
    receiptId?: string;
  },
  type: string,
): Cell[] {
  return [
    accountName(data, row.sourceAccountId),
    exportSource(row),
    type,
    row.externalTransactionId ? "External" : "Manual",
  ];
}
// Text cells are prefixed before CSV quoting: spreadsheet formulas must never execute.
function csvCell(value: Cell): string {
  let string = String(value);
  if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+@-]/.test(string))
    string = `'${string}`;
  return `"${string.replaceAll('"', '""')}"`;
}
function expenseRows(data: AppData): Cell[][] {
  return [...data.expenses]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((row) => {
      const category = data.categories.find(
        (value) => value.id === row.categoryId,
      );
      return [
        row.date,
        "支出",
        row.merchant || row.description,
        row.amount,
        category?.name ?? "",
        category?.subcategories.find((value) => value.id === row.subcategoryId)
          ?.name ?? "",
        paymentLabels[row.paymentMethod],
        data.cards.find((value) => value.id === row.creditCardId)?.name ?? "",
        row.memo,
        ...sourceColumns(data, row, "expense"),
      ];
    });
}
function incomeRows(data: AppData): Cell[][] {
  return data.incomes.map((row) => [
    row.date,
    "収入",
    row.source,
    row.amount,
    row.type === "salary"
      ? "給与"
      : row.type === "temporary"
        ? "臨時収入"
        : "その他",
    "",
    "",
    "",
    row.memo,
    ...sourceColumns(data, row, "income"),
  ]);
}
function transferRows(data: AppData): Cell[][] {
  return (data.transfers ?? []).map((row) => [
    row.date,
    row.status === "reversed" ? "取消済み振替" : "振替",
    `${accountName(data, row.fromAccountId)} → ${accountName(data, row.toAccountId)}`,
    row.amount,
    "",
    "",
    "",
    "",
    row.memo,
    `${accountName(data, row.fromAccountId)} → ${accountName(data, row.toAccountId)}`,
    row.externalTransactionIds?.length ? "金融明細照合" : "手入力",
    "transfer",
    row.externalTransactionIds?.length ? "External" : "Manual",
  ]);
}
function rawAdjustmentRows(data: AppData): Cell[][] {
  return (data.externalTransactions ?? [])
    .filter((row) => row.kind === "refund" || row.kind === "unclassified")
    .map((row) => {
      const expense = data.expenses.find(
        (value) => value.id === row.relatedExpenseId,
      );
      const category = data.categories.find(
        (value) => value.id === expense?.categoryId,
      );
      return [
        row.date,
        row.kind === "refund" ? "返金" : "未分類明細",
        row.description,
        row.amount,
        category?.name ?? "未分類",
        category?.subcategories.find(
          (value) => value.id === expense?.subcategoryId,
        )?.name ?? "",
        "",
        "",
        row.pendingStatus,
        accountName(data, row.accountId),
        exportSource(row),
        row.kind,
        "External",
      ];
    });
}
export function buildCSV(data: AppData): string {
  const header = [
    "日付",
    "種類",
    "店・内容",
    "金額",
    "カテゴリー",
    "サブカテゴリー",
    "支払方法",
    "カード",
    "メモ",
    "口座",
    "取得元",
    "取引種別",
    "入力方法",
  ];
  const payments = data.cardPayments.map((row) => [
    row.date,
    "カード支払",
    data.cards.find((card) => card.id === row.creditCardId)?.name ?? "",
    row.amount,
    "",
    "",
    "銀行引落",
    "",
    row.memo,
    ...sourceColumns(data, row, "cardPayment"),
  ]);
  const debts = data.repayments.map((row) => [
    row.date,
    "借金返済",
    data.debts.find((debt) => debt.id === row.debtId)?.title ?? "",
    row.amount,
    "",
    "",
    "",
    "",
    row.memo,
    ...sourceColumns(data, row, "debtRepayment"),
  ]);
  const savings = data.savingsContributions.map((row) => [
    row.date,
    "貯金移動",
    data.savingsGoals.find((goal) => goal.id === row.savingsGoalId)?.name ?? "",
    row.amount,
    "",
    "",
    "",
    "",
    row.memo,
    ...sourceColumns(data, row, "savingsTransfer"),
  ]);
  const rows = [
    ...expenseRows(data),
    ...incomeRows(data),
    ...payments,
    ...debts,
    ...savings,
    ...transferRows(data),
    ...rawAdjustmentRows(data),
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return (
    "\uFEFF" +
    [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")
  );
}

/** ExcelJS is loaded only when exporting to avoid adding it to the application startup bundle. */
export async function buildExcel(data: AppData): Promise<Blob> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = APP_NAME;
  workbook.created = new Date();
  const addSheet = (name: string, header: string[], rows: Cell[][]) => {
    const sheet = workbook.addWorksheet(name, {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    sheet.columns = header.map((title) => ({
      header: title,
      width:
        title === "メモ" || title === "店・内容"
          ? 30
          : title === "日付"
            ? 24
            : 20,
    }));
    sheet.addRows(rows);
    sheet.getRow(1).height = 28;
    sheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF183E4B" },
      };
      cell.alignment = { vertical: "middle" };
    });
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, sheet.rowCount), column: header.length },
    };
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1)
        row.eachCell((cell) => {
          if (typeof cell.value === "number") cell.numFmt = "#,##0";
          cell.alignment = { vertical: "middle", wrapText: true };
        });
    });
  };
  const sum = (rows: { amount: number }[]) =>
    rows.reduce((total, row) => total + row.amount, 0);
  const refundTotal = calculateRefundTotal(data, "1900-01-01", "9999-12-31");
  addSheet(
    "概要",
    ["項目", "金額・内容"],
    [
      ["出力日時", new Date().toISOString()],
      ["総収入", sum(data.incomes)],
      ["生活支出（購入日・返金前）", sum(data.expenses)],
      ["確定返金（収入対象外）", refundTotal],
      ["生活支出（返金差引後）", sum(data.expenses) - refundTotal],
      ["借金返済", sum(data.repayments)],
      ["貯金移動", sum(data.savingsContributions)],
      ["カード支払（二重計上対象外）", sum(data.cardPayments)],
      ["保存先", "この端末のIndexedDBのみ"],
    ],
  );
  const header = [
    "日付",
    "種類",
    "店・内容",
    "金額",
    "カテゴリー",
    "サブカテゴリー",
    "支払方法",
    "カード",
    "メモ",
    "口座",
    "取得元",
    "取引種別",
    "入力方法",
  ];
  addSheet("支出", header, expenseRows(data));
  addSheet("収入", header, incomeRows(data));
  addSheet(
    "カード",
    [
      "カード名",
      "下4桁",
      "締め日",
      "支払日",
      "初期未払い",
      "利用額",
      "支払済み",
      "現在未払い",
      "残高確認日",
      "カードからの振替（生活支出対象外）",
    ],
    data.cards.map((card) => {
      const account = data.accounts?.find(
        (row) => row.kind === "CREDIT_CARD" && row.creditCardId === card.id,
      );
      const used = sum(
        data.expenses.filter(
          (row) =>
            row.creditCardId === card.id && row.paymentMethod === "creditCard",
        ),
      );
      const transferPayments = (data.transfers ?? []).filter(
        (row) => row.status === "confirmed" && row.toAccountId === account?.id,
      );
      const paid =
        sum(data.cardPayments.filter((row) => row.creditCardId === card.id)) +
        sum(transferPayments);
      const known =
        !data.settings.financialAutomationEnabled ||
        !account ||
        calculateAccountBalance(data, account) !== null;
      return [
        card.name,
        card.last4,
        card.closingDay,
        card.paymentDay,
        card.openingOutstanding,
        used,
        paid,
        known ? calculateCardOutstanding(data, card.id, todayJST()) : "未取得",
        account?.balanceAsOf ?? "",
        sum(
          (data.transfers ?? []).filter(
            (row) =>
              row.status === "confirmed" && row.fromAccountId === account?.id,
          ),
        ),
      ];
    }),
  );
  addSheet(
    "借金",
    [
      "貸主",
      "内容",
      "元の借入",
      "開始残高",
      "記録した返済",
      "現在残高",
      "月の返済予定",
      "概算",
    ],
    data.debts.map((debt) => {
      const paid = sum(data.repayments.filter((row) => row.debtId === debt.id));
      return [
        debt.lenderName,
        debt.title,
        debt.originalAmount,
        debt.openingBalance,
        paid,
        Math.max(0, debt.openingBalance - paid),
        debt.plannedMonthlyPayment,
        debt.isEstimated ? "概算" : "確定",
      ];
    }),
  );
  addSheet(
    "固定費",
    ["内容", "金額", "頻度", "支払日", "支払方法", "状態", "メモ"],
    data.recurringExpenses.map((row) => [
      row.name,
      row.amount,
      row.frequency === "monthly" ? "毎月" : "毎年",
      row.dueDay,
      paymentLabels[row.paymentMethod],
      row.isActive ? "有効" : "停止",
      row.note,
    ]),
  );
  const months = [
    ...new Set([
      ...data.expenses.map((row) => monthKey(row.date)),
      ...data.incomes.map((row) => monthKey(row.date)),
      ...data.repayments.map((row) => monthKey(row.date)),
      ...data.savingsContributions.map((row) => monthKey(row.date)),
      ...(data.externalTransactions ?? [])
        .filter(
          (row) => row.kind === "refund" && row.pendingStatus !== "pending",
        )
        .map((row) => monthKey(row.date)),
    ]),
  ].sort();
  addSheet(
    "月別集計",
    [
      "月",
      "収入",
      "生活支出（返金差引）",
      "収入−生活支出",
      "借金返済",
      "貯金移動",
      "確定返金（収入対象外）",
    ],
    months.map((month) => {
      const income = sum(
        data.incomes.filter((row) => monthKey(row.date) === month),
      );
      const refund = calculateRefundTotal(
        data,
        `${month}-01`,
        monthEnd(`${month}-01`),
      );
      const expense =
        sum(data.expenses.filter((row) => monthKey(row.date) === month)) -
        refund;
      return [
        month,
        income,
        expense,
        income - expense,
        sum(data.repayments.filter((row) => monthKey(row.date) === month)),
        sum(
          data.savingsContributions.filter(
            (row) => monthKey(row.date) === month,
          ),
        ),
        refund,
      ];
    }),
  );
  const refundsByCategory = new Map<string, number>();
  for (const row of data.externalTransactions ?? []) {
    if (row.kind !== "refund" || row.pendingStatus === "pending") continue;
    const categoryId =
      data.expenses.find((expense) => expense.id === row.relatedExpenseId)
        ?.categoryId ?? "uncategorized";
    refundsByCategory.set(
      categoryId,
      (refundsByCategory.get(categoryId) ?? 0) + Math.abs(row.amount),
    );
  }
  const categorySummary: Cell[][] = data.categories.map((category) => {
    const rows = data.expenses.filter((row) => row.categoryId === category.id);
    const refund = refundsByCategory.get(category.id) ?? 0;
    return [category.name, rows.length, sum(rows) - refund, refund];
  });
  if (
    !data.categories.some((category) => category.id === "uncategorized") &&
    refundsByCategory.has("uncategorized")
  ) {
    const refund = refundsByCategory.get("uncategorized")!;
    categorySummary.push(["未分類", 0, -refund, refund]);
  }
  addSheet(
    "カテゴリー別集計",
    ["カテゴリー", "件数", "生活支出（返金差引）", "確定返金"],
    categorySummary,
  );
  addSheet(
    "口座",
    [
      "口座名",
      "種類",
      "金融機関",
      "取得残高",
      "残高取得時点",
      "残高の取得元",
      "支出に使える",
      "カード関連付け",
    ],
    (data.accounts ?? []).map((row) => [
      row.name,
      row.kind,
      row.institutionName,
      row.snapshotBalance ?? "",
      row.balanceAsOf,
      row.balanceSource === "provider" ? "金融連携" : "手入力",
      row.isSpendable ? "はい" : "いいえ",
      data.cards.find((card) => card.id === row.creditCardId)?.name ?? "",
    ]),
  );
  addSheet("振替", header, transferRows(data));
  addSheet(
    "金融明細",
    [
      "日付",
      "口座",
      "金額",
      "通貨",
      "内容",
      "取得元",
      "取引種別",
      "確定状態",
      "金融機関取引ID",
      "元通貨",
      "元金額",
      "確定円額",
    ],
    (data.externalTransactions ?? []).map((row) => [
      row.date,
      accountName(data, row.accountId),
      row.amount,
      row.currency,
      row.description,
      exportSource(row),
      row.kind,
      row.pendingStatus,
      row.externalTransactionId,
      row.originalCurrency ?? "",
      row.originalAmount ?? "",
      row.finalJPYAmount ?? "",
    ]),
  );
  addSheet("返金・未分類", header, rawAdjustmentRows(data));
  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([new Uint8Array(buffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
