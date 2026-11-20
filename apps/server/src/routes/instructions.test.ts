import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { readInstructions } from "./instructions.js";

let dataDir: string;
let app: ScarletApp;
const sent: { url: string; body: { model: string; messages: { role: string; content: string }[] } }[] = [];

beforeEach(async () => {
  sent.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    sent.push({ url: String(url), body });
    return Response.json({ choices: [{ message: { role: "assistant", content: "\"Cut a tight 45-second highlight.\"" }, finish_reason: "stop" }] });
  }));
  dataDir = await mkdtemp(join(tmpdir(), "airwave-instructions-"));
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

it("shows the built-in instructions, saves the editor's own and resets them", async () => {
  type I = { editing?: string; music?: string; defaults: { editing: string; music: string } };
  const first = await call<I>("GET", "/instructions");
  expect(first.json.editing).toBeUndefined();
  expect(first.json.defaults.editing).toContain("# You are editing a video in AirWaves");

  const saved = await call<I>("PUT", "/instructions", { editing: "# House rules", music: "Always instrumental." });
  expect(saved.json).toMatchObject({ editing: "# House rules", music: "Always instrumental." });
  expect(readInstructions(app.ctx)).toEqual({ editing: "# House rules", music: "Always instrumental." });

  // Saving the built-in text, or null, goes back to the built-in version.
  await call("PUT", "/instructions", { editing: first.json.defaults.editing });
  expect(readInstructions(app.ctx)).toEqual({ music: "Always instrumental." });
  await call("PUT", "/instructions", { music: null });
  expect((await call<I>("GET", "/instructions")).json.music).toBeUndefined();
});

it("saves, lists and deletes prompts", async () => {
  const made = await call<{ prompt: { id: string; title: string; kind: string } }>("POST", "/prompts", { kind: "music", text: "Calm ambient pads, 80 BPM" });
  expect(made.status).toBe(201);
  expect(made.json.prompt).toMatchObject({ kind: "music", title: "Calm ambient pads, 80 BPM" });
  expect((await call<{ prompts: unknown[] }>("GET", "/prompts")).json.prompts).toHaveLength(1);
  expect((await call("DELETE", `/prompts/${made.json.prompt.id}`)).status).toBe(200);
  expect((await call("DELETE", `/prompts/${made.json.prompt.id}`)).status).toBe(404);
  expect((await call<{ prompts: unknown[] }>("GET", "/prompts")).json.prompts).toHaveLength(0);
});

it("improves a prompt with the picked provider, or asks for one", async () => {
  const none = await call("POST", "/prompts/improve", { kind: "edit", text: "make it short" });
  expect(none.status).toBe(400);
  expect(JSON.stringify(none.json)).toContain("AI providers");

  await call("PUT", "/providers/aistudio", { apiKey: "gemini-key-123", model: "gemini-2.5-flash" });
  await call("PUT", "/providers/openrouter", { apiKey: "router-key-123", model: "openai/gpt-5" });

  // No API provider picked for editing: OpenRouter first.
  const any = await call<{ text: string; provider: string; model: string }>("POST", "/prompts/improve", { kind: "music", text: "sea drone", agent: "claude" });
  expect(any.json).toEqual({ text: "Cut a tight 45-second highlight.", provider: "openrouter", model: "openai/gpt-5" });
  expect(sent.at(-1)!.body.messages[0]!.content).toContain("Lyria");

  // The picked provider and model win.
  const picked = await call<{ provider: string; model: string }>("POST", "/prompts/improve", { kind: "edit", text: "make it short", agent: "aistudio", model: "gemini-2.5-pro" });
  expect(picked.json).toMatchObject({ provider: "aistudio", model: "gemini-2.5-pro" });
  expect(sent.at(-1)!.url).toContain("generativelanguage.googleapis.com");
  expect(sent.at(-1)!.body.messages[1]!.content).toBe("make it short");
});
