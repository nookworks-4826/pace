import { z } from "zod";
import { APP_NAME } from "../types";

/**
 * This is a local screen lock, not encryption of IndexedDB and not server authentication.
 * A person with developer tools / browser profile access can bypass a local-only lock.
 * Biometrics remain with the authenticator. Some platforms synchronize passkeys through
 * their OS account; Pace never sends financial records to that service. Credentials are
 * origin-bound, are not backed up by Pace, and must be enrolled again after a restore.
 * Assertions are verified locally following https://www.w3.org/TR/webauthn-3/ .
 */
const STORAGE_KEY = "pace:local-lock:v1";
// Display metadata only. Keep the v1 security record readable by existing app tabs.
// A missing/stale label never changes which public key may unlock the app.
const PASSKEY_LABEL_KEY = "pace:passkey-label:v1";
const ITERATIONS = 310_000;
const encoder = new TextEncoder();
const noneSchema = z.object({ kind: z.literal("none") }).strict();
const pinSchema = z
  .object({
    kind: z.literal("pin"),
    salt: z.string().max(100),
    hash: z.string().max(100),
    iterations: z.number().int().min(310_000).max(1_000_000),
    failedAttempts: z.number().int().min(0).max(100_000),
    lockedUntil: z.number().nonnegative(),
  })
  .strict();
const deviceSchema = z
  .object({
    kind: z.literal("device"),
    credentialId: z.string().max(4096),
    publicKey: z
      .object({
        kty: z.literal("EC"),
        crv: z.literal("P-256"),
        x: z.string().max(100),
        y: z.string().max(100),
        ext: z.literal(true),
      })
      .strict(),
    rpId: z.string().max(300),
    origin: z.string().max(1000),
    signCount: z.number().int().min(0).max(4_294_967_295),
  })
  .strict();
const configSchema = z.discriminatedUnion("kind", [
  noneSchema,
  pinSchema,
  deviceSchema,
]);
export type LockConfig = z.infer<typeof configSchema>;

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("認証情報を読み込めませんでした。");
  const string = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(
    atob(string.padEnd(Math.ceil(string.length / 4) * 4, "=")),
    (char) => char.charCodeAt(0),
  );
}
function constantEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}
export function getLockConfig(): LockConfig {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) return { kind: "none" };
  // Fail closed on corruption instead of silently disabling an existing lock.
  try {
    return configSchema.parse(JSON.parse(stored));
  } catch {
    throw new Error(
      "ロック設定を読み込めませんでした。端末内データを削除する前に、保存済みバックアップを確認してください。",
    );
  }
}
function store(config: LockConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}
export function isPasskeyRegistered(): boolean {
  const config = getLockConfig();
  try {
    return (
      config.kind === "device" &&
      localStorage.getItem(PASSKEY_LABEL_KEY) === config.credentialId
    );
  } catch {
    return false;
  }
}
function labelPasskey(credentialId?: string): void {
  try {
    if (credentialId) localStorage.setItem(PASSKEY_LABEL_KEY, credentialId);
    else localStorage.removeItem(PASSKEY_LABEL_KEY);
  } catch {
    // Labels are optional; the successfully stored lock remains usable.
  }
}
async function hashPin(
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      material,
      256,
    ),
  );
}
export async function setPin(pin: string): Promise<void> {
  if (!/^\d{6}$/.test(pin))
    throw new Error("PINは6桁の数字で入力してください。");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPin(pin, salt, ITERATIONS);
  store({
    kind: "pin",
    salt: encode(salt),
    hash: encode(hash),
    iterations: ITERATIONS,
    failedAttempts: 0,
    lockedUntil: 0,
  });
  labelPasskey();
}
let pinAttemptInFlight = false;
export async function verifyPin(pin: string): Promise<boolean> {
  if (pinAttemptInFlight)
    throw new Error("認証を確認しています。少しお待ちください。");
  pinAttemptInFlight = true;
  try {
    const config = getLockConfig();
    if (config.kind !== "pin") return false;
    if (config.lockedUntil > Date.now())
      throw new Error(
        `確認を少しお休みしています。約${Math.ceil((config.lockedUntil - Date.now()) / 1000)}秒後にお試しください。`,
      );
    const salt = decode(config.salt);
    const expected = decode(config.hash);
    if (salt.length !== 16 || expected.length !== 32)
      throw new Error("PIN設定を読み込めませんでした。");
    const valid =
      /^\d{6}$/.test(pin) &&
      constantEqual(await hashPin(pin, salt, config.iterations), expected);
    const failedAttempts = valid
      ? 0
      : Math.min(100_000, config.failedAttempts + 1);
    const wait =
      failedAttempts >= 5
        ? Math.min(900_000, 30_000 * 2 ** Math.min(5, failedAttempts - 5))
        : 0;
    store({
      ...config,
      failedAttempts,
      lockedUntil: valid ? 0 : Date.now() + wait,
    });
    return valid;
  } finally {
    pinAttemptInFlight = false;
  }
}
export function disableLock(): void {
  localStorage.removeItem(STORAGE_KEY);
  labelPasskey();
}
export type DeviceAuthSupport =
  | "available"
  | "insecure-context"
  | "invalid-domain"
  | "unsupported-browser"
  | "not-configured"
  | "check-failed";

