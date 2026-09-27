import { describe, expect, it } from "vitest";
import { learnMerchantRule, suggestCategory } from "../domain/categorization";
import { predictCategoryPattern } from "../domain/categoryLearning";
import { defaultCategories } from "../db";
const samples = ["青空ベーカリー", "駅前ベーカリー", "北町ベーカリー"]
  .map((name) => learnMerchantRule(name, "food", "")!)
  .concat(
    ["新町フラワー", "森のフラワー", "中央フラワー"].map((name) =>
      learnMerchantRule(name, "shopping", "")!,
    ),
  );
describe("private category pattern learning", () => {
  it("learns a shared pattern from multiple independent stores, while marking it tentative", () => {
    expect(
      suggestCategory("川沿いベーカリー", samples, defaultCategories),
    ).toMatchObject({
      categoryId: "food",
      confidence: "medium",
      source: "pattern",
      subcategoryId: "",
    });
    expect(predictCategoryPattern("海辺フラワー", samples)).toBe("shopping");
  });
  it("abstains without enough examples, with unknown words, or duplicate rows", () => {
    expect(
      predictCategoryPattern("川沿いベーカリー", samples.slice(0, 3)),
    ).toBeNull();
    expect(predictCategoryPattern("謎の出費", samples)).toBeNull();
    expect(
      predictCategoryPattern("川沿いベーカリー", Array(10).fill(samples[0])),
    ).toBeNull();
  });
  it("lets explicit corrections win and never uses deleted or archived categories", () => {
    const corrected = [
      ...samples,
      learnMerchantRule("川沿いベーカリー", "social", "social-0")!,
    ];
    expect(
      suggestCategory("川沿いベーカリー", corrected, defaultCategories),
    ).toMatchObject({ categoryId: "social", source: "learned" });
    expect(
      suggestCategory(
        "川沿いベーカリー",
        samples,
        defaultCategories.filter((category) => category.id !== "food"),
      ).source,
    ).toBe("none");
    expect(
      suggestCategory(
        "川沿いベーカリー",
        samples,
        defaultCategories.map((category) =>
          category.id === "food" ? { ...category, archived: true } : category,
        ),
      ).source,
    ).toBe("none");
  });
  it("abstains when the same pattern supports conflicting categories", () => {
    const conflict = [
      ...samples,
      ...["南町ベーカリー", "西町ベーカリー", "東町ベーカリー"].map((name) =>
        learnMerchantRule(name, "shopping", "")!,
      ),
    ];
    expect(predictCategoryPattern("川沿いベーカリー", conflict)).toBeNull();
  });
});
