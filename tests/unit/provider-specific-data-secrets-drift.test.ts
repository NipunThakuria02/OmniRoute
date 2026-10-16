// One constant names the credential-bearing `providerSpecificData` fields. The
// response sanitizer (masks/strips them) and the at-rest encryptor (envelopes them)
// both read it, so neither can drift from the other: a field added to one side is
// automatically covered by the other, and this test fails if either side stops
// honoring an entry.
import test from "node:test";
import assert from "node:assert/strict";
import type { WebSessionCredentialRequirement } from "../../src/shared/providers/webSessionCredentials.ts";

process.env.STORAGE_ENCRYPTION_KEY = "psd-secrets-drift-synthetic-key";

const {
  PROVIDER_SPECIFIC_DATA_MASKED_SECRET_KEYS,
  PROVIDER_SPECIFIC_DATA_STRIPPED_SECRET_KEYS,
  PROVIDER_SPECIFIC_DATA_SECRET_KEYS,
  isProviderSpecificDataSecretKey,
  isProviderSpecificDataMaskedListKey,
} = await import("../../src/shared/constants/providerSpecificDataSecrets.ts");
const { sanitizeProviderSpecificDataForResponse } =
  await import("../../src/lib/providers/requestDefaults.ts");
const { encryptProviderSpecificDataSecrets, decryptProviderSpecificDataSecrets } =
  await import("../../src/lib/db/providers/secretFields.ts");
const { looksEncrypted } = await import("../../src/lib/db/encryption.ts");
const apiKeyMask = await import("../../src/shared/utils/apiKeyMask.ts");
const apiKeyExposure = await import("../../src/lib/apiKeyExposure.ts");
const { WEB_SESSION_CREDENTIAL_REQUIREMENTS } =
  await import("../../src/shared/providers/webSessionCredentials.ts");

// Every key the sanitizer removed before the shared constant existed. Dropping one
// from the constant would silently start exposing it again.
const PREVIOUSLY_STRIPPED = [
  "accessToken",
  "refreshToken",
  "idToken",
  "apiKey",
  "consoleApiKey",
  "secretAccessKey",
  "awsSecretAccessKey",
  "sessionToken",
  "awsSessionToken",
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
  "runtimeKey",
  "validationId",
  "volcConsoleCookie",
  "volcCsrfToken",
  "codexFingerprintSeed",
  "codexClientIdentity",
  "codexOriginalIdentityHeaders",
  "codexTurnStateEcho",
];

const META = { connectionId: "conn-drift", provider: "openai" };

test("the constant is well-formed: unique keys, masked ∪ stripped, no overlap", () => {
  assert.ok(PROVIDER_SPECIFIC_DATA_SECRET_KEYS.length > 0);
  assert.equal(
    new Set(PROVIDER_SPECIFIC_DATA_SECRET_KEYS).size,
    PROVIDER_SPECIFIC_DATA_SECRET_KEYS.length
  );
  assert.deepEqual(
    [...PROVIDER_SPECIFIC_DATA_SECRET_KEYS].sort(),
    [
      ...PROVIDER_SPECIFIC_DATA_MASKED_SECRET_KEYS,
      ...PROVIDER_SPECIFIC_DATA_STRIPPED_SECRET_KEYS,
    ].sort()
  );
  const stripped: readonly string[] = PROVIDER_SPECIFIC_DATA_STRIPPED_SECRET_KEYS;
  for (const key of PROVIDER_SPECIFIC_DATA_MASKED_SECRET_KEYS) {
    assert.ok(!stripped.includes(key), `${key} is in both lists`);
    assert.equal(isProviderSpecificDataMaskedListKey(key), true);
  }
  assert.ok(PROVIDER_SPECIFIC_DATA_MASKED_SECRET_KEYS.includes("extraApiKeys"));
  assert.equal(isProviderSpecificDataSecretKey("extraApiKeys"), true);
  assert.equal(isProviderSpecificDataSecretKey("tags"), false);
});

test("every previously stripped key and every audited credential field is in the constant", () => {
  const audited = [
    "extraApiKeys",
    "copilotToken",
    "clientSecret",
    "cookie",
    "token",
    "token_v2",
    "dcaToken",
    "browserSessionKey",
    "authorization",
    "recaptchaV3Token",
    "openrouterAccountKey",
  ];
  for (const key of [...PREVIOUSLY_STRIPPED, ...audited]) {
    assert.ok(
      isProviderSpecificDataSecretKey(key),
      `${key} must be a secret providerSpecificData key`
    );
  }
});

test("the sanitizer removes or masks every key in the constant and keeps the rest", () => {
  const SECRET = "plain-secret-value-0123456789";
  for (const key of PROVIDER_SPECIFIC_DATA_SECRET_KEYS) {
    const isList = isProviderSpecificDataMaskedListKey(key);
    const input = { [key]: isList ? [SECRET] : SECRET, keepMe: "visible", region: "eu" };
    const sanitized = sanitizeProviderSpecificDataForResponse(input) as Record<string, unknown>;
    assert.ok(sanitized, `${key}: sanitizer returned nothing`);
    assert.ok(
      !JSON.stringify(sanitized).includes(SECRET),
      `${key}: raw secret reached the response`
    );
    if (isList) {
      assert.deepEqual(sanitized[key], [apiKeyMask.maskStoredApiKey(SECRET)]);
    } else {
      assert.ok(!(key in sanitized), `${key}: must be stripped from the response`);
    }
    assert.equal(sanitized.keepMe, "visible");
    assert.equal(sanitized.region, "eu");
  }
});