export const deviceAuthSupportText: Record<DeviceAuthSupport, string> = {
  available:
    "端末の認証を利用できます。パスキーの保存可否と認証方法は、登録時に端末が確認します。",
  "insecure-context":
    "デバイス認証にはHTTPSの公開URLが必要です。スマートフォンでは公開したURLで開いてください。",
  "invalid-domain":
    "IPアドレスではデバイス認証を設定できません。HTTPSの公開URLで開いてください。",
  "unsupported-browser":
    "このブラウザではデバイス認証を利用できません。対応するブラウザを使うか、6桁PINを設定してください。",
  "not-configured":
    "利用できる端末の認証が見つかりません。端末の画面ロック・指紋の設定を確認し、もう一度確認してください。6桁PINも利用できます。",
  "check-failed":
    "認証への対応状況を確認できませんでした。もう一度確認するか、6桁PINを設定してください。",
};

/** Feature detection only: never infer fingerprint hardware or support from a user agent. */
export async function checkDeviceAuthSupport(): Promise<DeviceAuthSupport> {
  if (!globalThis.isSecureContext || typeof location === "undefined")
    return "insecure-context";
  if (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname) ||
    location.hostname.includes(":")
  )
    return "invalid-domain";
  if (
    typeof PublicKeyCredential === "undefined" ||
    typeof navigator === "undefined" ||
    typeof navigator.credentials?.create !== "function" ||
    typeof navigator.credentials?.get !== "function" ||
    typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !==
      "function"
  )
    return "unsupported-browser";
  try {
    return (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
      ? "available"
      : "not-configured";
  } catch {
    return "check-failed";
  }
}
export async function isDeviceAuthAvailable(): Promise<boolean> {
  return (await checkDeviceAuthSupport()) === "available";
}

/** Small, bounded CBOR reader for authenticator attestation and the COSE ES256 key. */
function readCbor(
  bytes: Uint8Array,
  start = 0,
): { value: unknown; next: number } {
  let offset = start;
  const read = (depth: number): unknown => {
    if (depth > 12 || offset >= bytes.length)
      throw new Error("認証応答の形式を確認できませんでした。");
    const initial = bytes[offset++];
    const major = initial >> 5;
    const additional = initial & 31;
    let length = additional;
    if (additional >= 24) {
      const size =
        additional === 24
          ? 1
          : additional === 25
            ? 2
            : additional === 26
              ? 4
              : 0;
      if (!size || offset + size > bytes.length)
        throw new Error("未対応の認証応答です。");
      length = 0;
      for (let index = 0; index < size; index++)
        length = length * 256 + bytes[offset++];
    }
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2 || major === 3) {
      if (length > 100_000 || offset + length > bytes.length)
        throw new Error("認証応答を読み込めませんでした。");
      const slice = bytes.slice(offset, offset + length);
      offset += length;
      return major === 2 ? slice : new TextDecoder().decode(slice);
    }
    if (major === 4) {
      if (length > 1000) throw new Error("認証応答が大きすぎます。");
      return Array.from({ length }, () => read(depth + 1));
    }
    if (major === 5) {
      if (length > 1000) throw new Error("認証応答が大きすぎます。");
      const map = new Map<unknown, unknown>();
      for (let index = 0; index < length; index++) {
        const key = read(depth + 1);
        map.set(key, read(depth + 1));
      }
      return map;
    }
    if (major === 7 && additional === 20) return false;
    if (major === 7 && additional === 21) return true;
    if (major === 7 && additional === 22) return null;
    throw new Error("未対応の認証応答です。");
  };
  const value = read(0);
  return { value, next: offset };
}
async function validateClientData(
  bytes: ArrayBuffer,
  challenge: Uint8Array,
  type: string,
  origin: string,
): Promise<void> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const client = z
    .object({
      type: z.string(),
      challenge: z.string(),
      origin: z.string(),
      crossOrigin: z.boolean().optional(),
    })
    .passthrough()
    .parse(parsed);
  if (
    client.type !== type ||
    client.origin !== origin ||
    client.crossOrigin === true ||
    !constantEqual(decode(client.challenge), challenge)
  )
    throw new Error(
      "デバイス認証の内容を確認できませんでした。もう一度お試しください。",
    );
}
async function validateAuthenticatorData(
  bytes: Uint8Array,
  rpId: string,
): Promise<number> {
  if (bytes.length < 37 || !(bytes[32] & 0x01) || !(bytes[32] & 0x04))
    throw new Error("デバイスで本人確認を完了してください。");
  const expected = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(rpId)),
  );
  if (!constantEqual(expected, bytes.slice(0, 32)))
    throw new Error("このサイトの認証情報ではありません。");
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(33, false);
}

