/**
 * AirWaves: run a request through an AI provider's HTTP API (Google AI Studio or OpenRouter) with the editor's own key.
 *
 * There is no CLI here: this runner is the agent loop. It starts the same AirWaves MCP server the CLIs get,
 * offers its tools to the model as function calls, runs each call the model makes and sends back the result,
 * until the model answers without a call. The conversation is kept in the task folder so a run that asked
 * the editor a question can continue with the answer.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ApiProviderError, chatCompletion, isApiProvider, portableSchema,
  type AgentUsage, type ApiProviderId, type ChatMessage, type ChatTool, type FetchFn,
} from "@scarlet/shared";
import { writePrivateFile } from "../private-files.js";
import { addUsage } from "./usage.js";
import { briefInput, isQuestionTool, type RunAgentOptions, type RunAgentResult, type RunnerEvent } from "./types.js";

/** A run that keeps calling tools without finishing is stopped here. Real editing runs use well under 100. */
export const MAX_TURNS = 150;
/** Each tool result goes back to the model cut to this many characters. */
const MAX_TOOL_RESULT = 60_000;
/** AirWaves's tools wait up to 300 s for evidence still being measured (capabilities.ts). */
const TOOL_TIMEOUT_MS = 330_000;

export interface ApiCredentials {
  apiKey: string;
  model: string;
}

/** How an API run reaches its tools. Tests pass a fake; runs start the AirWaves MCP server. */
export interface ApiToolBox {
  tools: ChatTool[];
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

export interface ApiRunDeps {
  /** The saved key and model for the provider. Hosts read them from the engine. */
  credentials?: (provider: ApiProviderId) => Promise<ApiCredentials | undefined>;
  toolbox?: (opts: RunAgentOptions) => Promise<ApiToolBox>;
  fetch?: FetchFn;
}

/** Start the AirWaves MCP server as the CLIs would, and list its tools. */
export async function mcpToolBox(opts: RunAgentOptions): Promise<ApiToolBox> {
  const transport = new StdioClientTransport({
    command: opts.mcp.command,
    args: opts.mcp.args,
    env: { ...(process.env as Record<string, string>), ...opts.mcp.env },
    cwd: opts.cwd,
    stderr: "pipe",
  });
  const client = new Client({ name: "airwaves-api-runner", version: "0.1.0" });
  await client.connect(transport);
  const listed = await client.listTools();
  const tools: ChatTool[] = listed.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: (t.description ?? "").slice(0, 4000), parameters: portableSchema(t.inputSchema) },
  }));
  return {
    tools,
    async call(name, args, signal) {
      const res = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: TOOL_TIMEOUT_MS, resetTimeoutOnProgress: true });
      return { text: flattenContent(res.content), isError: !!res.isError };
    },
    close: () => client.close(),
  };
}

function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content ?? "");
  return content.map((c: { type?: string; text?: string }) => (c?.type === "text" ? c.text ?? "" : c?.type === "image" ? "[image]" : JSON.stringify(c))).join("\n");
}

interface SavedSession {
  provider: ApiProviderId;
  model: string;
  messages: ChatMessage[];
}

const sessionPath = (cwd: string, id: string) => join(cwd, ".scarlet", `api-session-${id.replace(/[^\w-]/g, "")}.json`);

