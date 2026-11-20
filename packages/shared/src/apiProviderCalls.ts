/**
 * AirWaves: the HTTP calls behind the provider settings (test a key, list models, test a model)
 * and the chat call an API agent run makes. Uses global fetch, so it runs in Node 22+ and browsers.
 */
import { API_PROVIDERS, type ApiProviderId, type ApiProviderModel, type TestApiKeyResult, type TestApiModelResult } from "./apiProviders.js";

export type FetchFn = typeof fetch;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatTool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface ChatResponse {
  message: ChatMessage;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** The provider's API, or a stand-in named by AIRWAVES_<ID>_BASE_URL (tests, proxies, self-hosted gateways). */
export function apiBaseUrl(provider: ApiProviderId): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[`AIRWAVES_${provider.toUpperCase()}_BASE_URL`]?.replace(/\/+$/, "") || API_PROVIDERS[provider].baseUrl;
}

/** Gemini's own API, beside its OpenAI-compatible one: model lists live there. */
const geminiNative = () => apiBaseUrl("aistudio").replace(/\/openai$/, "");

export class ApiProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ApiProviderError";
  }
}

function authHeaders(provider: ApiProviderId, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/fanaman74/AirWaves";
    headers["X-Title"] = "AirWaves";
  }
  return headers;
}

/** The provider's own words for a failed call, kept short. */
async function failure(res: Response): Promise<ApiProviderError> {
  let text = "";
  try { text = await res.text(); } catch { /* none */ }
  let message = text;
  try {
    const body = JSON.parse(text) as unknown;
    const first = Array.isArray(body) ? body[0] : body;
    const err = (first as { error?: { message?: string } | string })?.error;
    message = typeof err === "string" ? err : err?.message ?? text;
  } catch { /* not JSON */ }
  const hint = res.status === 401 || res.status === 403 ? "The key was refused. " : res.status === 429 ? "Rate limited or out of quota. " : "";
  return new ApiProviderError(`${hint}${message.trim().slice(0, 300) || `HTTP ${res.status}`}`.trim(), res.status);
}

async function getJson<T>(url: string, init: RequestInit, f: FetchFn, signal?: AbortSignal): Promise<T> {
  const res = await f(url, { ...init, signal: signal ?? AbortSignal.timeout(20_000) });
  if (!res.ok) throw await failure(res);
  return await res.json() as T;
}

const errText = (err: unknown) => err instanceof Error ? (err.name === "TimeoutError" ? "The provider did not answer in time." : err.message) : String(err);

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

interface GeminiModel {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
}

/** Models a key can use for chat. Editing needs tool calls; those come first. */
export async function listApiModels(provider: ApiProviderId, apiKey: string, f: FetchFn = fetch): Promise<ApiProviderModel[]> {
  if (provider === "aistudio") {
    const models: ApiProviderModel[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ pageSize: "1000", ...(pageToken && { pageToken }) });
      const body = await getJson<{ models?: GeminiModel[]; nextPageToken?: string }>(
        `${geminiNative()}/models?${q}`, { headers: { "x-goog-api-key": apiKey } }, f);
      for (const m of body.models ?? []) {
        if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
        const id = m.name.replace(/^models\//, "");
        // Embedding, image-only and speech models can't hold an editing conversation.
        if (/embedding|imagen|veo|aqa|-tts|image-generation|native-audio/.test(id)) continue;
        models.push({ id, label: m.displayName ?? id, contextLength: m.inputTokenLimit, tools: /^gemini/.test(id) });
      }
      pageToken = body.nextPageToken;
      if (!pageToken) break;
    }
    return sortModels(models);
  }
  // OpenRouter's catalog is public; the key test is separate.
  const body = await getJson<{ data?: OpenRouterModel[] }>(`${apiBaseUrl("openrouter")}/models`, { headers: authHeaders(provider, apiKey) }, f);
  return sortModels((body.data ?? []).map((m) => ({
    id: m.id,
    label: m.name ?? m.id,
    contextLength: m.context_length,
    tools: m.supported_parameters?.includes("tools") ?? false,
  })));
}

