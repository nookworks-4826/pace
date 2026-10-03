import { db, type PaceDatabase } from "../db";
import {
  decryptPayload,
  deriveVaultKeys,
  encryptPayload,
  toBase64,
  VAULT_ITERATIONS,
  type VaultMetadata,
} from "../db/encryption";

const CONTEXT = "pace-vault-check:v1";
const CHECK = "Pace encrypted local storage";
function notify() {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("pace:vault-status"));
}
export function isVaultUnlocked(database: PaceDatabase = db): boolean {
  return database.vaultSession.keys !== null;
}
export async function getVaultStatus(
  database: PaceDatabase = db,
): Promise<{ enabled: boolean; unlocked: boolean }> {
  const metadata = await database.vaultMeta.get("main");
  return {
    enabled: !!metadata,
    unlocked: !!metadata && database.vaultSession.keys?.salt === metadata.salt,
  };
}
export const vaultStatus = getVaultStatus;
export async function initializeVault(
  passphrase: string,
  database: PaceDatabase = db,
): Promise<void> {
  if (passphrase.length < 12 || passphrase.length > 1024)
    throw new Error("パスフレーズは12〜1,024文字で入力してください。");
  if ((await getVaultStatus(database)).enabled)
    throw new Error(
      "保管庫はすでに設定されています。パスフレーズで開いてください。",
    );
  const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
  const keys = await deriveVaultKeys(passphrase, salt);
  const check = await encryptPayload(keys.encryption, CHECK, CONTEXT);
  if (
    (await decryptPayload(
      keys.encryption,
      check.iv,
      check.ciphertext,
      CONTEXT,
    )) !== CHECK
  )
    throw new Error("暗号化を確認できませんでした。");
  const metadata: VaultMetadata = {
    id: "main",
    format: "pace-vault",
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations: VAULT_ITERATIONS,
    salt,
    checkIv: check.iv,
    checkCiphertext: check.ciphertext,
  };
  try {
    await database.transaction("rw", database.tables, async () => {
      if (await database.vaultMeta.get("main"))
        throw new Error(
          "別の画面で保管庫が設定されました。開き直してください。",
        );
      const tables = database.tables.filter(
        (table) => table.name !== "vaultMeta",
      );
      const rows = await Promise.all(tables.map((table) => table.toArray()));
      if (rows.some((entries) => entries.some((row) => row?.__paceVault === 1)))
        throw new Error(
          "暗号化設定が見つかりません。記録は変更していません。元のバックアップから復元してください。",
        );
      database.vaultSession.keys = keys;
      database.vaultSession.migrating = true;
      for (let position = 0; position < tables.length; position++) {
        await tables[position].clear();
        // The middleware keeps only crypto work alive; database requests stay
        // in this transaction so no half-migrated state can commit.
        for (let offset = 0; offset < rows[position].length; offset += 100)
          await tables[position].bulkPut(
            rows[position].slice(offset, offset + 100),
          );
        // Read the encrypted rows back before commit. A failed round trip aborts
        // every table, leaving the complete legacy database intact.
        const restored = await tables[position].toArray();
        const original = rows[position]
          .map((row) => JSON.stringify(row))
          .sort();
        const recovered = restored.map((row) => JSON.stringify(row)).sort();
        if (
          original.length !== recovered.length ||
          original.some((row, index) => row !== recovered[index])
        )
          throw new Error("暗号化後の記録を確認できませんでした。");
      }
      await database.vaultMeta.put(metadata);
    });
    database.vaultSession.migrating = false;
    notify();
  } catch (error) {
    database.vaultSession.keys = null;
    database.vaultSession.migrating = false;
    database.vaultSession.hashes.clear();
    throw error;
  }
}
export async function unlockVault(
  passphrase: string,
  database: PaceDatabase = db,
): Promise<void> {
  const metadata = await database.vaultMeta.get("main");
  if (!metadata) throw new Error("端末内暗号化がまだ設定されていません。");
  try {
    if (
      metadata.format !== "pace-vault" ||
      metadata.version !== 1 ||
      metadata.kdf !== "PBKDF2-SHA256"
    )
      throw new Error();
    const keys = await deriveVaultKeys(
      passphrase,
      metadata.salt,
      metadata.iterations,
    );
    if (
      (await decryptPayload(
        keys.encryption,
        metadata.checkIv,
        metadata.checkCiphertext,
        CONTEXT,
      )) !== CHECK
    )
      throw new Error();
    database.vaultSession.keys = keys;
    database.vaultSession.hashes.clear();
    notify();
  } catch {
    throw new Error(
      "保管庫を開けませんでした。パスフレーズを確認してください。記録は変更していません。",
    );
  }
}
export function lockVault(database: PaceDatabase = db): void {
  database.vaultSession.keys = null;
  database.vaultSession.hashes.clear();
  notify();
}