async function loadSession(cwd: string, id: string): Promise<SavedSession | undefined> {
  try {
    return JSON.parse(await readFile(sessionPath(cwd, id), "utf8")) as SavedSession;
  } catch {
    return undefined;
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const SYSTEM_SUFFIX = `

You are running inside AirWaves through a direct API connection. Your only tools are the function calls listed with this request: use them to inspect and edit the project. When the work is done, reply with a short plain-text summary of what you changed and call no more tools. To ask the editor something, call task_question and then stop.`;

export async function runApi(opts: RunAgentOptions, deps: ApiRunDeps = {}): Promise<RunAgentResult> {
  const provider = opts.agent;
  if (!isApiProvider(provider)) return { ok: false, summary: "", error: `${provider} is not an API provider` };
  const creds = opts.apiKey ? { apiKey: opts.apiKey, model: opts.model ?? "" } : await deps.credentials?.(provider);
  if (!creds?.apiKey) return { ok: false, summary: "", error: "No API key is saved for this provider. Add one in Settings → AI providers." };
  const model = opts.model || creds.model;
  if (!model) return { ok: false, summary: "", error: "Choose a model for this provider in Settings → AI providers." };

  await mkdir(join(opts.cwd, ".scarlet"), { recursive: true });
  const resumed = opts.resumeSession ? await loadSession(opts.cwd, opts.resumeSession) : undefined;
  if (opts.resumeSession && !resumed) return { ok: false, summary: "", resumeFailed: true, error: "The earlier conversation was not found." };
  const sessionId = opts.resumeSession ?? randomUUID();
  const messages: ChatMessage[] = resumed?.messages ?? [{ role: "system", content: opts.systemPrompt + SYSTEM_SUFFIX }];
  messages.push({ role: "user", content: opts.instruction });
  const save = () => writePrivateFile(sessionPath(opts.cwd, sessionId), JSON.stringify({ provider, model, messages } satisfies SavedSession));

  const emit = (ev: RunnerEvent) => { try { opts.onEvent(ev); } catch { /* the host's problem */ } };
  let usage: AgentUsage | undefined;
  const texts: string[] = [];
  const signals = [opts.signal, opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined].filter((s): s is AbortSignal => !!s);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;

  let box: ApiToolBox;
  try {
    box = await (deps.toolbox ?? mcpToolBox)(opts);
  } catch (err) {
    return { ok: false, summary: "", sessionId, error: `AirWaves's editing tools failed to start: ${(err as Error).message}` };
  }
  emit({ type: "log", text: `Connected to ${provider === "aistudio" ? "Google AI Studio" : "OpenRouter"} · ${model} · ${box.tools.length} tools` });

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (signal?.aborted) return { ok: false, summary: texts.at(-1) ?? "", aborted: !opts.signal?.aborted ? undefined : true, timedOut: opts.signal?.aborted ? undefined : true, sessionId, usage };
      let res;
      try {
        res = await chatCompletion({ provider, apiKey: creds.apiKey, model, messages, tools: box.tools, signal }, deps.fetch);
      } catch (err) {
        if (signal?.aborted) return { ok: false, summary: "", aborted: opts.signal?.aborted || undefined, timedOut: !opts.signal?.aborted || undefined, sessionId, usage };
        const msg = err instanceof ApiProviderError ? err.message : (err as Error).message;
        // Rate limits pass; wait once and try the turn again.
        if (err instanceof ApiProviderError && err.status === 429 && turn < MAX_TURNS - 1) {
          emit({ type: "log", text: "Rate limited; waiting 20 s before trying again." });
          await new Promise((r) => setTimeout(r, 20_000));
          continue;
        }
        return { ok: false, summary: texts.at(-1) ?? "", error: `${provider === "aistudio" ? "Gemini" : "OpenRouter"}: ${msg}`, sessionId, usage };
      }
      if (res.usage) {
        usage = addUsage(usage, { model, inputTokens: res.usage.inputTokens ?? 0, outputTokens: res.usage.outputTokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
        if (usage) opts.onUsage?.(usage);
      }
      messages.push(res.message);
      const text = res.message.content?.trim();
      if (text) {
        texts.push(text);
        emit({ type: "log", text });
      }
      const calls = res.message.tool_calls ?? [];
      if (!calls.length) {
        await save();
        return { ok: true, summary: text || texts.at(-1) || "Done.", sessionId, usage };
      }
      let question: { text: string; posted: boolean } | undefined;
      for (const call of calls) {
        const name = call.function.name;
        const args = parseArgs(call.function.arguments);
        if (isQuestionTool(name)) {
          const q = String(args.text ?? briefInput(args));
          emit({ type: "question", text: q, data: { tool: name, toolUseId: call.id } });
          question = { text: q, posted: false };
        } else {
          emit({ type: "tool", text: `airwaves.${name} ${briefInput(args)}`.trim(), data: { tool: name, input: args, toolUseId: call.id } });
        }
        let result: { text: string; isError: boolean };
        try {
          result = await box.call(name, args, signal);
        } catch (err) {
          result = { text: `Tool failed: ${(err as Error).message}`, isError: true };
        }
        if (question && isQuestionTool(name)) question.posted = !result.isError;
        if (result.isError) emit({ type: "error", text: `Tool error: ${briefInput(result.text, 400)}`, data: { toolUseId: call.id } });
        const content = result.text.length > MAX_TOOL_RESULT ? `${result.text.slice(0, MAX_TOOL_RESULT)}\n…(cut: ${result.text.length - MAX_TOOL_RESULT} more characters)` : result.text;
        messages.push({ role: "tool", tool_call_id: call.id, name, content: content || "(no output)" });
      }
      await save();
      if (question) return { ok: true, summary: texts.at(-1) ?? "", question: question.text, questionPosted: question.posted, sessionId, usage };
    }
    return { ok: false, summary: texts.at(-1) ?? "", error: `Stopped after ${MAX_TURNS} turns without finishing.`, sessionId, usage };
  } finally {
    await box.close().catch(() => undefined);
  }
}