function sortModels(models: ApiProviderModel[]): ApiProviderModel[] {
  return models.sort((a, b) => Number(!!b.tools) - Number(!!a.tools) || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Does the provider accept this key? */
export async function testApiKey(provider: ApiProviderId, apiKey: string, f: FetchFn = fetch): Promise<TestApiKeyResult> {
  try {
    if (provider === "aistudio") {
      const body = await getJson<{ models?: unknown[] }>(`${geminiNative()}/models?pageSize=1`,
        { headers: { "x-goog-api-key": apiKey } }, f);
      return { ok: true, detail: body.models?.length ? "Key accepted by Google AI Studio." : "Key accepted." };
    }
    const body = await getJson<{ data?: { label?: string; limit?: number | null; usage?: number; is_free_tier?: boolean } }>(
      `${apiBaseUrl("openrouter")}/key`, { headers: authHeaders(provider, apiKey) }, f);
    const d = body.data ?? {};
    const credit = d.limit == null ? "no credit limit" : `$${Math.max(0, d.limit - (d.usage ?? 0)).toFixed(2)} of $${d.limit.toFixed(2)} left`;
    return { ok: true, detail: `Key accepted${d.label ? ` (${d.label})` : ""}: ${d.is_free_tier ? "free tier, " : ""}${credit}.` };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

/** Send the model a short prompt that needs one tool call, to show it can both answer and use tools. */
export async function testApiModel(provider: ApiProviderId, apiKey: string, model: string, f: FetchFn = fetch): Promise<TestApiModelResult> {
  const started = Date.now();
  const tool: ChatTool = {
    type: "function",
    function: {
      name: "report_ready",
      description: "Report that you are ready to edit video.",
      parameters: { type: "object", properties: { message: { type: "string", description: "A short greeting." } }, required: ["message"] },
    },
  };
  try {
    const res = await chatCompletion({
      provider, apiKey, model,
      messages: [{ role: "user", content: "This is a connection test from AirWaves, a video editor. Call report_ready with a one-sentence greeting." }],
      tools: [tool],
      maxTokens: 300,
      signal: AbortSignal.timeout(45_000),
    }, f);
    const call = res.message.tool_calls?.[0];
    let reply = res.message.content?.trim() ?? "";
    if (call) {
      try { reply = String((JSON.parse(call.function.arguments || "{}") as { message?: string }).message ?? reply); } catch { /* keep text */ }
    }
    return { ok: true, reply: reply.slice(0, 300) || "(empty reply)", ms: Date.now() - started, tools: !!call };
  } catch (err) {
    return { ok: false, error: errText(err), ms: Date.now() - started };
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatRequest {
  provider: ApiProviderId;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export async function chatCompletion(req: ChatRequest, f: FetchFn = fetch): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    ...(req.tools?.length && { tools: req.tools, tool_choice: "auto" }),
    ...(req.maxTokens && { max_tokens: req.maxTokens }),
  };
  const res = await f(`${apiBaseUrl(req.provider)}/chat/completions`, {
    method: "POST",
    headers: authHeaders(req.provider, req.apiKey),
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok) throw await failure(res);
  const json = await res.json() as {
    choices?: { message?: Partial<ChatMessage>; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  };
  if (json.error) throw new ApiProviderError(json.error.message ?? "The provider returned an error.");
  const choice = json.choices?.[0];
  if (!choice?.message) throw new ApiProviderError("The provider returned no answer.");
  const m = choice.message;
  return {
    message: {
      role: "assistant",
      content: typeof m.content === "string" ? m.content : null,
      ...(m.tool_calls?.length && {
        tool_calls: m.tool_calls.map((c, i) => ({ ...c, id: c.id || `call_${i}`, type: "function" as const })),
      }),
    },
    finishReason: choice.finish_reason,
    usage: json.usage && { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens },
  };
}

const GEMINI_SCHEMA_KEYS = new Set(["type", "description", "properties", "required", "items", "enum", "nullable", "format", "anyOf", "minimum", "maximum", "minItems", "maxItems"]);

/**
 * A tool's JSON schema in the subset every provider accepts. Gemini refuses `$schema`, `additionalProperties`,
 * `$ref` and friends, and wants a single `type`.
 */
export function portableSchema(schema: unknown, root = schema): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object", properties: {} };
  let s = schema as Record<string, unknown>;
  if (typeof s.$ref === "string") {
    const target = s.$ref.replace(/^#\//, "").split("/").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], root);
    s = { ...(target as Record<string, unknown> ?? {}), ...(s.description ? { description: s.description } : {}) };
  }
  if (Array.isArray(s.allOf) && s.allOf.length === 1) s = { ...(s.allOf[0] as object), ...(s.description ? { description: s.description } : {}) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, ps]) => [p, portableSchema(ps, root)]));
    } else if (k === "items") {
      out.items = Array.isArray(v) ? portableSchema(v[0], root) : portableSchema(v, root);
    } else if (k === "anyOf" && Array.isArray(v)) {
      const options = v.filter((o) => (o as { type?: string })?.type !== "null");
      if (options.length < v.length) out.nullable = true;
      if (options.length === 1) Object.assign(out, portableSchema(options[0], root));
      else out.anyOf = options.map((o) => portableSchema(o, root));
    } else if (k === "type" && Array.isArray(v)) {
      const types = v.filter((t) => t !== "null");
      out.type = types[0] ?? "string";
      if (types.length < v.length) out.nullable = true;
    } else if (k === "format") {
      if (v === "date-time" || v === "enum") out.format = v;
    } else if (k === "enum" && Array.isArray(v)) {
      out.enum = v.map(String);
      out.type = "string";
    } else {
      out[k] = v;
    }
  }
  if ("const" in s) { out.type = "string"; out.enum = [String(s.const)]; }
  if (!out.type && !out.anyOf) out.type = out.properties ? "object" : "string";
  if (out.type === "object" && !out.properties) out.properties = {};
  if (Array.isArray(out.required) && out.properties) {
    out.required = (out.required as string[]).filter((r) => r in (out.properties as object));
  }
  if (out.type === "array" && !out.items) out.items = { type: "string" };
  return out;
}
