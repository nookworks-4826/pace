import { FinancialProviderError } from "../types";

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function createPkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, state, challenge, method: "S256" as const };
}
export function equalState(a: string, b: string) {
  if (a.length !== b.length || a.length < 32) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export interface OAuthCallback {
  code: string | null;
  state: string | null;
  clientId: string | null;
  error: string | null;
  origin: string;
  pathname: string;
  malformed: boolean;
}
const privateParameters = ["code", "state", "client_id", "error", "error_description", "access_token", "refresh_token", "id_token"];
/** Call at startup, BEFORE vault unlocking. Callback contents remain in memory only. */
export function consumeOAuthCallback(rawUrl: string, replaceUrl: (cleanUrl: string) => void): OAuthCallback | null {
  const url = new URL(rawUrl);
  const fragment = url.hash.slice(1);
  const fragmentParams = new URLSearchParams(fragment.startsWith("/") ? fragment.split("?")[1] ?? "" : fragment);
  const hasPrivate = privateParameters.some((key) => url.searchParams.has(key) || fragmentParams.has(key));
  if (!hasPrivate) return null;
  const callback: OAuthCallback = {
    code: url.searchParams.get("code"), state: url.searchParams.get("state"),
    clientId: url.searchParams.get("client_id"), error: url.searchParams.get("error"),
    origin: url.origin, pathname: url.pathname,
    malformed: privateParameters.some((key) => url.searchParams.getAll(key).length > 1 || fragmentParams.has(key)),
  };
  for (const key of privateParameters) url.searchParams.delete(key);
  if (privateParameters.some((key) => fragmentParams.has(key))) url.hash = "#/financial";
  replaceUrl(url.href);
  return callback;
}
export function callbackCode(callback: OAuthCallback, pending: { state: string; redirectUri: string; createdAt: string }, now: number, clientId: string) {
  const redirect = new URL(pending.redirectUri);
  if (callback.malformed || callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || !callback.state || !equalState(callback.state, pending.state) || (callback.clientId && callback.clientId !== clientId)) throw new FinancialProviderError("stateMismatch");
  const created = Date.parse(pending.createdAt);
  if (!Number.isFinite(created) || now - created > 10 * 60_000 || now < created) throw new FinancialProviderError("callbackExpired");
  if (callback.error) throw new FinancialProviderError(callback.error === "access_denied" ? "cancelled" : "authenticationRequired");
  if (!callback.code || callback.code.length > 4096) throw new FinancialProviderError("stateMismatch");
  return callback.code;
}
