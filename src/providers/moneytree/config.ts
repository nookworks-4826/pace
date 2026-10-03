import { FinancialProviderError } from "../types";

export interface MoneytreeConfig {
  clientId: string;
  redirectUri: string;
  environment: "staging" | "production";
  /** Set only after Moneytree confirms Public Client + browser CORS for this origin. */
  browserAccessConfirmed: boolean;
}
export const MONEYTREE_SCOPES = ["guest_read", "accounts_read", "transactions_read", "request_refresh"] as const;
export function moneytreeEndpoints(config: MoneytreeConfig) {
  const suffix = config.environment === "staging" ? "-staging" : "";
  return { auth: `https://myaccount${suffix}.getmoneytree.com`, api: `https://jp-api${suffix}.getmoneytree.com` };
}
export function validateMoneytreeConfig(config: MoneytreeConfig | null): MoneytreeConfig {
  if (!config?.clientId?.trim() || config.clientId.length > 512 || !config.browserAccessConfirmed || !["staging", "production"].includes(config.environment)) throw new FinancialProviderError("configurationRequired");
  let redirect: URL;
  try { redirect = new URL(config.redirectUri); } catch { throw new FinancialProviderError("configurationRequired"); }
  const dev = config.environment === "staging" && ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
  if ((redirect.protocol !== "https:" && !(dev && redirect.protocol === "http:")) || redirect.username || redirect.password || redirect.search || redirect.hash) throw new FinancialProviderError("configurationRequired");
  return config;
}
export function moneytreeConfigFromEnv(env: Record<string, unknown>): MoneytreeConfig | null {
  const clientId = String(env.VITE_MONEYTREE_CLIENT_ID ?? "").trim();
  const redirectUri = String(env.VITE_MONEYTREE_REDIRECT_URI ?? "").trim();
  const environment = env.VITE_MONEYTREE_ENVIRONMENT;
  if (!clientId || !redirectUri || !["staging", "production"].includes(String(environment))) return null;
  return { clientId, redirectUri, environment: environment as "staging" | "production", browserAccessConfirmed: env.VITE_MONEYTREE_BROWSER_ACCESS_CONFIRMED === "true" };
}
