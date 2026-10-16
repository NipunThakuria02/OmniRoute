/**
 * Credential-bearing fields of `provider_connections.provider_specific_data`.
 *
 * ONE list, two consumers that must never drift from each other:
 *  - the API response sanitizer (`sanitizeProviderSpecificDataForResponse`) masks the
 *    `MASKED` keys with the same mask as `apiKey` and strips the `STRIPPED` keys;
 *  - the DB module (`src/lib/db/providers/secretFields.ts`) stores every key here as an
 *    `enc:v1:` envelope and decrypts it on read, exactly like the scalar credential
 *    columns (`api_key`, `access_token`, …).
 *
 * Pure data: importable from client bundles, open-sse and the DB layer alike.
 * `tests/unit/provider-specific-data-secrets-drift.test.ts` checks both consumers
 * against every entry.
 */

/**
 * Lists of upstream tokens that the dashboard needs to show (masked) and edit.
 * Each element is treated like `apiKey`: masked in responses, encrypted at rest.
 */
export const PROVIDER_SPECIFIC_DATA_MASKED_SECRET_KEYS = ["extraApiKeys"] as const;

/**
 * Credentials that are never returned by the providers API and are encrypted at rest.
 * The edit modal initializes these fields empty and the PUT merge preserves keys the
 * client did not send, so stripping them cannot clobber the stored values.
 */
export const PROVIDER_SPECIFIC_DATA_STRIPPED_SECRET_KEYS = [
  // OAuth / API-key material mirrored into providerSpecificData by some flows.
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "idToken",
  "apiKey",
  "consoleApiKey",
  "secretAccessKey",
  "awsSecretAccessKey",
  "sessionToken",
  "awsSessionToken",
  // Short-lived provider sub-tokens written by refresh flows.
  "copilotToken",
  "dcaToken",
  "openrouterAccountKey",
  "authorization",
  "browserSessionKey",
  "recaptchaV3Token",
  // Device-registered OAuth client secret (Kiro).
  "clientSecret",
  // Console / usage-scraping browser sessions.
  "openCodeGoAuthCookie",
  "opencodeGoAuthCookie",
  "authCookie",
  "ollamaUsageCookie",
  "ollamaCloudUsageCookie",
  "ollamaCloudCookie",
  "usageCookie",
  "qwenCloudCookie",
  "qwenCloudSecToken",
  "alibabaConsoleCookie",
  "alibabaConsoleSecToken",
  "xiaomiMimoConsoleCookie",
  "volcConsoleCookie",
  "volcCsrfToken",
  // Web-session credentials (cookie / token providers store the session here).
  "cookie",
  "cookies",
  "storageState",
  "origins",
  "token",
  "token_v2",
  "userToken",
  "jwt",
  "sso",
  "sso-rw",
  "session",
  "session-token",
  "sessionCookie",
  "sessionKey",
  "sessionid",
  "__Secure-next-auth.session-token",
  "__Secure-authjs.session-token",
  "__Secure-better-auth.session_token",
  "__Secure-1PSID",
  "__Secure-1PSIDTS",
  "__client",
  "__session",
  "__vercel_session",
  "hy_token",
  "hf-chat",
  "p-b",
  "kimi-auth",
  "duckai",
  "chatglm_session",
  "manus_session",
  "ecto_1_sess",
  "abra_sess",
  "convex-session-id",
  "convexSessionId",
  "nt_session",
  "si_ses_id",
  "ttwid",
  "uuid",
  "app-config-uuid",
  "arena-auth-prod-v1",
  "arena-auth-prod-v1.0",
  "arena-auth-prod-v1.1",
  "maxaiAccessToken",
  "ucCookies",
  "ucClientCookie",
  "clientCookie",
  // ChatGPT Web (Codex) runtime key + transient validation handle.
  "runtimeKey",
  "validationId",
  // System-managed Codex fingerprint seed and runtime-only identity carriers.
  "codexFingerprintSeed",
  "codexClientIdentity",
  "codexOriginalIdentityHeaders",
  "codexTurnStateEcho",
] as const;

export const PROVIDER_SPECIFIC_DATA_SECRET_KEYS: readonly string[] = [
  ...PROVIDER_SPECIFIC_DATA_MASKED_SECRET_KEYS,
  ...PROVIDER_SPECIFIC_DATA_STRIPPED_SECRET_KEYS,
];

const SECRET_KEY_SET: ReadonlySet<string> = new Set(PROVIDER_SPECIFIC_DATA_SECRET_KEYS);
const MASKED_KEY_SET: ReadonlySet<string> = new Set(PROVIDER_SPECIFIC_DATA_MASKED_SECRET_KEYS);

export function isProviderSpecificDataSecretKey(key: string): boolean {
  return SECRET_KEY_SET.has(key);
}

/** True for the list-valued keys that are masked (not stripped) in API responses. */
export function isProviderSpecificDataMaskedListKey(key: string): boolean {
  return MASKED_KEY_SET.has(key);
}