/** ES256 WebAuthn signatures are ASN.1 DER; Web Crypto verifies 64-byte r||s. */
export function derToRawSignature(
  signature: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (
    signature.length < 8 ||
    signature[0] !== 0x30 ||
    signature[1] !== signature.length - 2
  )
    throw new Error("認証署名の形式を確認できませんでした。");
  let offset = 2;
  const result = new Uint8Array(64);
  for (let part = 0; part < 2; part++) {
    if (signature[offset++] !== 0x02)
      throw new Error("認証署名が正しくありません。");
    const length = signature[offset++];
    if (
      length < 1 ||
      length > 33 ||
      offset + length > signature.length ||
      signature[offset] & 0x80
    )
      throw new Error("認証署名が正しくありません。");
    let integer = signature.slice(offset, offset + length);
    offset += length;
    if (integer.length > 1 && integer[0] === 0) {
      if (!(integer[1] & 0x80)) throw new Error("認証署名が正しくありません。");
      integer = integer.slice(1);
    }
    if (integer.length > 32) throw new Error("認証署名が正しくありません。");
    result.set(integer, part * 32 + 32 - integer.length);
  }
  if (offset !== signature.length)
    throw new Error("認証署名が正しくありません。");
  return result;
}

export async function registerDeviceAuth(): Promise<void> {
  await registerPlatformCredential(false);
}

/** A discoverable credential saved by the platform's passkey provider. */
export async function registerPasskey(): Promise<void> {
  await registerPlatformCredential(true);
}

