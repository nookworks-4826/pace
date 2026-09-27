import type { Category, MerchantCategoryRule, PaymentMethod } from "../types";
import { MAX_MONEY } from "./finance";
import { predictCategoryPattern } from "./categoryLearning";

export function normalizeMerchant(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)|㈱|㈲/gu, "")
    .replace(/\s+[^\s]*(?:支店|営業所|店舗|店)\s*$/u, "")
    .replace(/[（(][^）)]*(?:支店|店)[）)]/gu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

export interface CategorySuggestion {
  categoryId: string;
  subcategoryId: string;
  confidence: "high" | "medium" | "low";
  source: "learned" | "keyword" | "similar" | "pattern" | "none";
  label: string;
}

const keywords: { words: string[]; category: string; subcategory: string }[] = [
  {
    words: [
      "マクドナルド",
      "マック",
      "モス",
      "ガスト",
      "サイゼリヤ",
      "サイゼリア",
      "吉野家",
      "すき家",
      "松屋",
      "丸亀",
      "スシロー",
      "くら寿司",
      "ココス",
      "バーガーキング",
    ],
    category: "食費",
    subcategory: "外食",
  },
  {
    words: [
      "セブン",
      "ファミマ",
      "ファミリーマート",
      "ローソン",
      "ミニストップ",
    ],
    category: "食費",
    subcategory: "コンビニ",
  },
  {
    words: [
      "スタバ",
      "スターバックス",
      "ドトール",
      "タリーズ",
      "コメダ",
      "カフェ",
    ],
    category: "食費",
    subcategory: "カフェ",
  },
  {
    words: [
      "イオン",
      "西友",
      "ライフ",
      "まいばすけっと",
      "業務スーパー",
      "マルエツ",
    ],
    category: "食費",
    subcategory: "スーパー",
  },
  {
    words: ["ubereats", "出前館", "ウーバーイーツ"],
    category: "食費",
    subcategory: "デリバリー",
  },
  {
    words: ["amazon", "アマゾン", "楽天"],
    category: "買い物",
    subcategory: "ネットショッピング",
  },
  {
    words: ["jr", "suica", "pasmo", "スイカ", "パスモ", "東京メトロ", "電車"],
    category: "交通",
    subcategory: "電車",
  },
  { words: ["バス"], category: "交通", subcategory: "バス" },
  { words: ["タクシー"], category: "交通", subcategory: "タクシー" },
  {
    words: [
      "netflix",
      "spotify",
      "youtube premium",
      "apple music",
      "ディズニープラス",
    ],
    category: "固定費",
    subcategory: "サブスク",
  },
  {
    words: ["ユニクロ", "gu", "無印良品"],
    category: "買い物",
    subcategory: "衣服",
  },
  {
    words: ["薬局", "マツモトキヨシ", "ウエルシア"],
    category: "生活",
    subcategory: "薬",
  },
];

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length];
}

