/**
 * db/providers/secretFields.ts — at-rest encryption of the credential-bearing fields
 * inside `provider_connections.provider_specific_data`.
 *
 * `api_key` / `access_token` / … are stored as `enc:v1:` envelopes by
 * encryptConnectionFields, but provider_specific_data is a JSON blob that used to be
 * written verbatim — so the rotation pool (`extraApiKeys[]`), provider cookies and
 * refresh sub-tokens sat in plaintext next to the encrypted primary key. These helpers
 * envelope every string (or string[]) value stored under a key of the shared
 * PROVIDER_SPECIFIC_DATA_SECRET_KEYS denylist on the way to SQLite and decrypt it on the
 * way out, so every caller of the providers module (rotator, executors, exports) keeps
 * seeing plaintext in memory. The same constant drives the API response sanitizer.
 *
 * Pure: only the encryption primitives and the shared constant. The first-use sweep of
 * legacy plaintext rows lives in ./migrations.ts next to the other in-module passes.
 *
 * Mirrors encryptConnectionFields: with STORAGE_ENCRYPTION_KEY unset nothing changes, and
 * encrypt() never re-wraps an `enc:v1:` value, so re-serializing a row is idempotent.
 */

import { decryptQuiet, encrypt, isEncryptionEnabled, looksEncrypted } from "../encryption";
import { PROVIDER_SPECIFIC_DATA_SECRET_KEYS } from "@/shared/constants/providerSpecificDataSecrets";

type JsonRecord = Record<string, unknown>;

export interface SecretFieldMeta {
  connectionId: string;
  provider: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Apply `fn` to a string value, or to each string element of an array. Returns the input
 * itself when nothing changed (callers use identity to skip copying). A null/undefined
 * result for an array element drops that element — an undecryptable token must never be
 * sent upstream as if it were a key.
 */
function mapSecretStrings(
  value: unknown,
  fn: (plain: string) => string | null | undefined
): unknown {
  if (typeof value === "string") return fn(value);
  if (!Array.isArray(value)) return value;
  let changed = false;
  const next: unknown[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      next.push(entry);
      continue;
    }
    const mapped = fn(entry);
    if (mapped !== entry) changed = true;
    if (mapped === null || mapped === undefined) continue;
    next.push(mapped);
  }
  return changed ? next : value;
}

/** Copy-on-write over the secret keys: the input object is never mutated. */
function mapSecretFields(psd: unknown, fn: (key: string, value: unknown) => unknown): unknown {
  if (!isRecord(psd)) return psd;
  let copy: JsonRecord | null = null;
  for (const key of PROVIDER_SPECIFIC_DATA_SECRET_KEYS) {
    if (!(key in psd)) continue;
    const value = psd[key];
    const next = fn(key, value);
    if (next === value) continue;
    copy ??= { ...psd };
    copy[key] = next;
  }
  return copy ?? psd;
}

/** Returns a copy with every secret string / string[] value enveloped (input untouched). */
export function encryptProviderSpecificDataSecrets(psd: unknown): unknown {
  if (!isEncryptionEnabled()) return psd;
  return mapSecretFields(psd, (_key, value) =>
    mapSecretStrings(value, (plain) => encrypt(plain) ?? plain)
  );
}

/**
 * Returns a copy with every enveloped secret value decrypted; plaintext (legacy rows,
 * passthrough mode) is returned as-is. A value that no longer decrypts (rotated
 * STORAGE_ENCRYPTION_KEY) becomes null — the same contract as the scalar credential
 * columns — and is logged once per credential through decryptQuiet.
 */
export function decryptProviderSpecificDataSecrets(psd: unknown, meta: SecretFieldMeta): unknown {
  if (!isEncryptionEnabled()) return psd;
  return mapSecretFields(psd, (key, value) =>
    mapSecretStrings(value, (stored) =>
      looksEncrypted(stored)
        ? decryptQuiet(stored, {
            connectionId: meta.connectionId,
            provider: meta.provider,
            field: key,
          })
        : stored
    )
  );
}

/** True when at least one secret field still holds a plaintext (non-enveloped) value. */
export function hasPlaintextProviderSpecificDataSecrets(psd: unknown): boolean {
  if (!isRecord(psd)) return false;
  const isPlaintext = (value: unknown) =>
    typeof value === "string" && value.length > 0 && !looksEncrypted(value);
  return PROVIDER_SPECIFIC_DATA_SECRET_KEYS.some((key) => {
    const value = psd[key];
    return isPlaintext(value) || (Array.isArray(value) && value.some(isPlaintext));
  });
}

/**
 * The TEXT value for the provider_specific_data column. Same truthiness contract the
 * INSERT/UPDATE params always had (`null` when absent), with the secret fields enveloped.
 */
export function serializeProviderSpecificDataForStorage(psd: unknown): string | null {
  if (!psd) return null;
  return JSON.stringify(encryptProviderSpecificDataSecrets(psd));
}