test("the encryptor envelopes every string-valued key in the constant and the decryptor restores it", () => {
  const SECRET = "plain-secret-value-0123456789";
  for (const key of PROVIDER_SPECIFIC_DATA_SECRET_KEYS) {
    const isList = isProviderSpecificDataMaskedListKey(key);
    const input = { [key]: isList ? [SECRET, SECRET + "-b"] : SECRET, keepMe: "visible", count: 2 };
    const encrypted = encryptProviderSpecificDataSecrets(input) as Record<string, unknown>;
    assert.notStrictEqual(encrypted, input, `${key}: the encryptor must not mutate its input`);
    assert.ok(!JSON.stringify(encrypted).includes(SECRET), `${key}: plaintext survived encryption`);
    if (isList) {
      for (const entry of encrypted[key] as unknown[])
        assert.ok(looksEncrypted(entry), `${key}[] entry`);
    } else {
      assert.ok(looksEncrypted(encrypted[key]), `${key}: not enveloped`);
    }
    assert.equal(encrypted.keepMe, "visible");
    assert.equal(encrypted.count, 2);

    // Idempotent: a second pass never re-wraps an envelope.
    const twice = encryptProviderSpecificDataSecrets(encrypted) as Record<string, unknown>;
    assert.deepEqual(twice, encrypted, `${key}: double encryption`);

    const decrypted = decryptProviderSpecificDataSecrets(encrypted, META) as Record<
      string,
      unknown
    >;
    assert.deepEqual(decrypted, input, `${key}: round-trip mismatch`);
  }
});

test("object secret values pass through; a lone string under a list key is still enveloped", () => {
  const input = { codexClientIdentity: { a: 1 }, extraApiKeys: "not-a-list", count: 1 };
  const encrypted = encryptProviderSpecificDataSecrets(input) as Record<string, unknown>;
  assert.deepEqual(encrypted.codexClientIdentity, { a: 1 });
  assert.ok(looksEncrypted(encrypted.extraApiKeys), "a string under a secret key is enveloped");
  const sanitized = sanitizeProviderSpecificDataForResponse(input) as Record<string, unknown>;
  assert.ok(!("codexClientIdentity" in sanitized));
  assert.ok(!("extraApiKeys" in sanitized), "a malformed list is dropped rather than echoed");
  assert.equal(sanitized.count, 1);
});

test("plaintext (legacy) values decrypt as themselves; missing/empty data is left alone", () => {
  const legacy = { extraApiKeys: ["plain-a", "plain-b"], copilotToken: "plain-token", tags: ["x"] };
  assert.deepEqual(decryptProviderSpecificDataSecrets(legacy, META), legacy);
  assert.equal(decryptProviderSpecificDataSecrets(null, META), null);
  assert.equal(decryptProviderSpecificDataSecrets(undefined, META), undefined);
  assert.equal(encryptProviderSpecificDataSecrets(null), null);
  assert.deepEqual(encryptProviderSpecificDataSecrets({ tags: ["x"] }), { tags: ["x"] });
});

test("every web-session credential requirement stores its credential under a key in the constant", () => {
  const requirements: Record<string, WebSessionCredentialRequirement> =
    WEB_SESSION_CREDENTIAL_REQUIREMENTS;
  for (const [provider, requirement] of Object.entries(requirements)) {
    if (requirement.kind === "none") continue;
    const covered = requirement.storageKeys.filter((key: string) =>
      isProviderSpecificDataSecretKey(key)
    );
    assert.ok(
      covered.length > 0,
      `${provider}: none of its storageKeys [${requirement.storageKeys.join(", ")}] is a secret key`
    );
  }
});

test("extraApiKeys are masked with the very same function the routes use for apiKey", () => {
  assert.strictEqual(apiKeyExposure.maskStoredApiKey, apiKeyMask.maskStoredApiKey);
  assert.equal(apiKeyMask.maskStoredApiKey("sk-0123456789abcdef"), "sk-01234****cdef");
});

test("reconcileMaskedExtraApiKeys maps placeholders back to stored tokens and drops orphans", () => {
  const stored = ["sk-aaaa-0123456789abcd", "sk-bbbb-0123456789abcd"];
  const mask = apiKeyMask.maskStoredApiKey;
  assert.deepEqual(
    apiKeyMask.reconcileMaskedExtraApiKeys([mask(stored[0]), mask(stored[1])], stored),
    stored
  );
  assert.deepEqual(
    apiKeyMask.reconcileMaskedExtraApiKeys([mask(stored[1]), "sk-new-0123456789abcd"], stored),
    [stored[1], "sk-new-0123456789abcd"]
  );
  assert.deepEqual(apiKeyMask.reconcileMaskedExtraApiKeys(["sk-zzzz****wxyz"], stored), []);
  assert.deepEqual(
    apiKeyMask.reconcileMaskedExtraApiKeys([mask(stored[0]), stored[0]], stored),
    [stored[0]],
    "a placeholder and its plaintext twin collapse to one entry"
  );
  assert.deepEqual(apiKeyMask.reconcileMaskedExtraApiKeys(["plain"], undefined), ["plain"]);
  assert.equal(apiKeyMask.reconcileMaskedExtraApiKeys(undefined, stored), undefined);
  assert.equal(apiKeyMask.reconcileMaskedExtraApiKeys("oops", stored), "oops");
});
