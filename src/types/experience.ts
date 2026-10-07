export type ReminderKind =
  | "daily"
  | "evening"
  | "balance"
  | "payday"
  | "card"
  | "recurring"
  | "budget"
  | "low"
  | "backup";
export interface ReminderRule {
  explicitlyConfigured?: boolean;
  enabled: boolean;
  time: string;
  days: number[];
  frequency: "daily" | "weekly" | "monthly";
  monthDay: number;
  snoozeMinutes: number;
  snoozedUntil?: string;
  showAmount: boolean;
  badge: boolean;
  lastAcknowledged?: string;
  lastDelivered?: string;
}
export interface NotificationCenterConfig {
  intensity?: "quiet" | "standard" | "active";
  rules: Record<ReminderKind, ReminderRule>;
  quietStart: string;
  quietEnd: string;
  quietEnabled: boolean;
}
export type HomeCardId = "balances" | "insight" | "recent";
export interface PersonalizationSettings {
  enabled: boolean;
  quickActions?: import("./practical").QuickActionId[];
  pinnedQuickActions?: import("./practical").QuickActionId[];
  pinnedCards: HomeCardId[];
  homeCardOrder?: HomeCardId[];
  featureUses: Record<string, number>;
}
export interface AppearanceSettings {
  accent:
    | "blue"
    | "sky"
    | "indigo"
    | "teal"
    | "green"
    | "graphite"
    | "purple"
    | "orange";
  background: "flat" | "tint" | "gradient" | "glass" | "glow";
  cards: "standard" | "soft" | "glass" | "flat";
  density: "compact" | "standard" | "comfortable";
}
