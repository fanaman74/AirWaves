import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { portableSchema, type ChatMessage } from "@scarlet/shared";
import { runApi, type ApiToolBox } from "./api.js";
import type { RunAgentOptions, RunnerEvent } from "./types.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "airwave-api-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

/** A model that answers each request with the next scripted message, and records what it was sent. */
function scriptedModel(script: Partial<ChatMessage>[]) {
  const sent: { url: string; body: { model: string; messages: ChatMessage[]; tools?: unknown[] }; auth: string | null }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init!.body)), auth: new Headers(init!.headers).get("authorization") });
    const message = script.shift();
    if (!message) return new Response("{}", { status: 500 });
    return Response.json({ choices: [{ message: { role: "assistant", content: null, ...message } }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
  }) as typeof fetch;
  return { f, sent };
}

function fakeTools(): ApiToolBox & { called: { name: string; args: unknown }[]; closed: boolean } {
  const box = {
    called: [] as { name: string; args: unknown }[],
    closed: false,
    tools: [
      { type: "function" as const, function: { name: "timeline_get", parameters: { type: "object", properties: {} } } },
      { type: "function" as const, function: { name: "task_question", parameters: { type: "object", properties: { text: { type: "string" } } } } },
    ],
    async call(name: string, args: Record<string, unknown>) {
      box.called.push({ name, args });
      return { text: name === "timeline_get" ? "{\"clips\":3}" : "Question posted to the editor.", isError: false };
    },
    async close() { box.closed = true; },
  };
  return box;
}

const base = (events: RunnerEvent[]): RunAgentOptions => ({
  agent: "openrouter",
  model: "openai/gpt-5",
  apiKey: "sk-or-test",
  systemPrompt: "You edit video.",
  instruction: "Tighten the intro.",
  cwd,
  mcp: { command: "node", args: [], env: {} },
  onEvent: (ev) => events.push(ev),
});

it("runs tools the model calls until it answers, then returns its summary", async () => {
  const { f, sent } = scriptedModel([
    { content: "I'll tighten the intro.", tool_calls: [{ id: "a", type: "function", function: { name: "timeline_get", arguments: "{}" } }] },
    { content: "Tightened the intro by 4 seconds." },
  ]);
  const box = fakeTools();
  const events: RunnerEvent[] = [];
  const res = await runApi(base(events), { fetch: f, toolbox: async () => box });

  expect(res).toMatchObject({ ok: true, summary: "Tightened the intro by 4 seconds." });
  expect(res.usage).toMatchObject({ inputTokens: 200, outputTokens: 20, model: "openai/gpt-5" });
  expect(box.called).toEqual([{ name: "timeline_get", args: {} }]);
  expect(box.closed).toBe(true);
  expect(sent[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(sent[0]!.auth).toBe("Bearer sk-or-test");
  expect(sent[1]!.body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "a", content: "{\"clips\":3}" });
  expect(events.map(e => e.type)).toEqual(["log", "log", "tool", "log"]);
});

it("stops on a question and resumes the same conversation with the answer", async () => {
  const first = scriptedModel([{ tool_calls: [{ id: "q", type: "function", function: { name: "task_question", arguments: "{\"text\":\"Keep the joke?\"}" } }] }]);
  const asked = await runApi({ ...base([]), agent: "aistudio", model: "gemini-2.5-pro" }, { fetch: first.f, toolbox: async () => fakeTools() });
  expect(asked).toMatchObject({ ok: true, question: "Keep the joke?", questionPosted: true });
  expect(first.sent[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");

  const second = scriptedModel([{ content: "Kept the joke." }]);
  const resumed = await runApi({ ...base([]), agent: "aistudio", model: "gemini-2.5-pro", instruction: "Yes, keep it.", resumeSession: asked.sessionId },
    { fetch: second.f, toolbox: async () => fakeTools() });
  expect(resumed).toMatchObject({ ok: true, summary: "Kept the joke.", sessionId: asked.sessionId });
  const roles = second.sent[0]!.body.messages.map(m => m.role);
  expect(roles).toEqual(["system", "user", "assistant", "tool", "user"]);
});

it("reports a missing key and a provider error plainly", async () => {
  expect(await runApi({ ...base([]), apiKey: undefined })).toMatchObject({ ok: false, error: expect.stringContaining("Settings → AI providers") });
  const f = (async () => new Response(JSON.stringify({ error: { message: "API key not valid." } }), { status: 401 })) as typeof fetch;
  const res = await runApi(base([]), { fetch: f, toolbox: async () => fakeTools() });
  expect(res).toMatchObject({ ok: false, error: "OpenRouter: The key was refused. API key not valid." });
});

it("turns MCP tool schemas into ones Gemini accepts", () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      range: { type: "array", items: [{ type: "number" }, { type: "number" }], minItems: 2 },
      mode: { anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] },
      kind: { const: "cut" },
      note: { type: ["string", "null"], default: "x" },
      ref: { $ref: "#/definitions/T" },
    },
    required: ["range", "missing"],
    definitions: { T: { type: "object", properties: { at: { type: "number" } } } },
  };
  expect(portableSchema(schema)).toEqual({
    type: "object",
    properties: {
      range: { type: "array", items: { type: "number" }, minItems: 2 },
      mode: { type: "string", enum: ["a", "b"], nullable: true },
      kind: { type: "string", enum: ["cut"] },
      note: { type: "string", nullable: true },
      ref: { type: "object", properties: { at: { type: "number" } } },
    },
    required: ["range"],
  });
});
