import { describe, it, expect } from "vitest";
import {
  planFinancialImport,
  transferCandidates,
  manualDuplicate,
  needsTransferReview,
} from "../domain/financialImport";
import type { AppData, Account } from "../types";
import { defaultSettings } from "../db";
const data = (): AppData => ({
  expenses: [],
  incomes: [],
  cards: [],
  cardPayments: [],
  debts: [],
  repayments: [],
  recurringExpenses: [],
  recurringOccurrences: [],
  savingsGoals: [],
  savingsContributions: [],
  budgets: [],
  settings: structuredClone(defaultSettings),
  merchantRules: [],
  categories: [
    {
      id: "uncategorized",
      name: "未分類",
      color: "#fff",
      icon: "Circle",
      subcategories: [],
    },
  ],
  balanceAdjustments: [],
  dailyCheckIns: [],
  favorites: [],
  externalTransactions: [],
});
const account: Account = {
  id: "card-account",
  name: "テストカード",
  kind: "CREDIT_CARD",
  institutionName: "テスト",
  currency: "JPY",
  snapshotBalance: 1000,
  balanceAsOf: "2026-10-03",
  snapshotRecordedAt: "2026-10-03T00:00:00Z",
  balanceSource: "provider",
  creditCardId: "card",
  providerId: "mock",
  externalAccountId: "ext",
  isSpendable: false,
  isActive: true,
  automationLevel: "automatic",
  createdAt: "",
  updatedAt: "",
};
const tx = {
  externalTransactionId: "one",
  externalAccountId: "ext",
  externalUpdatedAt: "2026-10-03T00:00:00Z",
  date: "2026-10-03",
  amount: -1000,
  description: "架空カフェ",
  currency: "JPY",
  pendingStatus: "pending" as const,
};
describe("financial import", () => {
  it.each([
    "三井住友カード",
    "ミツビシＵＦＪニコス",
    "ﾐﾂｲｽﾐﾄﾓｶｰﾄﾞ",
    "MUFG CARD",
    "カード引落",
    "CARD PAYMENT",
  ])("holds bank card settlement %s for transfer review", (description) => {
    const bank = { ...account, kind: "BANK" as const, creditCardId: undefined };
    const a = data();
    const plan = planFinancialImport(
      a,
      bank,
      [{ ...tx, description }],
      "c",
      "now",
    );
    expect(plan.expenses).toHaveLength(0);
    expect(plan.incomes).toHaveLength(0);
    expect(plan.external[0].kind).toBe("unclassified");
  });
  it.each([
    "モバイルスイカ",
    "モバイルスイカSF",
    "ﾓﾊﾞｲﾙｽｲｶ",
    "MOBILE SUICA",
    "SUICA1234",
    "PayPay",
  ])("holds card wallet refill %s for confirmation", (description) => {
    expect(needsTransferReview(account, { ...tx, description })).toBe(true);
    const plan = planFinancialImport(
      data(),
      account,
      [{ ...tx, description }],
      "c",
      "now",
    );
    expect(plan.expenses).toHaveLength(0);
    expect(plan.external[0].kind).toBe("unclassified");
  });
  it("keeps real wallet purchases and ordinary bank expenses automatic", () => {
    const wallet = {
      ...account,
      kind: "EWALLET" as const,
      creditCardId: undefined,
    };
    expect(
      planFinancialImport(
        data(),
        wallet,
        [{ ...tx, description: "モバイルスイカ" }],
        "c",
        "now",
      ).expenses,
    ).toHaveLength(1);
    const bank = { ...account, kind: "BANK" as const, creditCardId: undefined };
    expect(
      planFinancialImport(
        data(),
        bank,
        [{ ...tx, description: "三井住友海上保険" }],
        "c",
        "now",
      ).expenses,
    ).toHaveLength(1);
    expect(
      planFinancialImport(
        data(),
        account,
        [{ ...tx, description: "PayPay 架空食堂" }],
        "c",
        "now",
      ).expenses,
    ).toHaveLength(1);
  });
  it("holds keyword-free opposite entries on known connected accounts without booking expense or salary", () => {
    const a = data();
    const bank = {
      ...account,
      id: "bank-a",
      kind: "BANK" as const,
      creditCardId: undefined,
      connectionId: "c",
    };
    const other = { ...bank, id: "bank-b", externalAccountId: "other" };
    a.accounts = [bank, other];
    const outgoing = { ...tx, description: "A001" };
    const incoming = {
      ...tx,
      externalTransactionId: "two",
      externalAccountId: "other",
      amount: 1000,
      description: "給与振込",
    };
    a.salaryRules = [
      {
        id: "rule",
        accountId: other.id,
        normalizedDescription: "給与振込",
        enabled: true,
        createdAt: "",
        updatedAt: "",
      },
    ];
    const before = structuredClone(a);
    const from = planFinancialImport(a, bank, [outgoing, incoming], "c", "now");
    const to = planFinancialImport(a, other, [outgoing, incoming], "c", "now");
    expect(from.expenses).toHaveLength(0);
    expect(to.incomes).toHaveLength(0);
    expect(from.external[0].kind).toBe("unclassified");
    expect(to.external[0].kind).toBe("unclassified");
    expect(transferCandidates([...from.external, ...to.external])).toHaveLength(
      1,
    );
    expect(a).toEqual(before);
  });
  it.each([
    "unknown",
    "other-connection",
    "wrong-currency",
    "different-amount",
    "different-date",
  ])(
    "does not suppress a normal purchase for an unrelated %s counterpart",
    (reason) => {
      const a = data();
      const bank = {
        ...account,
        kind: "BANK" as const,
        creditCardId: undefined,
        connectionId: "c",
      };
      if (reason !== "unknown")
        a.accounts = [
          bank,
          {
            ...bank,
            id: "other-bank",
            externalAccountId: "other",
            connectionId: reason === "other-connection" ? "elsewhere" : "c",
          },
        ];
      const counterpart = {
        ...tx,
        externalTransactionId: "two",
        externalAccountId: "other",
        amount: reason === "different-amount" ? 999 : 1000,
        currency: reason === "wrong-currency" ? "USD" : "JPY",
        date: reason === "different-date" ? "2026-10-06" : tx.date,
      };
      expect(
        planFinancialImport(a, bank, [tx, counterpart], "c", "now").expenses,
      ).toHaveLength(1);
    },
  );
  it("keeps a confirmed salary rule for actual payroll without a paired owned-account outflow", () => {
    const a = data();
    const bank = {
      ...account,
      kind: "BANK" as const,
      creditCardId: undefined,
      connectionId: "c",
    };
    a.accounts = [bank];
    a.salaryRules = [
      {
        id: "rule",
        accountId: bank.id,
        normalizedDescription: "給与振込",
        enabled: true,
        createdAt: "",
        updatedAt: "",
      },
    ];
    const plan = planFinancialImport(
      a,
      bank,
      [{ ...tx, amount: 1000, description: "給与振込" }],
      "c",
      "now",
    );
    expect(plan.incomes).toHaveLength(1);
    expect(plan.external[0].kind).toBe("income");
  });
  it("uses previously loaded opposite entries but replaces their old pending amount with the latest version", () => {
    const a = data();
    const bank = {
      ...account,
      kind: "BANK" as const,
      creditCardId: undefined,
      connectionId: "c",
    };
    const other = { ...bank, id: "other-bank", externalAccountId: "other" };
    a.accounts = [bank, other];
    const incoming = {
      ...tx,
      externalTransactionId: "two",
      externalAccountId: "other",
      amount: 1000,
    };
    a.externalTransactions = planFinancialImport(
      a,
      other,
      [incoming],
      "c",
      "now",
    ).external;
    expect(
      planFinancialImport(a, bank, [tx], "c", "now").expenses,
    ).toHaveLength(0);
    expect(
      planFinancialImport(
        a,
        bank,
        [tx, { ...incoming, amount: 999, pendingStatus: "posted" }],
        "c",
        "now",
      ).expenses,
    ).toHaveLength(1);
  });
  it("holds legacy bank manual entries for confirmation without making a duplicate", () => {
    const a = data();
    const bank = { ...account, kind: "BANK" as const, creditCardId: undefined };
    a.accounts = [bank];
    a.expenses = planFinancialImport(a, bank, [tx], "c", "now").expenses.map(
      (e) => ({
        ...e,
        id: "legacy-manual",
        sourceAccountId: undefined,
        externalTransactionId: undefined,
      }),
    );
    const plan = planFinancialImport(a, bank, [tx], "c", "now");
    expect(plan.expenses).toHaveLength(0);
    expect(manualDuplicate(a, plan.external[0])?.id).toBe("legacy-manual");
    expect(
      manualDuplicate(a, { ...plan.external[0], amount: 1000 }),
    ).toBeUndefined();
  });
  it("requests confirmation when a pending purchase becomes a cancellation or refund", () => {
    for (const amount of [0, 1000]) {
      const a = data();
      const first = planFinancialImport(a, account, [tx], "c", "now");
      a.expenses = first.expenses;
      a.externalTransactions = first.external;
      const plan = planFinancialImport(
        a,
        account,
        [{ ...tx, amount, pendingStatus: "posted" }],
        "c",
        "later",
      );
      expect(plan.expenses).toHaveLength(0);
      expect(plan.incomes).toHaveLength(0);
      expect(plan.external[0].kind).toBe("unclassified");
      expect(plan.external[0].linkedRecordId).toBe(first.expenses[0].id);
      expect(a.expenses[0].amount).toBe(1000);
    }
  });
  it("updates pending rather than creating a second expense", () => {
    const a = data();
    const first = planFinancialImport(a, account, [tx], "c", "now");
    a.expenses = first.expenses;
    a.externalTransactions = first.external;
    const next = planFinancialImport(
      a,
      account,
      [{ ...tx, amount: -1138, pendingStatus: "posted" }],
      "c",
      "later",
    );
    expect(next.expenses).toHaveLength(1);
    expect(next.expenses[0].id).toBe(first.expenses[0].id);
    expect(next.expenses[0].amount).toBe(1138);
    expect(next.expenses[0].balanceEffect).toBe("snapshot");
  });
  it("holds matching manual entries and transfers for confirmation", () => {
    const a = data();
    a.expenses = planFinancialImport(a, account, [tx], "c", "now").expenses.map(
      (e) => ({ ...e, id: "manual", externalTransactionId: undefined }),
    );
    expect(
      planFinancialImport(a, account, [tx], "c", "now").expenses,
    ).toHaveLength(0);
    expect(
      planFinancialImport(
        data(),
        account,
        [{ ...tx, description: "Suica チャージ" }],
        "c",
        "now",
      ).external[0].kind,
    ).toBe("unclassified");
  });
  it("does not guess foreign amounts or book incoming refunds as income", () => {
    expect(
      planFinancialImport(
        data(),
        account,
        [{ ...tx, currency: "USD" }],
        "c",
        "now",
      ).external,
    ).toHaveLength(0);
    const result = planFinancialImport(
      data(),
      account,
      [{ ...tx, amount: 1000 }],
      "c",
      "now",
    );
    expect(result.incomes).toHaveLength(0);
    expect(result.external[0].kind).toBe("unclassified");
  });
  it("pairs bank transfers without creating spending", () => {
    const from = planFinancialImport(
      data(),
      account,
      [{ ...tx, description: "口座振替" }],
      "c",
      "now",
    ).external[0];
    const to = { ...from, id: "to", amount: 1000, accountId: "bank2" };
    expect(transferCandidates([from, to])).toHaveLength(1);
  });
});
