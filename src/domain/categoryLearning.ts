import type { MerchantCategoryRule } from "../types";

// A small, local TF-IDF nearest-centroid classifier. No network/model download.
// Abstain unless several different recorded shops support the same pattern.
function features(text: string): Set<string> {
  const chars = [
    ...text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\d\s\p{P}\p{S}]/gu, ""),
  ].slice(0, 80);
  return new Set(chars.slice(1).map((char, i) => chars[i] + char));
}
function unit(values: Map<string, number>): Map<string, number> {
  const length = Math.hypot(...values.values());
  return new Map(
    [...values].map(([key, value]) => [key, length ? value / length : 0]),
  );
}
export function predictCategoryPattern(
  query: string,
  rules: MerchantCategoryRule[],
): string | null {
  const rows = [
    ...new Map(rules.map((rule) => [rule.normalizedMerchant, rule])).values(),
  ]
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    .slice(0, 600)
    .map((rule) => ({ ...rule, tokens: features(rule.normalizedMerchant) }));
  if (rows.length < 6 || new Set(rows.map((row) => row.categoryId)).size < 2)
    return null;
  const queryTokens = features(query);
  const frequency = new Map<string, number>();
  for (const row of rows)
    for (const token of row.tokens)
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
  const weight = (token: string) =>
    1 + Math.log((rows.length + 1) / ((frequency.get(token) ?? 0) + 1));
  const vector = (tokens: Set<string>) =>
    unit(new Map([...tokens].map((token) => [token, weight(token)])));
  // Unseen words (often a branch or place name) carry no learned evidence.
  // Require coverage before projecting into the trained vocabulary.
  const known = new Set(
    [...queryTokens].filter((token) => frequency.has(token)),
  );
  if (known.size < 2 || known.size / queryTokens.size < 0.4) return null;
  const q = vector(known);
  const groups = new Map<string, typeof rows>();
  for (const row of rows)
    groups.set(row.categoryId, [...(groups.get(row.categoryId) ?? []), row]);
  const scores = [...groups]
    .flatMap(([category, samples]) => {
      if (samples.length < 3) return [];
      const overlap = samples.filter(
        (sample) =>
          [...queryTokens].filter((token) => sample.tokens.has(token)).length >=
          2,
      );
      if (overlap.length < 2) return [];
      const sum = new Map<string, number>();
      // Compare the supporting examples, so an unrelated set of shops in a
      // competing category cannot hide an otherwise ambiguous pattern.
      for (const sample of overlap)
        for (const [token, value] of vector(sample.tokens))
          sum.set(token, (sum.get(token) ?? 0) + value);
      const centroid = unit(sum);
      const score = [...q].reduce(
        (total, [token, value]) => total + value * (centroid.get(token) ?? 0),
        0,
      );
      return [{ category, score }];
    })
    .sort((a, b) => b.score - a.score);
  const best = scores[0];
  return best &&
    best.score >= 0.5 &&
    best.score - (scores[1]?.score ?? 0) >= 0.12
    ? best.category
    : null;
}
