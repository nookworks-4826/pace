/** Reviewed 2026-10-03. Listing support is not evidence of an active Pace connection. */
export const FINANCIAL_PROVIDER_REVIEWED_AT = "2026-10-03";
export const MONEYTREE_INSTITUTION_DIRECTORY = "https://institutions.moneytree.jp/";
export const MONEYTREE_INSTITUTION_CANDIDATES = [
  { name: "横浜銀行", entityKeys: ["yokohama_bank"], directoryStatus: "active", productConfirmationRequired: false },
  { name: "三菱UFJ銀行", entityKeys: ["mufg_bank"], directoryStatus: "active", productConfirmationRequired: false },
  { name: "三井住友カード", entityKeys: ["smbc_card"], directoryStatus: "active", productConfirmationRequired: false },
  { name: "三菱UFJ系カード", entityKeys: ["mufg_card", "mufg_visa_card"], directoryStatus: "active", productConfirmationRequired: true },
  { name: "モバイルSuica", entityKeys: ["mobile_suica"], directoryStatus: "active", productConfirmationRequired: false },
] as const;
export const WALLET_CAPABILITIES = {
  paypay: {
    level: "C" as const,
    automaticBalance: false,
    automaticTransactions: false,
    directTopUp: false,
    // Links are published in PayPay's own wallet help, not guessed URI schemes.
    walletUrl: "paypay://passbook",
    historyUrl: "paypay://user/transactionhistory",
    helpUrl: "https://paypay.ne.jp/help/c0140/",
    moneytreeStatusUrl: "https://help.getmoneytree.com/ja/articles/3728396-paypay%E3%82%84%E6%A5%BD%E5%A4%A9%E3%83%9A%E3%82%A4%E3%81%AA%E3%81%A9%E3%81%AB%E5%AF%BE%E5%BF%9C%E3%81%97%E3%81%A6%E3%81%84%E3%81%BE%E3%81%99%E3%81%8B",
    buttonLabel: "PayPayのウォレットを開く",
  },
  suica: {
    moneytreeCandidate: true,
    directTopUp: false,
    appDeepLink: null,
    helpUrl: "https://support.apple.com/ja-jp/HT207154",
    buttonLabel: "Walletでチャージする方法",
  },
} as const;
