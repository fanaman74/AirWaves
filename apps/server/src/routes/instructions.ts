/**
 * AirWaves: the instructions every editing run starts from, the editor's saved prompts, and "Improve", which rewrites
 * a request or a music description with one of the editor's saved AI providers.
 *
 * `instructions.json` and `prompts.json` live in the library beside `providers.json`.
 */
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { SCARLET_INTRO } from "@scarlet/mcp/prompt";
import {
  DEFAULT_MUSIC_INSTRUCTIONS, ImprovePromptRequest, SavePromptRequest, SaveInstructionsRequest, chatCompletion, isApiProvider,
  type ApiProviderId, type FetchFn, type ImprovePromptResult, type Instructions, type PromptKind, type SavedPrompt,
} from "@scarlet/shared";
import { newId } from "@scarlet/timeline";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, notFound } from "../errors.js";
import { providerStore } from "./providers.js";
import { jsonBody } from "./util.js";

const instructionsPath = (ctx: Pick<Ctx, "paths">) => join(ctx.paths.root, "instructions.json");
const promptsPath = (ctx: Pick<Ctx, "paths">) => join(ctx.paths.root, "prompts.json");

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}

/** What the editor changed, without the defaults. Read on every run, so a save applies to the next request. */
export function readInstructions(ctx: Pick<Ctx, "paths">): { editing?: string; music?: string } {
  return readJson(instructionsPath(ctx), {});
}

function withDefaults(saved: { editing?: string; music?: string }): Instructions {
  return { ...saved, defaults: { editing: SCARLET_INTRO, music: DEFAULT_MUSIC_INSTRUCTIONS } };
}

const IMPROVE_SYSTEM: Record<PromptKind, string> = {
  edit: "You improve requests that a video editor sends to an AI editing agent in AirWaves, an AI video editor. The agent can cut and arrange clips, trim pauses and filler, reframe, add captions, graphics, transitions and music, and render. " +
    "Rewrite the editor's request so it is clear, specific and actionable: the goal, target length and pacing, what to keep or remove, style and tone, music or captions if wanted, and anything the agent should ask about first. " +
    "Keep the editor's intent, facts and language; do not invent details about the footage; keep it concise (a short paragraph or a few bullet points). Reply with the improved request only, no preamble.",
  music: "You improve descriptions for an AI music generator (Google Lyria). Rewrite the editor's idea as one rich music prompt: genre and sub-genre, mood and energy, main instruments and sound design, tempo in BPM, key if useful, structure with rough timings (intro, build, drop, outro), and whether it is instrumental or has vocals (default instrumental). " +
    "Keep the editor's intent; it is background music for a video, so mention that if it fits. Reply with the prompt only, no preamble or quotes.",
};

export function instructionRoutes(ctx: Ctx, opts: { fetch?: FetchFn } = {}) {
  const r = new Hono<AppEnv>();
  const f: FetchFn = opts.fetch ?? ((input, init) => fetch(input, init));

  r.get("/instructions", (c) => c.json(withDefaults(readInstructions(ctx))));

  r.put("/instructions", async (c) => {
    const body = await jsonBody(c, SaveInstructionsRequest, 512 * 1024);
    const next = { ...readInstructions(ctx) };
    for (const key of ["editing", "music"] as const) {
      const value = body[key];
      if (value === undefined) continue;
      // Empty, null or the built-in text itself all mean "use the built-in text".
      if (value === null || !value.trim() || value.trim() === withDefaults({}).defaults[key].trim()) delete next[key];
      else next[key] = value;
    }
    await writeFile(instructionsPath(ctx), JSON.stringify(next, null, 2) + "\n");
    ctx.log(`[instructions] saved (${Object.keys(next).join(", ") || "defaults"})`);
    return c.json(withDefaults(next));
  });

  const prompts = () => readJson<SavedPrompt[]>(promptsPath(ctx), []);
  r.get("/prompts", (c) => c.json({ prompts: prompts() }));

  r.post("/prompts", async (c) => {
    const body = await jsonBody(c, SavePromptRequest);
    const title = body.title || body.text.replace(/\s+/g, " ").slice(0, 60) + (body.text.length > 60 ? "…" : "");
    const prompt: SavedPrompt = { id: newId("prm"), kind: body.kind, title, text: body.text, createdAt: new Date().toISOString() };
    await writeFile(promptsPath(ctx), JSON.stringify([prompt, ...prompts()].slice(0, 500), null, 2) + "\n");
    return c.json({ prompt }, 201);
  });

  r.delete("/prompts/:id", async (c) => {
    const id = c.req.param("id");
    const all = prompts();
    if (!all.some((p) => p.id === id)) throw notFound(`prompt ${id}`);
    await writeFile(promptsPath(ctx), JSON.stringify(all.filter((p) => p.id !== id), null, 2) + "\n");
    return c.json({ ok: true as const });
  });

  r.post("/prompts/improve", async (c) => {
    const body = await jsonBody(c, ImprovePromptRequest);
    const saved = providerStore(ctx).secrets().filter((p) => p.enabled && p.apiKey && p.model);
    // The model picked for editing when it is one of these providers; else OpenRouter, then Gemini.
    const picked = isApiProvider(body.agent) ? saved.find((p) => p.id === body.agent) : undefined;
    const order: ApiProviderId[] = ["openrouter", "aistudio"];
    const provider = picked ?? order.map((id) => saved.find((p) => p.id === id)).find(Boolean);
    if (!provider) throw badRequest("improve_unavailable", "Improve uses one of your AI providers. Add Gemini or OpenRouter in Settings → AI providers.");
    const model = picked && body.model ? body.model : provider.model;
    try {
      const res = await chatCompletion({
        provider: provider.id, apiKey: provider.apiKey, model,
        messages: [{ role: "system", content: IMPROVE_SYSTEM[body.kind] }, { role: "user", content: body.text }],
        maxTokens: 1200,
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(90_000)]),
      }, f);
      const text = (res.message.content ?? "").trim().replace(/^["“](.*)["”]$/s, "$1");
      if (!text) throw new Error("The model returned nothing.");
      return c.json({ text, provider: provider.id, model } satisfies ImprovePromptResult);
    } catch (err) {
      throw badRequest("improve_failed", `Could not improve the prompt (${model}): ${(err as Error).message}`);
    }
  });

  return r;
}
