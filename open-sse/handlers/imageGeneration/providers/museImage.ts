import { saveCallLog } from "@/lib/usageDb";
import { fetchUntrustedRemoteImage } from "@/shared/network/remoteImageFetch";
import { FetchTimeoutError, fetchWithTimeout } from "@/shared/utils/fetchTimeout";
import { MUSE_CODE_INFERENCE_USER_AGENT, normalizeMuseBaseUrl } from "../../../config/museCode.ts";
import { sanitizeErrorMessage } from "../../../utils/error.ts";

/**
 * Muse Image (Meta Model API) — OpenAI-compatible image generation and edits on the
 * muse-code connection. A request carrying a reference image (`imageBytes` from
 * /v1/images/edits, or `image` / `images` as data URL, raw base64 or https URL) goes to
 * /images/edits as multipart; otherwise /images/generations as JSON. Output is base64
 * or a signed URL; a signed URL is downloaded when the caller asked for `b64_json`.
 */

interface MuseImageArgs {
  model: string;
  provider: string;
  body: Record<string, unknown>;
  credentials?: {
    apiKey?: string;
    accessToken?: string;
    providerSpecificData?: Record<string, unknown> | null;
  } | null;
  signal?: AbortSignal | null;
  log?: { error?: (tag: string, message: string) => void } | null;
}

interface ImagePart {
  bytes: Buffer;
  mime: string;
}

interface MuseImageEntry {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

class ReferenceImageError extends Error {}

const DATA_URL_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i;

/** Minted connections carry Meta's base_url; manual overrides may point at a chat path. */
function resolveMuseImagesBase(credentials: MuseImageArgs["credentials"]): string {
  const raw = credentials?.providerSpecificData?.baseUrl;
  const base = normalizeMuseBaseUrl(typeof raw === "string" ? raw : null);
  return base.replace(/\/(?:responses|chat\/completions)$/, "");
}

async function toImagePart(value: unknown, signal?: AbortSignal | null): Promise<ImagePart> {
  if (typeof value !== "string" || !value.trim()) {
    throw new ReferenceImageError("Unsupported reference image input");
  }
  const trimmed = value.trim();
  const dataUrl = DATA_URL_PATTERN.exec(trimmed);
  if (dataUrl) return { mime: dataUrl[1].toLowerCase(), bytes: Buffer.from(dataUrl[2], "base64") };
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const remote = await fetchUntrustedRemoteImage(trimmed, { signal: signal ?? undefined });
      return { bytes: remote.buffer, mime: remote.contentType || "image/png" };
    } catch (err) {
      throw new ReferenceImageError(
        `Reference image could not be loaded: ${sanitizeErrorMessage(err)}`
      );
    }
  }
  return { mime: "image/png", bytes: Buffer.from(trimmed, "base64") };
}

async function collectImageParts(
  body: Record<string, unknown>,
  signal?: AbortSignal | null
): Promise<ImagePart[]> {
  const parts: ImagePart[] = [];
  const bytes = body.imageBytes;
  if (bytes instanceof Uint8Array && bytes.length > 0) {
    parts.push({
      bytes: Buffer.from(bytes),
      mime: typeof body.imageMime === "string" && body.imageMime ? body.imageMime : "image/png",
    });
  }
  const inputs = [
    ...(Array.isArray(body.images) ? body.images : []),
    ...(body.image !== undefined && body.image !== null ? [body.image] : []),
  ].filter(Boolean);
  for (const input of inputs) parts.push(await toImagePart(input, signal));
  return parts;
}

function normalizeEntries(data: unknown): MuseImageEntry[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((item): MuseImageEntry | null => {
      if (typeof item === "string") {
        return /^https?:\/\//i.test(item) ? { url: item } : { b64_json: item };
      }
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const entry: MuseImageEntry = {};
      if (typeof record.b64_json === "string" && record.b64_json) entry.b64_json = record.b64_json;
      if (typeof record.url === "string" && record.url) entry.url = record.url;
      if (typeof record.revised_prompt === "string") entry.revised_prompt = record.revised_prompt;
      return entry.b64_json || entry.url ? entry : null;
    })
    .filter((entry): entry is MuseImageEntry => entry !== null);
}

