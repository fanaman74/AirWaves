/**
 * AirWaves: Settings → AI providers. The editor adds a provider by API key (Google AI Studio or OpenRouter),
 * tests the key, picks a model from the provider's own list, tests the model and saves.
 *
 * Keys live in `providers.json` in the library, owner-only like the access token. The interface only ever
 * gets a masked key back; agent hosts read the whole key to run requests.
 */
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId } from "@scarlet/timeline";
import { Hono } from "hono";
import { writePrivateFile } from "@scarlet/agent/dist/private-files.js";
import {
  ApiProviderId, DEFAULT_MUSIC_MODEL, GenerateMusicRequest, SaveApiProviderRequest, TestApiKeyRequest, TestApiModelRequest, TestMusicRequest,
  generateMusic, listApiModels, listMusicModels, maskApiKey, testApiKey, testApiModel,
  type TestMusicResult,
  type ApiProviderSecret, type ApiProviderStatus, type FetchFn,
} from "@scarlet/shared";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, HttpError, notFound } from "../errors.js";
import { now } from "../db.js";
import { ingestMedia } from "../services/ingest.js";
import { requestAttempt, requireLocalPauseTarget, requireProjectEditAttempt } from "../services/taskAttempt.js";
import { jsonBody, requireProject } from "./util.js";

interface StoredProvider {
  apiKey: string;
  model: string;
  modelLabel?: string;
  musicModel?: string;
  enabled: boolean;
  savedAt: string;
}

type Store = Partial<Record<ApiProviderId, StoredProvider>>;

export class ProviderStore {
  private cache?: Store;
  constructor(readonly path: string) {}

