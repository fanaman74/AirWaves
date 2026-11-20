/**
 * AirWaves: Settings → AI providers. The editor adds a provider by API key (Google AI Studio or OpenRouter),
 * tests the key, picks a model from the provider's own list, tests the model and saves.
 *
 * Keys live in `providers.json` in the library, owner-only like the access token. The interface only ever
 * gets a masked key back; agent hosts read the whole key to run requests.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { writePrivateFile } from "@scarlet/agent/dist/private-files.js";
import {
  ApiProviderId, SaveApiProviderRequest, TestApiKeyRequest, TestApiModelRequest,
  listApiModels, maskApiKey, testApiKey, testApiModel,
  type ApiProviderSecret, type ApiProviderStatus, type FetchFn,
} from "@scarlet/shared";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, notFound } from "../errors.js";
import { jsonBody } from "./util.js";

interface StoredProvider {
  apiKey: string;
  model: string;
  modelLabel?: string;
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
      ? { id, configured: true, enabled: p.enabled, keyPreview: maskApiKey(p.apiKey), model: p.model, modelLabel: p.modelLabel, savedAt: p.savedAt }
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
    await store.put(id, { apiKey, model: body.model, modelLabel: body.modelLabel, enabled: body.enabled, savedAt: new Date().toISOString() });
    ctx.log(`[providers] saved ${id} model=${body.model}`);
    return c.json({ provider: store.status(id) });
  });

  r.delete("/providers/:id", async (c) => {
    const id = providerId(c.req.param("id"));
    await store.put(id, undefined);
    ctx.log(`[providers] removed ${id}`);
    return c.json({ ok: true as const });
  });

  return r;
}