async function registerPlatformCredential(passkey: boolean): Promise<void> {
  const support = await checkDeviceAuthSupport();
  if (support !== "available") throw new Error(deviceAuthSupportText[support]);
  const rpId = location.hostname;
  const origin = location.origin;
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { id: rpId, name: APP_NAME },
        user: {
          id: crypto.getRandomValues(new Uint8Array(32)),
          name: `${APP_NAME} local`,
          displayName: `${APP_NAME} アプリロック`,
        },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: passkey ? "required" : "discouraged",
          requireResidentKey: passkey,
          userVerification: "required",
        },
        ...(passkey ? { extensions: { credProps: true } } : {}),
        timeout: 60_000,
        attestation: "none",
      },
    });
    if (
      !(credential instanceof PublicKeyCredential) ||
      !(credential.response instanceof AuthenticatorAttestationResponse)
    )
      throw new Error("デバイス認証を完了できませんでした。");
    // Some clients omit credProps. residentKey: required remains authoritative.
    // Explicit failure must not replace the user's existing lock.
    if (
      passkey &&
      credential.getClientExtensionResults().credProps?.rk === false
    )
      throw new Error(
        "この環境ではパスキーを保存できませんでした。デバイス認証または6桁PINを利用できます。",
      );
    await validateClientData(
      credential.response.clientDataJSON,
      challenge,
      "webauthn.create",
      origin,
    );
    const attestation = readCbor(
      new Uint8Array(credential.response.attestationObject),
    ).value;
    if (!(attestation instanceof Map))
      throw new Error("デバイス認証の形式に対応していません。");
    const authData: unknown = attestation.get("authData");
    if (!(authData instanceof Uint8Array))
      throw new Error("デバイス認証の形式に対応していません。");
    const signCount = await validateAuthenticatorData(authData, rpId);
    if (!(authData[32] & 0x40) || authData.length < 55)
      throw new Error("認証鍵を確認できませんでした。");
    const idLength = (authData[53] << 8) | authData[54];
    if (
      idLength < 1 ||
      authData.length < 55 + idLength ||
      !constantEqual(
        authData.slice(55, 55 + idLength),
        new Uint8Array(credential.rawId),
      )
    )
      throw new Error("認証鍵を確認できませんでした。");
    const cose = readCbor(authData, 55 + idLength).value;
    if (
      !(cose instanceof Map) ||
      cose.get(1) !== 2 ||
      cose.get(3) !== -7 ||
      cose.get(-1) !== 1
    )
      throw new Error(
        "この認証鍵の形式には対応していません。PINをご利用ください。",
      );
    const x: unknown = cose.get(-2);
    const y: unknown = cose.get(-3);
    if (
      !(x instanceof Uint8Array) ||
      !(y instanceof Uint8Array) ||
      x.length !== 32 ||
      y.length !== 32
    )
      throw new Error("認証鍵を確認できませんでした。");
    const publicKey = {
      kty: "EC" as const,
      crv: "P-256" as const,
      x: encode(x),
      y: encode(y),
      ext: true as const,
    };
    await crypto.subtle.importKey(
      "jwk",
      publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    store({
      kind: "device",
      credentialId: encode(new Uint8Array(credential.rawId)),
      publicKey,
      rpId,
      origin,
      signCount,
    });
    labelPasskey(
      passkey ? encode(new Uint8Array(credential.rawId)) : undefined,
    );
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "NotAllowedError" || error.name === "AbortError")
    )
      throw new Error(
        "認証がキャンセルされたか、時間内に完了しませんでした。現在のロック設定は変更していません。もう一度お試しください。",
      );
    if (error instanceof Error && !(error instanceof DOMException)) throw error;
    throw new Error(
      passkey
        ? "パスキーを登録できませんでした。端末の画面ロックとパスキーの保存先を確認してください。デバイス認証または6桁PINも利用できます。"
        : "デバイス認証を設定できませんでした。この環境ではPINをご利用ください。",
    );
  }
}
export async function verifyDeviceAuth(): Promise<boolean> {
  const config = getLockConfig();
  if (config.kind !== "device") return false;
  if (config.origin !== location.origin || config.rpId !== location.hostname)
    throw new Error(
      "設定時と異なるURLです。デバイス認証を設定したURLで開いてください。",
    );
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: config.rpId,
        allowCredentials: [
          {
            id: decode(config.credentialId),
            type: "public-key",
            transports: ["internal"],
          },
        ],
        userVerification: "required",
        timeout: 60_000,
      },
    });
    if (
      !(credential instanceof PublicKeyCredential) ||
      !(credential.response instanceof AuthenticatorAssertionResponse) ||
      !constantEqual(
        new Uint8Array(credential.rawId),
        decode(config.credentialId),
      )
    )
      return false;
    await validateClientData(
      credential.response.clientDataJSON,
      challenge,
      "webauthn.get",
      config.origin,
    );
    const authData = new Uint8Array(credential.response.authenticatorData);
    const signCount = await validateAuthenticatorData(authData, config.rpId);
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", credential.response.clientDataJSON),
    );
    const signed = new Uint8Array(authData.length + hash.length);
    signed.set(authData);
    signed.set(hash, authData.length);
    const key = await crypto.subtle.importKey(
      "jwk",
      config.publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      derToRawSignature(new Uint8Array(credential.response.signature)),
      signed,
    );
    // Synchronized authenticators can legitimately keep a zero counter; enforce only
    // monotonic nonzero counters for a credential that is not backup eligible.
    if (
      !valid ||
      (!(authData[32] & 0x08) &&
        config.signCount > 0 &&
        signCount > 0 &&
        signCount <= config.signCount)
    )
      return false;
    store({ ...config, signCount: Math.max(signCount, config.signCount) });
    return true;
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "NotAllowedError" || error.name === "AbortError")
    )
      return false;
    throw new Error(
      "デバイス認証を確認できませんでした。端末の画面ロック設定を確認して、もう一度お試しください。",
    );
  }
}
