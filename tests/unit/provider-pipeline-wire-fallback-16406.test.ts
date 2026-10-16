import test from "node:test";
import assert from "node:assert/strict";
import { runProviderExecutionPipeline } from "../../open-sse/handlers/chatCore/providerExecutionPipeline.ts";
import { getNextFamilyFallback } from "../../open-sse/services/modelFamilyFallback.ts";

test("current Anthropic catalog supplies the intended fallback fixture", () => {
  assert.equal(
    getNextFamilyFallback("claude-opus-5-5", new Set(["claude-opus-5-5"]), "anthropic"),
    "claude-opus-5"
  );
});

test("pipeline advances its own wire state when the handler callback only updates its closure", async () => {
  const sent: string[] = [];
  const tried = new Set(["original"]);
  const notifications: string[] = [];
  const result = await runProviderExecutionPipeline({
    policy: { allowModelFallback: true, allowAccountRotation: false },
    target: {
      provider: "anthropic",
      requestedModel: "original",
      sourceFormat: "openai",
      targetFormat: "claude",
      stream: false,
    },
    connection: {
      initialConnectionId: "fixture",
      getCurrentConnectionId: () => "fixture",
      getCredentials: () => ({}),
      replaceCredentials() {},
      onCredentialsRefreshed() {},
      assertManagedLeaseFence() {},
    },
    wire: {
      body: { model: "original" },
      currentModel: "original",
      triedModels: tried,
      setBodyAndModel(body, model) {
        notifications.push(model);
        tried.add(model);
        assert.equal(body.model, model);
      },
    },
    state: {
      updatePendingStage() {},
      recordRateLimitHeaders() {},
      recordRateLimitBody() {},
      async writeTerminalStatus() {},
      persistConnectionPatch() {},
      setConnectionRateLimitedUntil() {},
      lockModel() {},
      async recordAntigravityQuotaState() {},
      markAccountSemaphoreBlocked() {},
      isolateProbeFailures: () => false,
    },
    getNextFamilyFallback: (_current, attempts) => (attempts.has("next") ? null : "next"),
    sendProviderAttempt: async (model) => {
      sent.push(model);
      return {
        response: Response.json(
          model === "next" ? { content: "ok" } : { error: { message: "model not found" } },
          { status: model === "next" ? 200 : 404 }
        ),
        url: "https://example.test",
        headers: {},
        transformedBody: { model },
      };
    },
  });
  assert.deepEqual(sent, ["original", "next"]);
  assert.deepEqual(notifications, ["next"]);
  assert.equal(result.kind, "response");
  assert.equal(result.model, "next");
});