function upstreamErrorMessage(payload: unknown, status: number): string {
  const error = (payload as { error?: unknown } | null)?.error;
  if (typeof error === "string" && error) return error;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message === "string" && message) return message;
  return `Muse Image API returned HTTP ${status}`;
}

export async function handleMuseImageGeneration({
  model,
  provider,
  body,
  credentials,
  signal,
  log,
}: MuseImageArgs) {
  const startTime = Date.now();
  let path = "/v1/images/generations";
  const fail = (status: number, message: unknown) => {
    const error = sanitizeErrorMessage(message);
    log?.error?.("IMAGE", `Muse Image: ${error}`);
    saveCallLog({
      method: "POST",
      path,
      provider,
      model: `${provider}/${model}`,
      status,
      duration: Date.now() - startTime,
      error,
    }).catch((err: unknown) => log?.error?.("IMAGE", sanitizeErrorMessage(err)));
    return { success: false as const, status, error };
  };

  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token) return fail(401, "Muse Code API key is required for Muse Image");
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) return fail(400, "Missing required field: prompt");

  let parts: ImagePart[];
  try {
    parts = await collectImageParts(body, signal);
  } catch (err) {
    return fail(400, err instanceof ReferenceImageError ? err.message : err);
  }

  const n = typeof body.n === "number" && Number.isInteger(body.n) && body.n > 0 ? body.n : 1;
  const size = typeof body.size === "string" && body.size ? body.size : undefined;
  const responseFormat =
    body.response_format === "url" || body.response_format === "b64_json"
      ? body.response_format
      : undefined;
  const base = resolveMuseImagesBase(credentials);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": MUSE_CODE_INFERENCE_USER_AGENT,
  };
  let url: string;
  let requestBody: string | FormData;
  if (parts.length > 0) {
    path = "/v1/images/edits";
    url = `${base}/images/edits`;
    // FormData sets its own multipart boundary — never set Content-Type manually.
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("n", String(n));
    if (size) form.append("size", size);
    if (responseFormat) form.append("response_format", responseFormat);
    parts.forEach((part, index) => {
      const ext = part.mime.split("/")[1] || "png";
      form.append("image", new Blob([part.bytes], { type: part.mime }), `image-${index}.${ext}`);
    });
    requestBody = form;
  } else {
    url = `${base}/images/generations`;
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify({
      model,
      prompt,
      n,
      ...(size ? { size } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
    });
  }

  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: requestBody,
      signal,
      redirect: "error",
    });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      return fail(response.ok ? 502 : response.status, "Invalid response from Muse Image API");
    }
    if (!response.ok) return fail(response.status, upstreamErrorMessage(payload, response.status));

    const images = normalizeEntries((payload as { data?: unknown } | null)?.data);
    if (!images.length) return fail(502, "No images returned from Muse Image");
    if (responseFormat === "b64_json") {
      for (const entry of images) {
        if (entry.b64_json || !entry.url) continue;
        const remote = await fetchUntrustedRemoteImage(entry.url, { signal: signal ?? undefined });
        entry.b64_json = remote.buffer.toString("base64");
        delete entry.url;
      }
    }
    const created = (payload as { created?: unknown }).created;
    saveCallLog({
      method: "POST",
      path,
      provider,
      model: `${provider}/${model}`,
      status: 200,
      duration: Date.now() - startTime,
      requestBody: { model, n, size, reference_images: parts.length },
      responseBody: { images_count: images.length },
    }).catch((err: unknown) => log?.error?.("IMAGE", sanitizeErrorMessage(err)));
    return {
      success: true as const,
      data: {
        created: typeof created === "number" ? created : Math.floor(Date.now() / 1000),
        data: images,
      },
    };
  } catch (err: unknown) {
    return fail(err instanceof FetchTimeoutError ? 504 : 502, err);
  }
}
