import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("unchanged OpenRouter discovery preserves the unified catalog response cache", async () => {
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
  assert.equal(await cached.text(), builtBody);
  assert.equal(
    catalog.__getCatalogBuilderRunsForTest(),
    1,
    "unchanged discovery must reuse the cached catalog"
  );
  assert.deepEqual(unexpectedCatalogNetworkRequests, []);
});
