import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ModelCapabilityEntry } from "../../src/lib/modelsDevSync.ts";
import { unexpectedCatalogNetworkRequests } from "../_helpers/catalogNetworkGuard13389.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-openrouter-stability-"));
Object.assign(process.env, {
  DATA_DIR: dataDir,
  API_KEY_SECRET: "catalog-stability-fixture-secret",
  DISABLE_SQLITE_AUTO_BACKUP: "true",
  APP_LOG_TO_FILE: "false",
});

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const settings = await import("../../src/lib/db/settings.ts");
const catalog = await import("../../src/app/api/v1/models/catalog.ts");
const { upsertSyncedCapabilities, getSyncedCapabilities } =
  await import("../../src/lib/modelsDevSync.ts");
const { getModelCatalogCacheVersion } = await import("../../src/lib/db/readCache.ts");
const { aiHordeImageCatalog } = await import("../../open-sse/services/aihordeImageCatalog.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("unchanged OpenRouter discovery preserves the unified catalog response cache", async () => {
  // Keep unrelated anonymous image discovery deterministic at its HTTP boundary.
  aiHordeImageCatalog.setFetch(async () => Response.json([]));
  await aiHordeImageCatalog.ensureFresh();
  await settings.updateSettings({
    requireLogin: false,
    requireAuthForModels: false,
    hideAutoCombos: true,
    hideNoThinkVariants: true,
  });
  await providers.createProviderConnection({
    provider: "openrouter",
    authType: "apikey",
    apiKey: "fixture-not-a-provider-key",
    name: "catalog stability fixture",
    isActive: true,
    providerSpecificData: {},
  });
  fs.mkdirSync(path.join(dataDir, "cache"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "cache/openrouter-catalog.json"),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      data: [
        {
          id: "fixture/catalog-vision",
          context_length: 8192,
          top_provider: { max_completion_tokens: 1024 },
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          supported_parameters: ["tools"],
        },
      ],
    })
  );
  const request = () => new Request("http://localhost/api/v1/models?prefix=canonical");
  // The first discovery legitimately inserts capabilities. Subsequent discovery
  // of identical metadata must neither invalidate nor discard its own cache.
  const initial = await catalog.getUnifiedModelsResponse(request());
  assert.equal(initial.status, 200);
  const first = await initial.json();
  assert.ok(
    first.data.some((model: { id: string }) => model.id === "openrouter/fixture/catalog-vision")
  );
  catalog.__resetCatalogBuilderRunsForTest();

  const built = await catalog.getUnifiedModelsResponse(request());
  assert.equal(built.status, 200);
  const builtBody = await built.text();
  const cached = await catalog.getUnifiedModelsResponse(request());
  assert.equal(cached.status, 200);
  assert.equal(
    catalog.__getCatalogBuilderRunsForTest(),
    1,
    "unchanged discovery must reuse the cached catalog"
  );
  assert.equal(await cached.text(), builtBody);
  assert.deepEqual(unexpectedCatalogNetworkRequests, []);
});

test("capability upserts invalidate only for real changes, including nullable fields", () => {
  const empty: ModelCapabilityEntry = {
    tool_call: null,
    reasoning: null,
    attachment: null,
    structured_output: null,
    temperature: null,
    modalities_input: "[]",
    modalities_output: "[]",
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: null,
    limit_context: null,
    limit_input: null,
    limit_output: null,
    interleaved_field: null,
    reasoning_efforts: null,
  };
  const populated: ModelCapabilityEntry = {
    tool_call: false,
    reasoning: true,
    attachment: false,
    structured_output: true,
    temperature: false,
    modalities_input: '["text","image"]',
    modalities_output: '["text"]',
    knowledge_cutoff: "2025-01",
    release_date: "2025-01-01",
    last_updated: "2026-01-01",
    status: "active",
    family: "fixture",
    open_weights: false,
    limit_context: 8192,
    limit_input: 4096,
    limit_output: 1024,
    interleaved_field: "reasoning_content",
    reasoning_efforts: ["low", "high"],
  };
  upsertSyncedCapabilities("other-fixture-provider", { retained: empty });
  const beforeInsert = getModelCatalogCacheVersion();
  upsertSyncedCapabilities("fixture-provider", { "nullable-model": empty });
  assert.notEqual(getModelCatalogCacheVersion(), beforeInsert, "new rows invalidate");

  for (const [field, value] of Object.entries(populated)) {
    const changed = { ...empty, [field]: value };
    const before = getModelCatalogCacheVersion();
    upsertSyncedCapabilities("fixture-provider", { "nullable-model": changed });
    const after = getModelCatalogCacheVersion();
    assert.notEqual(after, before, `${field}: changed value must invalidate`);
    assert.deepEqual(
      getSyncedCapabilities("fixture-provider")["fixture-provider"]["nullable-model"],
      changed
    );

    upsertSyncedCapabilities("fixture-provider", { "nullable-model": { ...changed } });
    assert.equal(
      getModelCatalogCacheVersion(),
      after,
      `${field}: identical value must not invalidate`
    );

    upsertSyncedCapabilities("fixture-provider", { "nullable-model": empty });
    const cleared = getModelCatalogCacheVersion();
    assert.notEqual(cleared, after, `${field}: cleared value must invalidate`);
    upsertSyncedCapabilities("fixture-provider", { "nullable-model": { ...empty } });
    assert.equal(
      getModelCatalogCacheVersion(),
      cleared,
      `${field}: identical empty value must not invalidate`
    );
  }
  assert.deepEqual(
    getSyncedCapabilities("other-fixture-provider")["other-fixture-provider"].retained,
    empty
  );
});