export function suggestCategory(
  merchant: string,
  rules: MerchantCategoryRule[],
  categories: Category[],
): CategorySuggestion {
  const normalized = normalizeMerchant(merchant);
  const activeCategories = categories.filter((category) => !category.archived);
  const fallback =
    activeCategories.find(
      (category) =>
        category.id === "uncategorized" || category.name === "未分類",
    ) ?? activeCategories.at(-1);
  const none: CategorySuggestion = {
    categoryId: fallback?.id ?? "uncategorized",
    subcategoryId: "",
    confidence: "low",
    source: "none",
    label: fallback?.name ?? "未分類",
  };
  if (!normalized) return none;
  const validRules = rules.filter((rule) =>
    activeCategories.some(
      (category) =>
        category.id === rule.categoryId &&
        (!rule.subcategoryId ||
          category.subcategories.some((sub) => sub.id === rule.subcategoryId)),
    ),
  );
  function fromRule(
    rule: MerchantCategoryRule,
    source: "learned" | "similar",
  ): CategorySuggestion {
    const category = activeCategories.find(
      (row) => row.id === rule.categoryId,
    )!;
    return {
      categoryId: category.id,
      subcategoryId: rule.subcategoryId,
      confidence: source === "learned" ? "high" : "medium",
      source,
      label:
        category.subcategories.find((sub) => sub.id === rule.subcategoryId)
          ?.name ?? category.name,
    };
  }
  // An explicit user correction must win over built-in keywords on later entries.
  const exact = validRules.find(
    (rule) => rule.normalizedMerchant === normalized,
  );
  if (exact) return fromRule(exact, "learned");
  for (const entry of keywords) {
    if (
      !entry.words.some((word) => normalized.includes(normalizeMerchant(word)))
    )
      continue;
    const category = activeCategories.find(
      (row) => row.name === entry.category,
    );
    if (!category) continue;
    const subcategory = category.subcategories.find(
      (sub) => sub.name === entry.subcategory,
    );
    return {
      categoryId: category.id,
      subcategoryId: subcategory?.id ?? "",
      confidence: "high",
      source: "keyword",
      label: subcategory?.name ?? category.name,
    };
  }
  // Restrict fuzzy work to short comparable strings to keep entry quick with many rules.
  const candidates = validRules
    .filter(
      (rule) =>
        normalized.length >= 4 &&
        rule.normalizedMerchant.length >= 4 &&
        Math.abs(normalized.length - rule.normalizedMerchant.length) <= 3,
    )
    .map((rule) => ({
      rule,
      score:
        1 -
        editDistance(
          normalized.slice(0, 80),
          rule.normalizedMerchant.slice(0, 80),
        ) /
          Math.max(
            normalized.slice(0, 80).length,
            rule.normalizedMerchant.slice(0, 80).length,
          ),
    }))
    .filter((candidate) => candidate.score >= 0.76)
    .sort((a, b) => b.score - a.score || b.rule.usageCount - a.rule.usageCount);
  if (
    candidates[0] &&
    (!candidates[1] ||
      candidates[0].score > candidates[1].score ||
      candidates[0].rule.categoryId === candidates[1].rule.categoryId)
  )
    return fromRule(candidates[0].rule, "similar");
  const pattern = predictCategoryPattern(normalized, validRules);
  const category = activeCategories.find((row) => row.id === pattern);
  if (category)
    return {
      categoryId: category.id,
      subcategoryId: "",
      confidence: "medium",
      source: "pattern",
      label: category.name,
    };
  return none;
}

export interface QuickEntry {
  amount?: number;
  merchant: string;
  paymentMethod?: PaymentMethod;
}
export function parseQuickEntry(input: string): QuickEntry {
  let text = input.normalize("NFKC").trim();
  let paymentMethod: PaymentMethod | undefined;
  const hints: [RegExp, PaymentMethod][] = [
    [/(?:クレカ|クレジットカード|カード)/u, "creditCard"],
    [/デビット/u, "debit"],
    [/現金/u, "cash"],
    [/(?:銀行引落|銀行|引落)/u, "bank"],
  ];
  for (const [pattern, method] of hints) {
    if (pattern.test(text)) {
      paymentMethod = method;
      text = text.replace(pattern, "").trim();
      break;
    }
  }
  const matches = [
    ...text.matchAll(/(?:^|\s|[¥￥])(\d[\d,]*)(?:円)?(?=\s|$)/gu),
  ];
  const match = matches.at(-1);
  if (!match) return { merchant: text, paymentMethod };
  const amount = Number(match[1].replaceAll(",", ""));
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_MONEY)
    return { merchant: text, paymentMethod };
  const merchant =
    `${text.slice(0, match.index)} ${text.slice((match.index ?? 0) + match[0].length)}`
      .trim()
      .replace(/\s+/gu, " ");
  return { amount, merchant, paymentMethod };
}

export function learnMerchantRule(
  merchant: string,
  categoryId: string,
  subcategoryId: string,
  existing?: MerchantCategoryRule,
  now = new Date().toISOString(),
): MerchantCategoryRule | null {
  const normalizedMerchant = normalizeMerchant(merchant);
  if (!normalizedMerchant || categoryId === "uncategorized") return null;
  return {
    normalizedMerchant,
    categoryId,
    subcategoryId,
    usageCount: (existing?.usageCount ?? 0) + 1,
    lastUsedAt: now,
  };
}
