// `provider_connections.api_key` is stored as an `enc:v1:` envelope, but the JSON in
// `provider_specific_data` was written verbatim — so the rotation pool in
// `extraApiKeys[]` and provider cookies / refresh tokens sat in plaintext next to the
// encrypted primary key. The providers DB module must encrypt those fields on every
// write and decrypt them on every read, so callers (rotator, executors, exports) keep
// seeing plaintext while the file at rest does not. Legacy plaintext rows must keep
// working, get re-encrypted on their next write, and be swept by the in-module
// first-use pass. With no STORAGE_ENCRYPTION_KEY the column stays plaintext, exactly
// like `api_key` does today.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-psd-secrets-at-rest-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.APP_LOG_TO_FILE = "false";
process.env.STORAGE_ENCRYPTION_KEY = "psd-secrets-at-rest-synthetic-key";

const core = await import("../../src/lib/db/core.ts");
const { looksEncrypted, isEncryptionEnabled } = await import("../../src/lib/db/encryption.ts");
const providers = await import("../../src/lib/db/providers.ts");
const { runJsonMigration } = await import("../../src/lib/db/jsonMigration.ts");
const { invalidateDbCache } = await import("../../src/lib/db/readCache.ts");

const ENC_PREFIX = "enc:v1:";
const PRIMARY_KEY = "sk-primary-0123456789abcdefghij";
const EXTRA_ONE = "sk-extra-one-0123456789abcdefgh";
const EXTRA_TWO = "sk-extra-two-0123456789abcdefgh";
const COPILOT_TOKEN = "ghu_copilotbearer_0123456789abcdef";
const GROK_COOKIE = "sso=grok-sso-0123456789; sso-rw=grok-sso-rw-0123456789";

type Row = { provider_specific_data: string | null; api_key: string | null };

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function rawRow(id: string): Row {
  const row = core
    .getDbInstance()
    .prepare("SELECT provider_specific_data, api_key FROM provider_connections WHERE id = ?")
    .get(id) as Row | undefined;
  assert.ok(row, `row ${id} must exist`);
  return row;
}

function rawPsd(id: string): Record<string, unknown> {
  const row = rawRow(id);
  assert.ok(row.provider_specific_data, "provider_specific_data must be stored");
  return JSON.parse(row.provider_specific_data) as Record<string, unknown>;
}

