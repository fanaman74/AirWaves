import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";

let dataDir: string;
let app: ScarletApp;
const calls: { url: string; init?: RequestInit }[] = [];

/** Google AI Studio and OpenRouter as the routes see them: "good-key" works, anything else is refused. */
function fakeProviders(url: string, init?: RequestInit): Response {
  calls.push({ url, init });
  const headers = new Headers(init?.headers);
  const key = headers.get("x-goog-api-key") ?? headers.get("authorization")?.replace(/^Bearer /, "");
  if (key !== "good-key-123") return new Response(JSON.stringify({ error: { message: "API key not valid." } }), { status: 401 });
  if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models")) {
    return Response.json({ models: [
      { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding-004", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
    ] });
  }
  if (url === "https://openrouter.ai/api/v1/key") return Response.json({ data: { label: "test", limit: 5, usage: 1 } });
  if (url === "https://openrouter.ai/api/v1/models") {
    return Response.json({ data: [
      { id: "openai/gpt-5", name: "OpenAI: GPT-5", context_length: 400000, supported_parameters: ["tools"] },
      { id: "meta/llama", name: "Llama", supported_parameters: [] },
    ] });
  }
  if (url === "https://openrouter.ai/api/v1/models?output_modalities=audio") {
    return Response.json({ data: [{ id: "google/lyria-3-clip-preview", name: "Google: Lyria 3 Clip Preview", architecture: { output_modalities: ["audio"] } },
      { id: "google/lyria-3-pro-preview", name: "Google: Lyria 3 Pro Preview", architecture: { output_modalities: ["audio"] } }] });
  }
  if (url.endsWith("/chat/completions") && JSON.parse(String(init?.body)).modalities) return musicStream();
  if (url.endsWith("/chat/completions")) {
    return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "report_ready", arguments: "{\"message\":\"Ready!\"}" } }] }, finish_reason: "tool_calls" }] });
  }
  return new Response("not found", { status: 404 });
}

