import Dexie, {
  type DBCore,
  type DBCoreCursor,
  type DBCoreIndex,
  type DBCoreKeyRange,
  type DBCoreTable,
  type Table,
} from "dexie";

export interface VaultMetadata {
  id: "main";
  format: "pace-vault";
  version: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  checkIv: string;
  checkCiphertext: string;
}
export interface VaultKeys {
  encryption: CryptoKey;
  index: CryptoKey;
  salt: string;
}
export interface VaultSession {
  keys: VaultKeys | null;
  readOnly?: boolean;
  migrating: boolean;
  hashes: Map<string, string>;
}
export const VAULT_ITERATIONS = 600_000;
const encoder = new TextEncoder();
const LOCKED =
  "端末内データを開くには、保管庫のパスフレーズを入力してください。";
// Dexie's keep-alive waits must not overlap on one IndexedDB transaction.
// Queue only crypto work, and start the next wait after the prior wait has
// resumed in an active transaction. Database requests run outside these waits.
const cryptoWaits = new WeakMap<IDBTransaction, Promise<void>>();
function holdCrypto<T>(work: () => Promise<T>): Promise<T> {
  const transaction = Dexie.currentTransaction;
  if (!transaction) return work();
  const previous = cryptoWaits.get(transaction.idbtrans);
  const result = previous
    ? previous.then(() => Dexie.waitFor(work()))
    : Dexie.waitFor(work());
  cryptoWaits.set(
    transaction.idbtrans,
    result.then(
      () => {},
      () => {},
    ),
  );
  return result;
}
export function toBase64(bytes: Uint8Array): string {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}
export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0)
    throw new Error("保管庫の形式を確認できませんでした。");
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export async function deriveVaultKeys(
  passphrase: string,
  salt: string,
  iterations = VAULT_ITERATIONS,
): Promise<VaultKeys> {
  if (
    passphrase.length > 1024 ||
    !Number.isInteger(iterations) ||
    iterations < 600_000 ||
    iterations > 1_200_000
  )
    throw new Error("保管庫の設定を確認してください。");
  const saltBytes = fromBase64(salt);
  if (saltBytes.length !== 16)
    throw new Error("保管庫の設定を確認してください。");
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
      material,
      512,
    ),
  );
  try {
    return {
      encryption: await crypto.subtle.importKey(
        "raw",
        bits.slice(0, 32),
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      ),
      index: await crypto.subtle.importKey(
        "raw",
        bits.slice(32),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      salt,
    };
  } finally {
    bits.fill(0);
  }
}
export async function encryptPayload(
  key: CryptoKey,
  value: string,
  context: string,
): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    key,
    encoder.encode(value),
  );
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}
export async function decryptPayload(
  key: CryptoKey,
  iv: string,
  ciphertext: string,
  context: string,
): Promise<string> {
  const ivBytes = fromBase64(iv);
  if (ivBytes.length !== 12)
    throw new Error("保管庫の形式を確認できませんでした。");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes, additionalData: encoder.encode(context) },
    key,
    fromBase64(ciphertext),
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(plain);
}