function insertLegacyPlaintextRow(id: string, psd: Record<string, unknown>) {
  const now = new Date().toISOString();
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO provider_connections
         (id, provider, auth_type, name, priority, is_active, api_key, provider_specific_data, created_at, updated_at)
       VALUES (?, 'openai', 'apikey', ?, 1, 1, ?, ?, ?, ?)`
    )
    .run(id, `legacy-${id}`, PRIMARY_KEY, JSON.stringify(psd), now, now);
  invalidateDbCache("connections");
}

test.before(() => {
  resetDb();
  assert.equal(isEncryptionEnabled(), true, "precondition: synthetic STORAGE_ENCRYPTION_KEY");
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.STORAGE_ENCRYPTION_KEY;
});

test("createProviderConnection encrypts extraApiKeys and other credential fields at rest", async () => {
  const created = (await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "pool",
    apiKey: PRIMARY_KEY,
    providerSpecificData: {
      extraApiKeys: [EXTRA_ONE, EXTRA_TWO],
      copilotToken: COPILOT_TOKEN,
      tags: ["pool"],
      baseUrl: "https://api.example.test/v1",
    },
  })) as Record<string, unknown> & { id: string };

  // The object handed back to the caller is still plaintext.
  const returnedPsd = created.providerSpecificData as Record<string, unknown>;
  assert.deepEqual(returnedPsd.extraApiKeys, [EXTRA_ONE, EXTRA_TWO]);
  assert.equal(returnedPsd.copilotToken, COPILOT_TOKEN);

  const row = rawRow(created.id);
  assert.ok(looksEncrypted(row.api_key), "control: api_key is encrypted as before");
  const column = row.provider_specific_data ?? "";
  for (const secret of [EXTRA_ONE, EXTRA_TWO, COPILOT_TOKEN]) {
    assert.ok(
      !column.includes(secret),
      `provider_specific_data stores ${secret.slice(0, 12)}… in plaintext`
    );
  }
  const stored = JSON.parse(column) as Record<string, unknown>;
  assert.ok(Array.isArray(stored.extraApiKeys) && stored.extraApiKeys.length === 2);
  for (const entry of stored.extraApiKeys as unknown[]) {
    assert.ok(
      typeof entry === "string" && entry.startsWith(ENC_PREFIX),
      "each extra key is enveloped"
    );
  }
  assert.ok(String(stored.copilotToken).startsWith(ENC_PREFIX), "copilotToken is enveloped");
  assert.deepEqual(stored.tags, ["pool"], "non-secret fields stay plaintext JSON");
  assert.equal(stored.baseUrl, "https://api.example.test/v1");

  // Every module read path returns plaintext.
  const byId = (await providers.getProviderConnectionById(created.id)) as Record<string, unknown>;
  assert.deepEqual((byId.providerSpecificData as Record<string, unknown>).extraApiKeys, [
    EXTRA_ONE,
    EXTRA_TWO,
  ]);
  assert.equal((byId.providerSpecificData as Record<string, unknown>).copilotToken, COPILOT_TOKEN);

  const listed = (await providers.getProviderConnections({ provider: "openai" })).find(
    (c) => c.id === created.id
  ) as Record<string, unknown>;
  assert.ok(listed);
  assert.deepEqual((listed.providerSpecificData as Record<string, unknown>).extraApiKeys, [
    EXTRA_ONE,
    EXTRA_TWO,
  ]);
  // The export path serializes the lazy view — still plaintext.
  const exported = JSON.parse(JSON.stringify(listed)) as Record<string, unknown>;
  assert.deepEqual((exported.providerSpecificData as Record<string, unknown>).extraApiKeys, [
    EXTRA_ONE,
    EXTRA_TWO,
  ]);
});

test("updateProviderConnection re-encrypts and never double-encrypts", async () => {
  const created = (await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "pool-update",
    apiKey: PRIMARY_KEY,
    providerSpecificData: { extraApiKeys: [EXTRA_ONE] },
  })) as Record<string, unknown> & { id: string };

  // A metadata-only update must not disturb the stored secrets.
  await providers.updateProviderConnection(created.id, { name: "renamed" });
  let byId = (await providers.getProviderConnectionById(created.id)) as Record<string, unknown>;
  assert.deepEqual((byId.providerSpecificData as Record<string, unknown>).extraApiKeys, [
    EXTRA_ONE,
  ]);

  // A providerSpecificData update with plaintext input lands encrypted.
  await providers.updateProviderConnection(created.id, {
    providerSpecificData: { extraApiKeys: [EXTRA_ONE, EXTRA_TWO], tags: ["x"] },
  });
  const stored = rawPsd(created.id);
  const entries = stored.extraApiKeys as string[];
  assert.equal(entries.length, 2);
  for (const entry of entries) assert.ok(entry.startsWith(ENC_PREFIX));
  // Exactly one envelope per value: decrypting once yields the token itself.
  byId = (await providers.getProviderConnectionById(created.id)) as Record<string, unknown>;
  assert.deepEqual((byId.providerSpecificData as Record<string, unknown>).extraApiKeys, [
    EXTRA_ONE,
    EXTRA_TWO,
  ]);
});

test("a legacy plaintext row is readable and gets re-encrypted on its next write", async () => {
  const id = "legacy-plaintext-row";
  insertLegacyPlaintextRow(id, { extraApiKeys: [EXTRA_ONE], copilotToken: COPILOT_TOKEN });

  const byId = (await providers.getProviderConnectionById(id)) as Record<string, unknown>;
  assert.deepEqual((byId.providerSpecificData as Record<string, unknown>).extraApiKeys, [
    EXTRA_ONE,
  ]);
  assert.equal((byId.providerSpecificData as Record<string, unknown>).copilotToken, COPILOT_TOKEN);

  await providers.updateProviderConnection(id, { name: "touched" });

  const column = rawRow(id).provider_specific_data ?? "";
  assert.ok(!column.includes(EXTRA_ONE), "the write must re-encrypt the legacy extra key");
  assert.ok(!column.includes(COPILOT_TOKEN), "the write must re-encrypt the legacy token");
  const after = (await providers.getProviderConnectionById(id)) as Record<string, unknown>;
  assert.deepEqual((after.providerSpecificData as Record<string, unknown>).extraApiKeys, [
    EXTRA_ONE,
  ]);
});

test("first use of the providers module sweeps still-plaintext secret fields (idempotent)", async () => {
  resetDb();
  core.getDbInstance();
  const id = "legacy-sweep-row";
  insertLegacyPlaintextRow(id, { extraApiKeys: [EXTRA_ONE, EXTRA_TWO], tags: ["keep"] });
  const untouchedId = "already-encrypted-row";
  await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "already",
    apiKey: PRIMARY_KEY,
    providerSpecificData: { extraApiKeys: [EXTRA_ONE] },
  });

  // Trigger the module's first read on this database instance.
  const connections = await providers.getProviderConnections({ provider: "openai" });
  assert.ok(connections.length >= 1);

  const sweptColumn = rawRow(id).provider_specific_data ?? "";
  assert.ok(
    !sweptColumn.includes(EXTRA_ONE) && !sweptColumn.includes(EXTRA_TWO),
    "sweep encrypted the legacy row"
  );
  const swept = JSON.parse(sweptColumn) as Record<string, unknown>;
  assert.deepEqual(swept.tags, ["keep"]);
  for (const entry of swept.extraApiKeys as string[]) assert.ok(entry.startsWith(ENC_PREFIX));

  const readBack = (await providers.getProviderConnectionById(id)) as Record<string, unknown>;
  assert.deepEqual((readBack.providerSpecificData as Record<string, unknown>).extraApiKeys, [
    EXTRA_ONE,
    EXTRA_TWO,
  ]);

  // Rows that were already encrypted are left exactly as they were (no re-wrap).
  const alreadyRows = core
    .getDbInstance()
    .prepare("SELECT id, provider_specific_data FROM provider_connections WHERE name = 'already'")
    .all() as Array<{ id: string; provider_specific_data: string }>;
  assert.equal(alreadyRows.length, 1);
  const before = alreadyRows[0].provider_specific_data;
  await providers.getProviderConnections({ provider: "openai" });
  assert.equal(rawRow(alreadyRows[0].id).provider_specific_data, before);
  void untouchedId;
});

test("JSON export → import round-trip restores usable tokens and stores them encrypted", async () => {
  const created = (await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "roundtrip",
    apiKey: PRIMARY_KEY,
    providerSpecificData: { extraApiKeys: [EXTRA_ONE, EXTRA_TWO], copilotToken: COPILOT_TOKEN },
  })) as Record<string, unknown> & { id: string };

  // What GET /api/settings/export-json serializes: the decrypted module view.
  const exportedConnections = JSON.parse(
    JSON.stringify(await providers.getProviderConnections({ provider: "openai" }))
  ) as Array<Record<string, unknown>>;
  const exported = exportedConnections.find((c) => c.id === created.id);
  assert.ok(exported, "export must contain the connection");
  assert.deepEqual((exported.providerSpecificData as Record<string, unknown>).extraApiKeys, [
    EXTRA_ONE,
    EXTRA_TWO,
  ]);

  const db = core.getDbInstance();
  db.prepare("DELETE FROM provider_connections WHERE id = ?").run(created.id);
  invalidateDbCache("connections");
  runJsonMigration(db, { providerConnections: [exported] });
  invalidateDbCache("connections");

  const column = rawRow(created.id).provider_specific_data ?? "";
  for (const secret of [EXTRA_ONE, EXTRA_TWO, COPILOT_TOKEN]) {
    assert.ok(!column.includes(secret), "import must store the secret fields encrypted");
  }
  const restored = (await providers.getProviderConnectionById(created.id)) as Record<
    string,
    unknown
  >;
  assert.deepEqual((restored.providerSpecificData as Record<string, unknown>).extraApiKeys, [
    EXTRA_ONE,
    EXTRA_TWO,
  ]);
  assert.equal(
    (restored.providerSpecificData as Record<string, unknown>).copilotToken,
    COPILOT_TOKEN
  );
  assert.equal(restored.apiKey, PRIMARY_KEY);
});

test("web-session cookie dedup still matches the stored (now encrypted) credential", async () => {
  const first = (await providers.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    name: "grok-a",
    providerSpecificData: { cookie: GROK_COOKIE, sso: "grok-sso-0123456789" },
  })) as Record<string, unknown> & { id: string };
  const column = rawRow(first.id).provider_specific_data ?? "";
  assert.ok(!column.includes(GROK_COOKIE), "the cookie is encrypted at rest");

  const second = (await providers.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    name: "grok-b",
    providerSpecificData: { cookie: GROK_COOKIE, sso: "grok-sso-0123456789" },
  })) as Record<string, unknown>;
  assert.equal(second.id, first.id, "re-importing the same session updates the existing row");
  assert.equal(providers.getProviderConnectionsCount({ provider: "grok-web" }), 1);
});

test("without STORAGE_ENCRYPTION_KEY the column stays plaintext, like api_key", async () => {
  const saved = process.env.STORAGE_ENCRYPTION_KEY;
  delete process.env.STORAGE_ENCRYPTION_KEY;
  try {
    assert.equal(isEncryptionEnabled(), false);
    const created = (await providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "plain-mode",
      apiKey: PRIMARY_KEY,
      providerSpecificData: { extraApiKeys: [EXTRA_ONE] },
    })) as Record<string, unknown> & { id: string };
    const row = rawRow(created.id);
    assert.equal(row.api_key, PRIMARY_KEY, "control: api_key passthrough");
    assert.deepEqual(rawPsd(created.id).extraApiKeys, [EXTRA_ONE]);
  } finally {
    process.env.STORAGE_ENCRYPTION_KEY = saved;
  }
});
