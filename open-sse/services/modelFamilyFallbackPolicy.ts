import { isModelAllowedForKey } from "@/lib/db/apiKeys";
import { resolvePolicyApiKey } from "@/shared/utils/apiKeyPolicy";
import { checkResolvedModelPermission } from "@/shared/utils/resolvedModelAccess";
import {
  STANDARD_REASONING_EFFORTS,
  EXTENDED_REASONING_EFFORTS,
} from "@/shared/reasoning/reasoningRoutingEfforts";
import { getRegistryEntry } from "../config/providerRegistry.ts";
import { getHeader, normalizeHeaders } from "../utils/headers.ts";
import { getRegisteredProviderEffortBaseModelId } from "../utils/registeredEffortVariants.ts";
import { parseModel, splitSyncedEffortSuffix } from "./model.ts";
import { getModelFamily, getNextFamilyFallback } from "./modelFamilyFallback.ts";

export const CROSS_VERSION_FALLBACK_HEADER = "x-omniroute-allow-cross-version-fallback";

type RequestFamilyPolicy = {
  headers?: unknown;
  hasApiKeyMetadata?: boolean;
};

/** Only registry-backed effort/mode aliases collapse; snapshots and versions stay distinct. */
export function isSameModelVersion(current: string, candidate: string, provider: string): boolean {
  const registered = new Set(
    getRegistryEntry(provider)?.models.map((model) => model.id.replace(/\./g, "-")) ?? []
  );
  const version = (model: string) => {
    const modelId = parseModel(model).model || model;
    const declaredBase = getRegisteredProviderEffortBaseModelId(provider, modelId);
    if (declaredBase) return declaredBase.replace(/\./g, "-");
    const bare = modelId.replace(/\./g, "-");
    const effort = splitSyncedEffortSuffix(bare, [
      ...STANDARD_REASONING_EFFORTS,
      ...EXTENDED_REASONING_EFFORTS,
    ]);
    if (effort.effort && registered.has(effort.baseModel)) return effort.baseModel;
    const modeBase = bare.replace(/-(thinking|tiered)$/, "");
    return registered.has(modeBase) ? modeBase : bare;
  };
  return version(current) === version(candidate);
}

export async function getRequestModelFamily(
  current: string,
  provider: string,
  policy: RequestFamilyPolicy = {}
): Promise<string[]> {
  const allowCrossVersion =
    getHeader(policy.headers, CROSS_VERSION_FALLBACK_HEADER)?.trim().toLowerCase() === "true";
  const candidates = getModelFamily(current, provider)
    .slice(1)
    .filter((candidate) => allowCrossVersion || isSameModelVersion(current, candidate, provider));
  if (!policy.hasApiKeyMetadata) return [current, ...candidates];
  const request = new Request("http://localhost/api/v1/chat/completions", {
    headers: normalizeHeaders(policy.headers),
  });
  let apiKey: string | null;
  try {
    apiKey = await resolvePolicyApiKey(request);
  } catch {
    return [current];
  }
  const permitted: string[] = [];
  for (const candidate of candidates) {
    const qualified = candidate.includes("/") ? candidate : `${provider}/${candidate}`;
    const permission = await checkResolvedModelPermission(
      {
        hasApiKeyMetadata: true,
        apiKey,
        // A grant for the original model must not authorize a different fallback.
        requestedModel: qualified,
        resolvedModel: qualified,
      },
      isModelAllowedForKey
    );
    if (permission === "allowed") permitted.push(candidate);
  }
  return [current, ...permitted];
}

export async function getNextRequestFamilyFallback(
  current: string,
  tried: Set<string>,
  provider: string,
  policy: RequestFamilyPolicy = {}
): Promise<string | null> {
  const permitted = new Set(await getRequestModelFamily(current, provider, policy));
  const excluded = new Set(tried);
  let candidate = getNextFamilyFallback(current, excluded, provider);
  while (candidate) {
    if (permitted.has(candidate)) return candidate;
    excluded.add(candidate);
    candidate = getNextFamilyFallback(current, excluded, provider);
  }
  return null;
}

/** Preserve aliases until a fallback actually changes the dispatched model. */
export function modelAfterFamilyFallback(
  requested: string,
  current: string,
  initial: string,
  outbound: unknown
): string {
  if (current === initial) return requested;
  const wire =
    outbound && typeof outbound === "object" ? (outbound as Record<string, unknown>).model : null;
  return typeof wire === "string" && wire ? wire : current;
}