/** Encrypt complete records and blind every persistent index. Keys only live in this tab. */
export function installVaultMiddleware(
  database: Dexie & { vaultMeta: Table<VaultMetadata, string> },
  session: VaultSession,
): void {
  database.use({
    stack: "dbcore",
    name: "PaceVault",
    level: -0.5,
    create(down: DBCore) {
      // Dexie constructs an intermediate core for the old schema while opening
      // an existing v1/v2 database. Its upgrade has not created vaultMeta yet.
      // The final v3 core installs encryption before any app operation starts.
      if (!down.schema.tables.some((table) => table.name === "vaultMeta"))
        return down;
      const metaTable = down.table("vaultMeta");
      const hash = (
        table: string,
        path: string,
        value: unknown,
      ): Promise<string> => {
        if (!session.keys) throw new Error(LOCKED);
        const keys = session.keys;
        const input = JSON.stringify([table, path, value]);
        const existing = session.hashes.get(input);
        if (existing) return Dexie.Promise.resolve(existing);
        return holdCrypto(() =>
          crypto.subtle.sign(
            "HMAC",
            keys.index,
            encoder.encode(`pace-vault-index:v1:${input}`),
          ),
        ).then((signed) => {
          const result = toBase64(new Uint8Array(signed));
          // Bound the cache; plaintext index inputs are never persisted.
          if (session.hashes.size > 25_000) session.hashes.clear();
          session.hashes.set(input, result);
          return result;
        });
      };
      const keyFor = (
        table: string,
        index: DBCoreIndex,
        value: unknown,
      ): Promise<unknown> => {
        const path = index.keyPath;
        if (Array.isArray(path))
          return Dexie.Promise.all(
            path.map((part, position) =>
              hash(table, part, (value as unknown[])[position]),
            ),
          );
        return hash(table, path ?? ":id", value);
      };
      const rangeFor = (
        table: string,
        index: DBCoreIndex,
        range: DBCoreKeyRange,
      ): Promise<DBCoreKeyRange> => {
        if (range.type === 3 || range.type === 4)
          return Dexie.Promise.resolve(range);
        if (range.type !== 1)
          throw new Error(
            "暗号化した索引は範囲検索できません。読み込んだ記録から検索してください。",
          );
        return keyFor(table, index, range.lower).then((lower) =>
          keyFor(table, index, range.upper).then((upper) => ({
            type: 1,
            lower,
            upper,
          })),
        );
      };
      const enabled = (
        trans: Parameters<DBCoreTable["get"]>[0]["trans"],
      ): Promise<boolean> => {
        return metaTable
          .get({
            trans,
            key: "main",
          })
          .then((meta: VaultMetadata | undefined) => {
            if (!meta && !session.migrating) return false;
            if (!session.keys || (meta && session.keys.salt !== meta.salt))
              throw new Error(LOCKED);
            return true;
          });
      };
      const encryptRow = (
        table: DBCoreTable,
        row: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        if (!session.keys) throw new Error(LOCKED);
        const keys = session.keys;
        const result: Record<string, unknown> = { __paceVault: 1 };
        let indexed = Dexie.Promise.resolve();
        const indexes = [table.schema.primaryKey, ...table.schema.indexes];
        for (const index of indexes) {
          const paths = Array.isArray(index.keyPath)
            ? index.keyPath
            : [index.keyPath];
          for (const path of paths)
            if (path && row[path] !== undefined)
              indexed = indexed.then(() =>
                hash(table.name, path, row[path]).then((hashed) => {
                  result[path] = hashed;
                }),
              );
        }
        return indexed.then(() => {
          const primary = table.schema.primaryKey.extractKey!(result);
          return holdCrypto(() =>
            encryptPayload(
              keys.encryption,
              JSON.stringify(row),
              JSON.stringify(["pace-vault-row:v1", table.name, primary]),
            ),
          ).then((payload) => {
            result.__iv = payload.iv;
            result.__ciphertext = payload.ciphertext;
            return result;
          });
        });
      };
      const decryptRow = (
        table: DBCoreTable,
        row: unknown,
      ): Promise<unknown> => {
        if (row === undefined || row === null)
          return Dexie.Promise.resolve(row);
        if (!session.keys) throw new Error(LOCKED);
        const keys = session.keys;
        const record = row as Record<string, unknown>;
        if (
          record.__paceVault !== 1 ||
          typeof record.__iv !== "string" ||
          typeof record.__ciphertext !== "string"
        )
          throw new Error("暗号化した記録の形式を確認できませんでした。");
        const iv = record.__iv;
        const ciphertext = record.__ciphertext;
        const primary = table.schema.primaryKey.extractKey!(record);
        return holdCrypto(() =>
          decryptPayload(
            keys.encryption,
            iv,
            ciphertext,
            JSON.stringify(["pace-vault-row:v1", table.name, primary]),
          ),
        )
          .then((plain) => {
            const payload: Record<string, unknown> = JSON.parse(plain);
            let verified = Dexie.Promise.resolve();
            // Authenticate index/payload consistency too. Tampering with a blind
            // secondary key must not make an unrelated record match an equality query.
            for (const index of [
              table.schema.primaryKey,
              ...table.schema.indexes,
            ]) {
              const paths = Array.isArray(index.keyPath)
                ? index.keyPath
                : [index.keyPath];
              for (const path of paths)
                if (path) {
                  verified = verified.then(() =>
                    (payload[path] === undefined
                      ? Dexie.Promise.resolve(undefined)
                      : hash(table.name, path, payload[path])
                    ).then((hashed) => {
                      if (record[path] !== hashed)
                        throw new Error("Index integrity check failed");
                    }),
                  );
                }
            }
            return verified.then(() => payload);
          })
          .catch(() => {
            throw new Error(
              "暗号化した記録を読み込めませんでした。元のデータは変更していません。",
            );
          });
      };
      return {
        ...down,
        transaction(stores, mode, options) {
          return down.transaction(
            stores.includes("vaultMeta") ? stores : [...stores, "vaultMeta"],
            mode,
            options,
          );
        },
        table(name) {
          const table = down.table(name);
          if (name === "vaultMeta")
            return {
              ...table,
              mutate(req) {
                if (session.readOnly)
                  throw new Error(
                    "確認が必要なため、書き込みを停止しています。",
                  );
                return table.mutate(req);
              },
            };
          return {
            ...table,
            get(req) {
              return enabled(req.trans).then((active) => {
                if (!active) return table.get(req);
                return keyFor(name, table.schema.primaryKey, req.key)
                  .then((key) => table.get({ ...req, key }))
                  .then((row) => decryptRow(table, row));
              });
            },
            getMany(req) {
              return enabled(req.trans).then((active) => {
                if (!active) return table.getMany(req);
                return Dexie.Promise.all(
                  req.keys.map((key) =>
                    keyFor(name, table.schema.primaryKey, key),
                  ),
                )
                  .then((keys) => table.getMany({ ...req, keys }))
                  .then((rows) =>
                    Dexie.Promise.all(
                      rows.map((row) => decryptRow(table, row)),
                    ),
                  );
              });
            },
            query(req) {
              return enabled(req.trans).then((active) => {
                if (!active) return table.query(req);
                return rangeFor(name, req.query.index, req.query.range)
                  .then((range) =>
                    table.query({
                      ...req,
                      values: true,
                      query: { ...req.query, range },
                    }),
                  )
                  .then((response) =>
                    Dexie.Promise.all(
                      response.result.map((row) => decryptRow(table, row)),
                    ),
                  )
                  .then((rows) => ({
                    result:
                      req.values === false
                        ? rows.map((row) =>
                            table.schema.primaryKey.extractKey!(row),
                          )
                        : rows,
                  }));
              });
            },
            count(req) {
              return enabled(req.trans).then((active) => {
                if (!active) return table.count(req);
                return rangeFor(name, req.query.index, req.query.range).then(
                  (range) =>
                    table.count({ ...req, query: { ...req.query, range } }),
                );
              });
            },
            mutate(req) {
              if (session.readOnly)
                throw new Error("確認が必要なため、書き込みを停止しています。");
              return enabled(req.trans).then((active) => {
                if (!active) {
                  if (
                    name === "providerCredentials" &&
                    (req.type === "add" || req.type === "put")
                  )
                    throw new Error(
                      "金融認証情報を保存する前に端末内暗号化を設定してください。",
                    );
                  return table.mutate(req);
                }
                if (req.type === "add" || req.type === "put") {
                  const logicalKeys = req.values.map((row) =>
                    table.schema.primaryKey.extractKey!(row),
                  );
                  return Dexie.Promise.all(
                    req.values.map((row) => encryptRow(table, row)),
                  )
                    .then((values) =>
                      table.mutate({
                        ...req,
                        values,
                        keys: undefined,
                        ...(req.type === "put"
                          ? {
                              updates: undefined,
                              criteria: undefined,
                              changeSpec: undefined,
                              upsert: undefined,
                            }
                          : {}),
                      }),
                    )
                    .then((response) => ({
                      ...response,
                      results: response.results?.map(
                        (_key, position) => logicalKeys[position],
                      ),
                      lastResult: logicalKeys[logicalKeys.length - 1],
                    }));
                }
                if (req.type === "delete")
                  return Dexie.Promise.all(
                    req.keys.map((key) =>
                      keyFor(name, table.schema.primaryKey, key),
                    ),
                  ).then((keys) =>
                    table.mutate({
                      ...req,
                      keys,
                      criteria: undefined,
                    }),
                  );
                return rangeFor(name, table.schema.primaryKey, req.range).then(
                  (range) =>
                    table.mutate({
                      ...req,
                      range,
                    }),
                );
              });
            },
            openCursor(req) {
              return enabled(req.trans).then((active) => {
                if (!active) return table.openCursor(req);
                return rangeFor(name, req.query.index, req.query.range)
                  .then((range) =>
                    table.openCursor({
                      ...req,
                      values: true,
                      query: {
                        ...req.query,
                        range,
                      },
                    }),
                  )
                  .then((cursor) => {
                    if (!cursor) return null;
                    return decryptRow(table, cursor.value).then(
                      (initialValue) => {
                        let value: unknown = initialValue;
                        const refresh = () =>
                          (cursor.done
                            ? Dexie.Promise.resolve(undefined)
                            : decryptRow(table, cursor.value)
                          ).then((nextValue) => {
                            value = nextValue;
                          });
                        const wrapper: DBCoreCursor = {
                          get trans() {
                            return cursor.trans;
                          },
                          get done() {
                            return cursor.done;
                          },
                          get value() {
                            return req.values === false ? undefined : value;
                          },
                          get key() {
                            return value === undefined
                              ? undefined
                              : req.query.index.extractKey!(value);
                          },
                          get primaryKey() {
                            return value === undefined
                              ? undefined
                              : table.schema.primaryKey.extractKey!(value);
                          },
                          continue(key) {
                            if (key === undefined) cursor.continue();
                            else
                              void keyFor(name, req.query.index, key).then(
                                (hashed) => cursor.continue(hashed),
                                (error) => cursor.fail(error),
                              );
                          },
                          continuePrimaryKey(key, primaryKey) {
                            void Dexie.Promise.all([
                              keyFor(name, req.query.index, key),
                              keyFor(name, table.schema.primaryKey, primaryKey),
                            ]).then(
                              ([k, p]) => cursor.continuePrimaryKey(k, p),
                              (error) => cursor.fail(error),
                            );
                          },
                          advance(count) {
                            cursor.advance(count);
                          },
                          start(onNext) {
                            return cursor.start(() => {
                              void refresh().then(onNext, (error) =>
                                cursor.fail(error),
                              );
                            });
                          },
                          stop(result) {
                            cursor.stop(result);
                          },
                          fail(error) {
                            cursor.fail(error);
                          },
                          next() {
                            return cursor
                              .next()
                              .then(refresh)
                              .then(() => wrapper);
                          },
                        };
                        return wrapper;
                      },
                    );
                  });
              });
            },
          } satisfies DBCoreTable;
        },
      };
    },
  });
}
