import { z } from "zod";
import type { AppData } from "../../types";
import { makeBackupObject, validateBackup } from "./schema";
export { buildCSV, buildExcel } from "./export";
export { validateData } from "./schema";

const ITERATIONS = 600_000;
const MAX_FILE_CHARS = 70_000_000;
const encoder = new TextEncoder();
const encryptedSchema = z
  .object({
    format: z.literal("pace-encrypted"),
    version: z.literal(1),
    algorithm: z.literal("AES-GCM"),
    kdf: z.literal("PBKDF2-SHA256"),
    iterations: z.number().int().min(310_000).max(1_000_000),
    salt: z.string().max(100),
    iv: z.string().max(100),
    ciphertext: z.string().max(MAX_FILE_CHARS),
  })
  .strict();

export function bytesToBase64(bytes: Uint8Array): string {
  let result = "";
  for (let start = 0; start < bytes.length; start += 8192)
    result += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(result);
}
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0)
    throw new Error("Invalid base64");
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
async function deriveKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export function createBackup(data: AppData): string {
  return JSON.stringify(makeBackupObject(data), null, 2);
}
export async function encryptBackup(
  data: AppData,
  password: string,
): Promise<string> {
  if (password.length < 8 || password.length > 1024)
    throw new Error("パスワードは8〜1,024文字で入力してください。");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode("pace-encrypted:v1"),
    },
    key,
    encoder.encode(createBackup(data)),
  );
  return JSON.stringify({
    format: "pace-encrypted",
    version: 1,
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  });
}
export async function parseBackup(
  text: string,
  password?: string,
): Promise<AppData> {
  if (text.length > MAX_FILE_CHARS)
    throw new Error("バックアップのサイズが大きすぎます（最大約50MB）。");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      "このバックアップを読み込めませんでした。ファイルが壊れているか、Paceのバックアップではない可能性があります。",
    );
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "format" in value &&
    value.format === "pace-encrypted"
  ) {
    if (!password)
      throw new Error("暗号化バックアップのパスワードを入力してください。");
    if (password.length > 1024) throw new Error("パスワードが長すぎます。");
    try {
      const envelope = encryptedSchema.parse(value);
      const salt = base64ToBytes(envelope.salt);
      const iv = base64ToBytes(envelope.iv);
      if (salt.byteLength !== 16 || iv.byteLength !== 12)
        throw new Error("Invalid salt or IV");
      const key = await deriveKey(password, salt, envelope.iterations);
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: encoder.encode("pace-encrypted:v1"),
        },
        key,
        base64ToBytes(envelope.ciphertext),
      );
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
      );
    } catch {
      throw new Error(
        "復号できませんでした。パスワードとバックアップファイルを確認してください。",
      );
    }
  }
  try {
    return validateBackup(value);
  } catch {
    throw new Error(
      "このバックアップを復元できません。データ形式・関連付け・バージョンを確認してください。元のデータは変更していません。",
    );
  }
}