  read(): Store {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(readFileSync(this.path, "utf8")) as Store;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  get(id: ApiProviderId): StoredProvider | undefined {
    return this.read()[id];
  }

  async put(id: ApiProviderId, value: StoredProvider | undefined): Promise<void> {
    const next = { ...this.read() };
    if (value) next[id] = value;
    else delete next[id];
    await writePrivateFile(this.path, JSON.stringify(next, null, 2) + "\n");
    this.cache = next;
  }

  status(id: ApiProviderId): ApiProviderStatus {
    const p = this.get(id);
    return p
      ? { id, configured: true, enabled: p.enabled, keyPreview: maskApiKey(p.apiKey), model: p.model, modelLabel: p.modelLabel, musicModel: p.musicModel, savedAt: p.savedAt }
      : { id, configured: false, enabled: false };
  }

  secrets(): ApiProviderSecret[] {
    return Object.entries(this.read()).flatMap(([id, p]) =>
      p && ApiProviderId.safeParse(id).success ? [{ id: id as ApiProviderId, apiKey: p.apiKey, model: p.model, modelLabel: p.modelLabel, enabled: p.enabled }] : []);
  }
}

export function providerRoutes(ctx: Ctx, opts: { fetch?: FetchFn; store?: ProviderStore } = {}) {
  const r = new Hono<AppEnv>();
  const store = opts.store ?? new ProviderStore(join(ctx.paths.root, "providers.json"));
  const f: FetchFn = opts.fetch ?? ((input, init) => fetch(input, init));

  const providerId = (raw: string) => {
    const parsed = ApiProviderId.safeParse(raw);
    if (!parsed.success) throw notFound(`provider ${raw}`);
    return parsed.data;
  };
  /** The key typed in the form, or the saved one when the form left it blank. */
  const keyFor = (id: ApiProviderId, typed?: string) => {
    const key = typed ?? store.get(id)?.apiKey;
    if (!key) throw badRequest("api_key_required", "Enter an API key first.");
    return key;
  };

  r.get("/providers", (c) => c.json({ providers: ApiProviderId.options.map((id) => store.status(id)) }));

  r.get("/providers/secrets", (c) => c.json({ providers: store.secrets() }));

  r.post("/providers/:id/test-key", async (c) => {
    const id = providerId(c.req.param("id"));
    const { apiKey } = await jsonBody(c, TestApiKeyRequest);
    return c.json(await testApiKey(id, keyFor(id, apiKey), f));
  });

  r.post("/providers/:id/models", async (c) => {
    const id = providerId(c.req.param("id"));
    const { apiKey } = await jsonBody(c, TestApiKeyRequest);
    try {
      return c.json({ models: await listApiModels(id, keyFor(id, apiKey), f) });
    } catch (err) {
      throw badRequest("models_unavailable", `Could not load models: ${(err as Error).message}`);
    }
  });

  r.post("/providers/:id/test-model", async (c) => {
    const id = providerId(c.req.param("id"));
    const { apiKey, model } = await jsonBody(c, TestApiModelRequest);
    return c.json(await testApiModel(id, keyFor(id, apiKey), model, f));
  });

  r.put("/providers/:id", async (c) => {
    const id = providerId(c.req.param("id"));
    const body = await jsonBody(c, SaveApiProviderRequest);
    const apiKey = keyFor(id, body.apiKey);
    const musicModel = body.musicModel === undefined ? store.get(id)?.musicModel : body.musicModel || undefined;
    await store.put(id, { apiKey, model: body.model, modelLabel: body.modelLabel, ...(id === "openrouter" && musicModel && { musicModel }), enabled: body.enabled, savedAt: new Date().toISOString() });
    ctx.log(`[providers] saved ${id} model=${body.model}`);
    return c.json({ provider: store.status(id) });
  });

  // -- music (OpenRouter audio models: Google Lyria) ---------------------------

  r.post("/providers/openrouter/music-models", async (c) => {
    const { apiKey } = await jsonBody(c, TestApiKeyRequest);
    try {
      return c.json({ models: await listMusicModels(keyFor("openrouter", apiKey), f) });
    } catch (err) {
      throw badRequest("models_unavailable", `Could not load music models: ${(err as Error).message}`);
    }
  });

  r.post("/providers/openrouter/test-music", async (c) => {
    const { apiKey, model, prompt } = await jsonBody(c, TestMusicRequest);
    const started = Date.now();
    try {
      const song = await generateMusic({ apiKey: keyFor("openrouter", apiKey), model,
        prompt: prompt ?? "A short, upbeat instrumental for a drone video over the sea: warm synths, light drums.", signal: c.req.raw.signal }, f);
      return c.json({ ok: true, ms: Date.now() - started, mime: song.mime, bytes: song.bytes.length,
        audioBase64: Buffer.from(song.bytes).toString("base64"), text: song.text.slice(0, 500) } satisfies TestMusicResult);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      return c.json({ ok: false, error: (err as Error).message, ms: Date.now() - started } satisfies TestMusicResult);
    }
  });

  /** Generate a track and add it to the project's media, where an edit can place it like any other audio. */
  r.post("/projects/:id/music", async (c) => {
    const project = requireProject(ctx, c.req.param("id"));
    const attempt = requestAttempt(c.req.raw);
    const check = () => requireLocalPauseTarget(requireProjectEditAttempt(ctx, attempt, project.id));
    check();
    const body = await jsonBody(c, GenerateMusicRequest);
    const saved = store.get("openrouter");
    if (!saved?.apiKey) throw badRequest("music_unavailable", "Music needs an OpenRouter key: add one in Settings → AI providers.");
    const model = body.model ?? saved.musicModel ?? DEFAULT_MUSIC_MODEL;
    const signal = AbortSignal.any([ctx.projectSignal(project.id), c.req.raw.signal]);
    let song;
    try {
      song = await generateMusic({ apiKey: saved.apiKey, model, prompt: body.prompt, signal }, f);
    } catch (err) {
      throw badRequest("music_failed", `Music generation failed (${model}): ${(err as Error).message}`);
    }
    ctx.paths.ensureProject(project.id);
    const work = join(ctx.paths.tmp, newId("music"));
    await mkdir(work, { recursive: true });
    try {
      const file = join(work, `music.${song.ext}`);
      await writeFile(file, song.bytes);
      const hash = await ctx.render.hashFile(file, undefined, signal);
      const name = `${(body.name ?? "Music").replace(/\.(wav|mp3|ogg|flac|m4a)$/i, "")}.${song.ext}`;
      const media = await ctx.track(ingestMedia(ctx, project, { type: "upload", path: file, hash }, {
        name, kind: "audio", checkAttempt: check,
        transcription: { provider: undefined, revision: 0, signal },
        by: { by: "agent", name: c.var.user.name, model, prompt: body.prompt, createdAt: now() },
        uploadedBy: c.var.user.id,
      }), project.id);
      let ready = media;
      for (let i = 0; i < 200 && ready?.status === "ingesting"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        ready = ctx.repos.projects.getMedia(media.id) ?? ready;
      }
      ctx.log(`[music] ${project.id}: ${model} → ${media.id} (${song.bytes.length} bytes ${song.mime})`);
      return c.json({ media: ready, model, ...(song.text && { text: song.text.slice(0, 1000) }) }, 201);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  r.delete("/providers/:id", async (c) => {
    const id = providerId(c.req.param("id"));
    await store.put(id, undefined);
    ctx.log(`[providers] removed ${id}`);
    return c.json({ ok: true as const });
  });

  return r;
}
