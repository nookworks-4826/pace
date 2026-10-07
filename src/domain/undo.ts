import Dexie from "dexie";
import type { Transaction } from "dexie";
import { db, readAppData, type PaceDatabase } from "../db";
import { validateData } from "./backup/schema";

const allowed = new Set([
  "settings",
  "favorites",
  "expenses",
  "incomes",
  "transfers",
  "accounts",
  "accountAdjustments",
  "balanceAdjustments",
  "cardPayments",
  "merchantRules",
  "recurringOccurrences",
  "receipts",
  "externalTransactions",
  "expenseInbox",
]);
type SavedRow = Record<string, unknown> | undefined;
interface Change {
  table: string;
  key: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}
export interface RecentChange {
  id: string;
  label: string;
  createdAt: string;
  changes: Change[];
  undone?: boolean;
}
type Tracked = Transaction & { paceChanges?: Map<string, Change> };
const installed = new WeakSet<PaceDatabase>();
function comparable(row: SavedRow): SavedRow {
  if (!row) return undefined;
  const copy = structuredClone(row);
  // Images stay in their encrypted receipt store; undo stores only the relationship.
  delete copy.imageBase64;
  return copy;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            stable((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "undefined";
}
function tracker(tx: Transaction): Map<string, Change> | undefined {
  for (
    let current: Tracked | null = tx as Tracked;
    current;
    current = current.parent as Tracked | null
  )
    if (current.paceChanges) return current.paceChanges;
}
export function installUndoTracking(database: PaceDatabase = db) {
  if (installed.has(database)) return;
  installed.add(database);
  for (const table of database.tables.filter((t) => allowed.has(t.name))) {
    const capture = (key: unknown, row: SavedRow, tx: Transaction) => {
      const changes = tracker(tx);
      if (!changes || typeof key !== "string") return;
      const name = table.name + "\u0000" + key;
      if (!changes.has(name))
        changes.set(name, { table: table.name, key, before: comparable(row) });
    };
    table.hook("creating", function (key, row, tx) {
      capture(
        key ?? row[table.schema.primKey.keyPath as string],
        undefined,
        tx,
      );
    });
    table.hook("updating", function (_changes, key, row, tx) {
      capture(key, row, tx);
    });
    table.hook("deleting", function (key, row, tx) {
      capture(key, row, tx);
    });
  }
}
/** Capture just modified records, atomically with the operation, never the whole ledger. */
export async function withUndo<T>(
  label: string,
  action: () => Promise<T>,
  database: PaceDatabase = db,
): Promise<{ value: T; id: string }> {
  installUndoTracking(database);
  return database.transaction("rw", database.tables, async () => {
    const tx = Dexie.currentTransaction as Tracked;
    if (tracker(tx)) throw new Error("操作を重ねて記録できません。");
    const changes = new Map<string, Change>();
    tx.paceChanges = changes;
    const value = await action();
    delete tx.paceChanges;
    for (const change of changes.values())
      change.after = comparable(
        await database.table(change.table).get(change.key),
      );
    const rows = [...changes.values()].filter(
      (c) => stable(c.before) !== stable(c.after),
    );
    const id = "undo:" + crypto.randomUUID();
    if (rows.length) {
      const entry: RecentChange = {
        id,
        label,
        createdAt: new Date().toISOString(),
        changes: rows,
      };
      await database.drafts.put({ id, value: JSON.stringify(entry) });
      const history = await recentChanges(database);
      await database.drafts.bulkDelete(history.slice(20).map((row) => row.id));
    }
    return { value, id: rows.length ? id : "" };
  });
}
export async function recentChanges(
  database: PaceDatabase = db,
): Promise<RecentChange[]> {
  const rows = await database.drafts.toArray();
  return rows
    .filter((r) => r.id.startsWith("undo:"))
    .map((r) => JSON.parse(r.value) as RecentChange)
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
}
export async function undoChange(id: string, database: PaceDatabase = db) {
  await database.transaction("rw", database.tables, async () => {
    const stored = await database.drafts.get(id);
    if (!stored) throw new Error("この操作はもう戻せません。");
    const entry = JSON.parse(stored.value) as RecentChange;
    if (
      entry.undone ||
      !Array.isArray(entry.changes) ||
      entry.changes.length > 1000
    )
      throw new Error("この操作はもう戻せません。");
    for (const c of entry.changes) {
      if (!allowed.has(c.table) || typeof c.key !== "string")
        throw new Error("操作の記録を確認できません。");
      const current = comparable(await database.table(c.table).get(c.key));
      if (stable(current) !== stable(c.after))
        throw new Error(
          "この後に関連する記録が変わりました。上書きせず、履歴で確認してください。",
        );
    }
    for (const c of [...entry.changes].reverse()) {
      const table = database.table(c.table);
      if (c.before) {
        const current = await table.get(c.key);
        await table.put(
          c.table === "receipts" ? { ...current, ...c.before } : c.before,
        );
      } else if (c.table === "receipts") {
        // Keep explicitly saved images; remove only their now-missing expense link.
        const current = await table.get(c.key);
        if (current) await table.put({ ...current, expenseId: undefined });
      } else await table.delete(c.key);
    }
    // All references are checked before commit; a conflict rolls the whole undo back.
    validateData(await readAppData(true, database));
    await database.drafts.put({
      id,
      value: JSON.stringify({ ...entry, undone: true }),
    });
  });
}