/** A tiny real WAV: 0.5 s of silence at 8 kHz, so the engine can probe it. */
function silentWav(seconds = 0.5, rate = 8000): Buffer {
  const samples = Math.round(seconds * rate), data = samples * 2, b = Buffer.alloc(44 + data);
  b.write("RIFF", 0); b.writeUInt32LE(36 + data, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(data, 40);
  return b;
}

/** Lyria as OpenRouter streams it: text, then the audio as base64 pieces in delta.audio.data. */
function musicStream(): Response {
  const b64 = silentWav().toString("base64");
  const pieces = [b64.slice(0, 100), b64.slice(100)];
  const sse = [
    { choices: [{ delta: { role: "assistant", content: "Calm sea intro." } }] },
    ...pieces.map((data, i) => ({ choices: [{ delta: { audio: { data, ...(i === 0 && { format: "wav" }) } } }] })),
  ].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
}

beforeEach(async () => {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => fakeProviders(String(url), init)));
  dataDir = await mkdtemp(join(tmpdir(), "airwave-providers-"));
  app = createApp({ dataDir, skillsSeedDir: join(dataDir, "none"), env: {}, log: () => {} });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await app.ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.app.request(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken(app.ctx)}`, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() as T };
}

it("walks a provider through test key, models, test model and save", async () => {
  const bad = await call<{ ok: boolean; error?: string }>("POST", "/providers/aistudio/test-key", { apiKey: "wrong-key-123" });
  expect(bad.json.ok).toBe(false);
  expect(bad.json.error).toMatch(/refused/);

  const good = await call<{ ok: boolean }>("POST", "/providers/aistudio/test-key", { apiKey: "good-key-123" });
  expect(good.json.ok).toBe(true);

  const models = await call<{ models: { id: string; tools: boolean }[] }>("POST", "/providers/aistudio/models", { apiKey: "good-key-123" });
  expect(models.json.models).toEqual([expect.objectContaining({ id: "gemini-2.5-flash", tools: true })]);

  const tested = await call<{ ok: boolean; reply: string; tools: boolean }>("POST", "/providers/aistudio/test-model", { apiKey: "good-key-123", model: "gemini-2.5-flash" });
  expect(tested.json).toMatchObject({ ok: true, reply: "Ready!", tools: true });
  expect(calls.at(-1)!.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");

  const saved = await call<{ provider: { configured: boolean; keyPreview: string; model: string } }>("PUT", "/providers/aistudio", { apiKey: "good-key-123", model: "gemini-2.5-flash", modelLabel: "Gemini 2.5 Flash" });
  expect(saved.json.provider).toMatchObject({ configured: true, keyPreview: "good…-123", model: "gemini-2.5-flash" });

  // The interface never gets the key back; hosts do.
  const listed = await call<{ providers: Record<string, unknown>[] }>("GET", "/providers");
  expect(JSON.stringify(listed.json)).not.toContain("good-key-123");
  const secrets = await call<{ providers: { id: string; apiKey: string }[] }>("GET", "/providers/secrets");
  expect(secrets.json.providers).toEqual([expect.objectContaining({ id: "aistudio", apiKey: "good-key-123", enabled: true })]);

  const file = join(dataDir, "providers.json");
  expect(JSON.parse(await readFile(file, "utf8")).aistudio.apiKey).toBe("good-key-123");
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

  // A saved key is reused when the form leaves the key blank.
  expect((await call<{ ok: boolean }>("POST", "/providers/aistudio/test-key", {})).json.ok).toBe(true);

  expect((await call("DELETE", "/providers/aistudio")).status).toBe(200);
  expect((await call<{ providers: { configured: boolean }[] }>("GET", "/providers")).json.providers.every(p => !p.configured)).toBe(true);
});

it("lists OpenRouter models with tool support first and reports the key's credit", async () => {
  const key = await call<{ ok: boolean; detail: string }>("POST", "/providers/openrouter/test-key", { apiKey: "good-key-123" });
  expect(key.json.detail).toContain("$4.00 of $5.00 left");
  const models = await call<{ models: { id: string }[] }>("POST", "/providers/openrouter/models", { apiKey: "good-key-123" });
  expect(models.json.models.map(m => m.id)).toEqual(["openai/gpt-5", "meta/llama"]);
});

it("refuses an unknown provider and asks for a key when none is saved", async () => {
  expect((await call("POST", "/providers/nope/test-key", { apiKey: "good-key-123" })).status).toBe(404);
  expect((await call("POST", "/providers/openrouter/test-key", {})).status).toBe(400);
});

it("lists music models, plays a sample, and adds a generated track to a project's media", async () => {
  await call("PUT", "/providers/openrouter", { apiKey: "good-key-123", model: "openai/gpt-5" });
  const models = await call<{ models: { id: string }[] }>("POST", "/providers/openrouter/music-models", {});
  expect(models.json.models.map(m => m.id)).toEqual(["google/lyria-3-pro-preview", "google/lyria-3-clip-preview"]);

  const sample = await call<{ ok: boolean; mime: string; audioBase64: string; text: string }>("POST", "/providers/openrouter/test-music", { model: "google/lyria-3-clip-preview" });
  expect(sample.json).toMatchObject({ ok: true, mime: "audio/wav", text: "Calm sea intro." });
  expect(Buffer.from(sample.json.audioBase64, "base64").equals(silentWav())).toBe(true);
  const sent = JSON.parse(String(calls.at(-1)!.init!.body));
  expect(sent).toMatchObject({ model: "google/lyria-3-clip-preview", modalities: ["text", "audio"], stream: true });

  // Saving the provider again keeps the music model unless the form changes it.
  await call("PUT", "/providers/openrouter", { model: "openai/gpt-5", musicModel: "google/lyria-3-clip-preview" });
  await call("PUT", "/providers/openrouter", { model: "openai/gpt-5" });
  expect((await call<{ providers: { id: string; musicModel?: string }[] }>("GET", "/providers")).json.providers.find(p => p.id === "openrouter")!.musicModel)
    .toBe("google/lyria-3-clip-preview");

  const { json: { project } } = await call<{ project: { id: string } }>("POST", "/projects", { name: "Drone" });
  const made = await call<{ media: { id: string; kind: string; name: string }; model: string }>("POST", `/projects/${project.id}/music`, { prompt: "calm ambient, 125 BPM, instrumental", name: "Sea theme" });
  expect(made.status).toBe(201);
  expect(made.json).toMatchObject({ model: "google/lyria-3-clip-preview", media: { kind: "audio", name: "Sea theme.wav" } });
  const listed = await call<{ media: { id: string }[] }>("GET", `/projects/${project.id}/media`);
  expect(listed.json.media.map(m => m.id)).toContain(made.json.media.id);
});

it("says music needs an OpenRouter key", async () => {
  const { json: { project } } = await call<{ project: { id: string } }>("POST", "/projects", { name: "No key" });
  const res = await call<{ error?: { message?: string }; message?: string }>("POST", `/projects/${project.id}/music`, { prompt: "anything at all" });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.json)).toContain("OpenRouter key");
});
