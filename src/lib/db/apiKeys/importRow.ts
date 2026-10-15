/**
 * db/apiKeys/importRow.ts — builds the INSERT for restoring an API key from a JSON backup.
 *
 * GHSA-p42h-25v7-99v5: the importer used to write 8 hand-picked columns, so every other column
 * (revoked_at, expires_at, is_banned, is_active, scopes, ip_allowlist, allowed_connections,
 * rate/usage limits, ...) fell back to its default and a revoked, expired or banned key became
 * valid again with its restrictions gone. The column list is now derived from the live
 * `api_keys` schema: every column the backup carries (the export is `getApiKeys()` -> camelCase)
 * is restored, so a column added by a future migration is not silently dropped.
 *
 * A column the backup does not carry keeps the table default (older backups import as before).
 */

import type { SqliteAdapter } from "../adapters/types";
import { parseModelAccessMode } from "./modelAccessMode";

type ColumnInfo = { name: string; notnull: number };

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_match, ch: string) => ch.toUpperCase());
}

function toSqliteValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  return JSON.stringify(value);
}

export function insertImportedApiKey(db: SqliteAdapter, apiKey: Record<string, unknown>): void {
  const columns = db.prepare("PRAGMA table_info(api_keys)").all() as ColumnInfo[];
  const allowedModels = Array.isArray(apiKey.allowedModels) ? apiKey.allowedModels : [];
  const params: Record<string, string | number | null> = {};

  for (const column of columns) {
    const field = snakeToCamel(column.name);
    if (!Object.hasOwn(apiKey, field) || apiKey[field] === undefined) continue;
    const value = toSqliteValue(apiKey[field]);
    // A NULL for a NOT NULL column must fall back to the column default, not abort the restore.
    if (value === null && column.notnull) continue;
    params[column.name] = value;
  }

  // Fields whose stored form is normalized (kept from the previous importer).
  params.model_access_mode = parseModelAccessMode(apiKey.modelAccessMode, allowedModels);
  params.allowed_models = JSON.stringify(allowedModels);
  params.no_log = apiKey.noLog ? 1 : 0;
  params.machine_id = (apiKey.machineId as string | null | undefined) ?? null;
  params.created_at = (apiKey.createdAt as string | undefined) ?? new Date().toISOString();

  const names = Object.keys(params);
  const sql =
    `INSERT OR REPLACE INTO api_keys (${names.map((n) => `"${n}"`).join(", ")}) ` +
    `VALUES (${names.map((n) => `@${n}`).join(", ")})`;
  db.prepare(sql).run(params);
}
