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
  migrating: boolean;
  hashes: Map<string, string>;
}
export const VAULT_ITERATIONS = 600_000;
const encoder = new TextEncoder();
const LOCKED =
  "端末内データを開くには、保管庫のパスフレーズを入力してください。";
function hold<T>(work: () => Promise<T>): Promise<T> {
  return Dexie.waitFor(work());
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
      const hash = async (
        table: string,
        path: string,
        value: unknown,
      ): Promise<string> => {
        if (!session.keys) throw new Error(LOCKED);
        const input = JSON.stringify([table, path, value]);
        const existing = session.hashes.get(input);
        if (existing) return existing;
        const result = toBase64(
          new Uint8Array(
            await crypto.subtle.sign(
              "HMAC",
              session.keys.index,
              encoder.encode(`pace-vault-index:v1:${input}`),
            ),
          ),
        );
        // Bound the cache; plaintext index inputs are never persisted.
        if (session.hashes.size > 25_000) session.hashes.clear();
        session.hashes.set(input, result);
        return result;
      };
      const keyFor = (
        table: string,
        index: DBCoreIndex,
        value: unknown,
      ): Promise<unknown> => {
        const path = index.keyPath;
        if (Array.isArray(path))
          return Promise.all(
            path.map((part, position) =>
              hash(table, part, (value as unknown[])[position]),
            ),
          );
        return hash(table, path ?? ":id", value);
      };
      const rangeFor = async (
        table: string,
        index: DBCoreIndex,
        range: DBCoreKeyRange,
      ): Promise<DBCoreKeyRange> => {
        if (range.type === 3 || range.type === 4) return range;
        if (range.type !== 1)
          throw new Error(
            "暗号化した索引は範囲検索できません。読み込んだ記録から検索してください。",
          );
        return {
          type: 1,
          lower: await keyFor(table, index, range.lower),
          upper: await keyFor(table, index, range.upper),
        };
      };
      const enabled = async (
        trans: Parameters<DBCoreTable["get"]>[0]["trans"],
      ): Promise<boolean> => {
        const meta: VaultMetadata | undefined = await metaTable.get({
          trans,
          key: "main",
        });
        if (!meta && !session.migrating) return false;
        if (!session.keys || (meta && session.keys.salt !== meta.salt))
          throw new Error(LOCKED);
        return true;
      };
      const encryptRow = async (
        table: DBCoreTable,
        row: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        if (!session.keys) throw new Error(LOCKED);
        const result: Record<string, unknown> = { __paceVault: 1 };
        const indexes = [table.schema.primaryKey, ...table.schema.indexes];
        for (const index of indexes) {
          const paths = Array.isArray(index.keyPath)
            ? index.keyPath
            : [index.keyPath];
          for (const path of paths)
            if (path && row[path] !== undefined)
              result[path] = await hash(table.name, path, row[path]);
        }
        const primary = table.schema.primaryKey.extractKey!(result);
        const payload = await encryptPayload(
          session.keys.encryption,
          JSON.stringify(row),
          JSON.stringify(["pace-vault-row:v1", table.name, primary]),
        );
        result.__iv = payload.iv;
        result.__ciphertext = payload.ciphertext;
        return result;
      };
      const decryptRow = async (
        table: DBCoreTable,
        row: unknown,
      ): Promise<unknown> => {
        if (row === undefined || row === null) return row;
        if (!session.keys) throw new Error(LOCKED);
        const record = row as Record<string, unknown>;
        if (
          record.__paceVault !== 1 ||
          typeof record.__iv !== "string" ||
          typeof record.__ciphertext !== "string"
        )
          throw new Error("暗号化した記録の形式を確認できませんでした。");
        const primary = table.schema.primaryKey.extractKey!(record);
        try {
          const payload: Record<string, unknown> = JSON.parse(
            await decryptPayload(
              session.keys.encryption,
              record.__iv,
              record.__ciphertext,
              JSON.stringify(["pace-vault-row:v1", table.name, primary]),
            ),
          );
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
              if (
                path &&
                record[path] !==
                  (payload[path] === undefined
                    ? undefined
                    : await hash(table.name, path, payload[path]))
              )
                throw new Error("Index integrity check failed");
          }
          return payload;
        } catch {
          throw new Error(
            "暗号化した記録を読み込めませんでした。元のデータは変更していません。",
          );
        }
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
          if (name === "vaultMeta") return table;
          return {
            ...table,
            get(req) {
              return hold(async () =>
                (await enabled(req.trans))
                  ? decryptRow(
                      table,
                      await table.get({
                        ...req,
                        key: await keyFor(
                          name,
                          table.schema.primaryKey,
                          req.key,
                        ),
                      }),
                    )
                  : table.get(req),
              );
            },
            getMany(req) {
              return hold(async () => {
                if (!(await enabled(req.trans))) return table.getMany(req);
                const rows = await table.getMany({
                  ...req,
                  keys: await Promise.all(
                    req.keys.map((key) =>
                      keyFor(name, table.schema.primaryKey, key),
                    ),
                  ),
                });
                return Promise.all(rows.map((row) => decryptRow(table, row)));
              });
            },
            query(req) {
              return hold(async () => {
                if (!(await enabled(req.trans))) return table.query(req);
                const response = await table.query({
                  ...req,
                  values: true,
                  query: {
                    ...req.query,
                    range: await rangeFor(
                      name,
                      req.query.index,
                      req.query.range,
                    ),
                  },
                });
                const rows = await Promise.all(
                  response.result.map((row) => decryptRow(table, row)),
                );
                return {
                  result:
                    req.values === false
                      ? rows.map((row) =>
                          table.schema.primaryKey.extractKey!(row),
                        )
                      : rows,
                };
              });
            },
            count(req) {
              return hold(async () =>
                !(await enabled(req.trans))
                  ? table.count(req)
                  : table.count({
                      ...req,
                      query: {
                        ...req.query,
                        range: await rangeFor(
                          name,
                          req.query.index,
                          req.query.range,
                        ),
                      },
                    }),
              );
            },
            mutate(req) {
              return hold(async () => {
                if (!(await enabled(req.trans))) {
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
                  const values = await Promise.all(
                    req.values.map((row) => encryptRow(table, row)),
                  );
                  const response = await table.mutate({
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
                  });
                  return {
                    ...response,
                    results: response.results?.map(
                      (_key, position) => logicalKeys[position],
                    ),
                    lastResult: logicalKeys[logicalKeys.length - 1],
                  };
                }
                if (req.type === "delete")
                  return table.mutate({
                    ...req,
                    keys: await Promise.all(
                      req.keys.map((key) =>
                        keyFor(name, table.schema.primaryKey, key),
                      ),
                    ),
                    criteria: undefined,
                  });
                return table.mutate({
                  ...req,
                  range: await rangeFor(
                    name,
                    table.schema.primaryKey,
                    req.range,
                  ),
                });
              });
            },
            openCursor(req) {
              return hold(async () => {
                if (!(await enabled(req.trans))) return table.openCursor(req);
                const cursor = await table.openCursor({
                  ...req,
                  values: true,
                  query: {
                    ...req.query,
                    range: await rangeFor(
                      name,
                      req.query.index,
                      req.query.range,
                    ),
                  },
                });
                if (!cursor) return null;
                let value: unknown = await decryptRow(table, cursor.value);
                const refresh = async () => {
                  value = cursor.done
                    ? undefined
                    : await decryptRow(table, cursor.value);
                };
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
                      void Dexie.waitFor(
                        keyFor(name, req.query.index, key),
                      ).then(
                        (hashed) => cursor.continue(hashed),
                        (error) => cursor.fail(error),
                      );
                  },
                  continuePrimaryKey(key, primaryKey) {
                    void Dexie.waitFor(
                      Promise.all([
                        keyFor(name, req.query.index, key),
                        keyFor(name, table.schema.primaryKey, primaryKey),
                      ]),
                    ).then(
                      ([k, p]) => cursor.continuePrimaryKey(k, p),
                      (error) => cursor.fail(error),
                    );
                  },
                  advance(count) {
                    cursor.advance(count);
                  },
                  start(onNext) {
                    return cursor.start(() => {
                      void Dexie.waitFor(refresh()).then(onNext, (error) =>
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
                  async next() {
                    await cursor.next();
                    await Dexie.waitFor(refresh());
                    return wrapper;
                  },
                };
                return wrapper;
              });
            },
          } satisfies DBCoreTable;
        },
      };
    },
  });
}
