/**
 * Declared providerSpecificData fields that contain credentials and must use the
 * same at-rest encryption as top-level connection tokens (#16836).
 *
 * Do not blanket-encrypt the JSON object: workspace/identity fields are queried
 * by SQLite and must remain readable. Unknown fields remain unchanged.
 */
export const PROVIDER_SPECIFIC_SECRET_FIELDS = [
  "consoleApiKey",
  "alibabaConsoleCookie",
  "alibabaConsoleSecToken",
  "xiaomiMimoConsoleCookie",
  // Console-only quota cookies/tokens live alongside the inference API key;
  // none are SQLite identity fields. Keeping them plaintext on disk exposes
  // the cloud-console account to anyone who can read the database.
  "qwenCloudCookie",
  "qwenCloudSecToken",
  "volcConsoleCookie",
  "volcCsrfToken",
  // Ollama Cloud's optional quota-scraping session credentials are the same
  // class of browser cookie as the Qwen/Volcengine console credentials above.
  // Only encrypt credential fields; workspace/identity JSON stays queryable.
  "ollamaUsageCookie",
  "ollamaCloudUsageCookie",
  "ollamaCloudCookie",
  "usageCookie",
  // Some connectors store a second credential or session token inside the
  // metadata object. These fields are already redacted from dashboard/audit
  // responses, but without declaring them here their SQLite values leak in
  // plaintext. Keep non-secret IDs (workspaceId/chatgptUserId) queryable.
  "accessToken",
  "refreshToken",
  "idToken",
  "apiKey",
  "secretAccessKey",
  "awsSecretAccessKey",
  "sessionToken",
  "awsSessionToken",
  "openCodeGoAuthCookie",
  "opencodeGoAuthCookie",
  "authCookie",
] as const;

/** Return a fresh object only if a recognized secret field actually changes. */
export function mapProviderSpecificDataSecrets(
  data: unknown,
  transform: (secret: string, field: (typeof PROVIDER_SPECIFIC_SECRET_FIELDS)[number]) =>
    string | null | undefined
): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const original = data as Record<string, unknown>;
  let updated: Record<string, unknown> | null = null;
  for (const field of PROVIDER_SPECIFIC_SECRET_FIELDS) {
    const secret = original[field];
    if (typeof secret !== "string" || !secret) continue;
    const value = transform(secret, field);
    if (value !== secret) {
      updated ??= { ...original };
      updated[field] = value;
    }
  }
  return updated ?? data;
}
