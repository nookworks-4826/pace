import { db } from "../db";
import { defaultPersonalization } from "./personalization";
export async function recordFeatureUse(
  feature: import("../types").QuickActionId | "insight",
) {
  await db.transaction("rw", db.settings, async () => {
    const s = await db.settings.get("main");
    if (!s || s.personalization?.enabled === false) return;
    const p = s.personalization ?? defaultPersonalization;
    await db.settings.put({
      ...s,
      personalization: {
        ...p,
        featureUses: {
          ...p.featureUses,
          [feature]: Math.min(10000, (p.featureUses[feature] ?? 0) + 1),
        },
      },
    });
  });
}
