/**
 * AirWaves: AI providers reached directly over their HTTP APIs with the editor's own key,
 * instead of through a command-line agent. Each is an OpenAI-compatible chat endpoint with tool calling.
 */
import { z } from "zod/v3";

export const ApiProviderId = z.enum(["aistudio", "openrouter"]);
export type ApiProviderId = z.infer<typeof ApiProviderId>;

export const API_PROVIDER_IDS: readonly ApiProviderId[] = ApiProviderId.options;

export function isApiProvider(id: string | undefined): id is ApiProviderId {
  return !!id && (API_PROVIDER_IDS as readonly string[]).includes(id);
}

export interface ApiProviderInfo {
  id: ApiProviderId;
  label: string;
  /** Where the editor gets a key. */
  keyUrl: string;
  keyHint: string;
  /** OpenAI-compatible base URL: `${baseUrl}/chat/completions`. */
  baseUrl: string;
}

export const API_PROVIDERS: Record<ApiProviderId, ApiProviderInfo> = {
  aistudio: {
    id: "aistudio",
    label: "Google Gemini (AI Studio)",
    keyUrl: "https://aistudio.google.com/apikey",
    keyHint: "AIza…",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyHint: "sk-or-…",
    baseUrl: "https://openrouter.ai/api/v1",
  },
};

export const ApiKey = z.string().trim().min(8, "Enter an API key.").max(512);
export const ApiModelId = z.string().trim().min(1).max(200).regex(/^[\w.:/@+-]+$/, "Not a model ID");

export const ApiProviderModel = z.object({
  id: ApiModelId,
  label: z.string(),
  contextLength: z.number().optional(),
  /** The model accepts tool calls, which editing needs. */
  tools: z.boolean().optional(),
});
export type ApiProviderModel = z.infer<typeof ApiProviderModel>;

/** A saved provider as the interface sees it: the key is never sent back whole. */
export const ApiProviderStatus = z.object({
  id: ApiProviderId,
  configured: z.boolean(),
  enabled: z.boolean(),
  keyPreview: z.string().optional(),
  model: z.string().optional(),
  modelLabel: z.string().optional(),
  /** OpenRouter only: the audio model music_generate uses (Google Lyria). */
  musicModel: z.string().optional(),
  savedAt: z.string().optional(),
});
export type ApiProviderStatus = z.infer<typeof ApiProviderStatus>;

/** A saved provider as an agent host needs it to run a request. */
export const ApiProviderSecret = z.object({
  id: ApiProviderId,
  apiKey: z.string(),
  model: z.string(),
  modelLabel: z.string().optional(),
  enabled: z.boolean(),
});
export type ApiProviderSecret = z.infer<typeof ApiProviderSecret>;

export const TestApiKeyRequest = z.object({ apiKey: ApiKey.optional() });
export const TestApiModelRequest = z.object({ apiKey: ApiKey.optional(), model: ApiModelId });
export const SaveApiProviderRequest = z.object({
  apiKey: ApiKey.optional(),
  model: ApiModelId,
  modelLabel: z.string().max(200).optional(),
  enabled: z.boolean().default(true),
  /** Leave out to keep the saved one; empty to clear. */
  musicModel: z.union([ApiModelId, z.literal("")]).optional(),
});

export const TestMusicRequest = z.object({ apiKey: ApiKey.optional(), model: ApiModelId, prompt: z.string().trim().min(1).max(2000).optional() });
export interface TestMusicResult { ok: boolean; error?: string; ms?: number; mime?: string; bytes?: number; audioBase64?: string; text?: string }

export const GenerateMusicRequest = z.object({
  prompt: z.string().trim().min(3).max(2000),
  name: z.string().trim().min(1).max(200).optional(),
  model: ApiModelId.optional(),
});
export type GenerateMusicRequest = z.infer<typeof GenerateMusicRequest>;

export interface TestApiKeyResult { ok: boolean; error?: string; detail?: string }
export interface TestApiModelResult { ok: boolean; error?: string; reply?: string; ms?: number; tools?: boolean }

/** Show only enough of a key to recognise it. */
export function maskApiKey(key: string): string {
  const k = key.trim();
  if (k.length <= 10) return "•".repeat(k.length);
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}
