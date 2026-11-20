/**
 * Gemini via Antigravity CLI (`agy acp`), speaking Agent Client Protocol (JSON-RPC 2.0) over stdio.
 * Runs with `--sandbox` and an explicit `session/request_permission` handler that allows only
 * AirWaves MCP tools and rejects all built-in file/shell tools. Supports model selection,
 * thinking level (`thought_level`), session resume (`session/resume`), and token usage reporting.
 */
import {
  briefInput,
  DEFAULT_STALL_MS,
  isQuestionTool,
  planEvent,
  prettyToolName,
  type McpSpec,
  type RunAgentOptions,
  type RunAgentResult,
  type RunnerEvent,
} from "./types.js";
import { earlyResult, jsonLine, resolveCli, spawnLines, tailSummary } from "./spawn.js";
import { geminiUsage, usageWithModel } from "./usage.js";
import type { AgentUsage, PlanStep } from "@scarlet/shared";

interface AcpConfigOption {
  id?: string;
  configId?: string;
  category?: string;
  currentValue?: string;
  options?: unknown[];
}

export interface GeminiParseState {
  texts: string[];
  /** Accumulated streamed assistant message (delta chunks). */
  partial: string;
  /** Accumulated streamed reasoning/thought chunks. */
  thought: string;
  /** Tool call names keyed by toolCallId so updates know which tool finished or failed. */
  toolNames: Map<string, string>;
  pendingQuestionId?: string;
  question?: string;
  questionPosted: boolean;
  shouldStop: boolean;
  completed: boolean;
  failed?: string;
  model?: string;
  sessionId?: string;
  usage?: AgentUsage;
  plan?: string;
}

export function newGeminiState(): GeminiParseState {
  return {
    texts: [],
    partial: "",
    thought: "",
    toolNames: new Map(),
    questionPosted: false,
    shouldStop: false,
    completed: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const rec = asRecord(part);
        if (!rec) return "";
        if (typeof rec.text === "string") return rec.text;
        return contentText(rec.content);
      })
      .join("");
  }
  const rec = asRecord(content);
  if (!rec) return "";
  if (typeof rec.text === "string") return rec.text;
  if (rec.content !== undefined) return contentText(rec.content);
  return "";
}

function flushThought(st: GeminiParseState, events: RunnerEvent[]) {
  if (st.thought.trim()) {
    events.push({ type: "log", text: `(thinking) ${briefInput(st.thought.trim(), 200)}`, data: { kind: "reasoning" } });
  }
  st.thought = "";
}

function flushPartial(st: GeminiParseState, events: RunnerEvent[]) {
  if (st.partial.trim()) {
    st.texts.push(st.partial);
    events.push({ type: "log", text: st.partial });
  }
  st.partial = "";
}

function flushStreams(st: GeminiParseState, events: RunnerEvent[]) {
  flushThought(st, events);
  flushPartial(st, events);
}

/** Whether an ACP `session/request_permission` request targets a AirWaves MCP tool. */
export function isScarletMcpPermission(params: unknown): boolean {
  const p = asRecord(params);
  const tc = asRecord(p?.toolCall);
  if (!tc) return false;
  const meta = asRecord(tc._meta);
  for (const server of [meta?.mcpServer, meta?.server, meta?.serverName, tc.mcpServer, tc.server, tc.serverName]) {
    if (typeof server === "string" && server.toLowerCase() === "scarlet") return true;
  }
  for (const candidate of [tc.name, tc.toolName, tc.title]) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim().toLowerCase();
    if (/^(mcp__scarlet__|mcp_scarlet_|scarlet__|scarlet\.|scarlet\/|scarlet:)/.test(trimmed)) return true;
  }
  return false;
}

/** Pick the best ACP permission outcome for allow vs reject. */
export function permissionOutcome(params: unknown, allow: boolean): Record<string, unknown> {
  const p = asRecord(params);
  const options = Array.isArray(p?.options) ? p.options.map(asRecord).filter((o): o is Record<string, unknown> => Boolean(o)) : [];
  const preferredKinds = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of preferredKinds) {
    const match = options.find((o) => o.kind === kind && typeof o.optionId === "string");
    if (match) return { outcome: "selected", optionId: match.optionId };
  }
  return { outcome: "cancelled" };
}

function extractToolName(update: Record<string, unknown>): string {
  return asString(update.name) ?? asString(update.toolName) ?? asString(update.title) ?? "tool";
}

function isFailedOutput(rawOutput: unknown, content: unknown): boolean {
  const out = asRecord(rawOutput);
  if (out && (out.isError === true || out.is_error === true || Boolean(out.error))) return true;
  const c = asRecord(content);
  if (c && (c.isError === true || c.is_error === true)) return true;
  return false;
}

/** Parse one ACP `session/update` payload (`params.update`). */
export function parseGeminiAcpUpdate(rawUpdate: unknown, st: GeminiParseState): RunnerEvent[] {
  const update = asRecord(rawUpdate);
  if (!update) return [];
  const events: RunnerEvent[] = [];
  const kind = asString(update.sessionUpdate);

  switch (kind) {
    case "agent_message_chunk": {
      flushThought(st, events);
      const text = contentText(update.content ?? update.text);
      if (text) st.partial += text;
      break;
    }
    case "agent_thought_chunk": {
      const text = contentText(update.content ?? update.text);
      if (text) st.thought += text;
      break;
    }
    case "tool_call": {
      flushStreams(st, events);
      const rawName = extractToolName(update);
      const name = prettyToolName(rawName);
      const id = asString(update.toolCallId) ?? asString(update.id);
      if (id) st.toolNames.set(id, rawName);
      const input = update.rawInput ?? update.parameters ?? update.input ?? update.arguments;
      const status = asString(update.status);
      if (isQuestionTool(rawName)) {
        const inputRec = asRecord(input);
        const qText = asString(inputRec?.text);
        if (!st.question && (qText || input !== undefined)) {
          const text = qText ?? briefInput(input);
          st.question = text;
          st.pendingQuestionId = id;
          events.push({ type: "question", text, data: { tool: name, ...(id ? { toolId: id } : {}) } });
        } else if (!st.pendingQuestionId && id) {
          st.pendingQuestionId = id;
        }
        if (status === "completed" || status === "failed" || status === "error") {
          const failed = status !== "completed" || isFailedOutput(update.rawOutput, update.content);
          st.questionPosted = !failed;
          st.shouldStop = true;
        }
      } else {
        events.push({
          type: "tool",
          text: `${name} ${briefInput(input)}`.trim(),
          data: { tool: name, ...(input !== undefined ? { input } : {}), ...(id ? { toolId: id } : {}) },
        });
      }
      break;
    }
    case "tool_call_update": {
      const id = asString(update.toolCallId) ?? asString(update.id);
      const rawName = (id ? st.toolNames.get(id) : undefined) ?? asString(update.name) ?? asString(update.toolName) ?? asString(update.title);
      const name = rawName ? prettyToolName(rawName) : "tool";
      const status = asString(update.status);
      const input = update.rawInput ?? update.parameters ?? update.input ?? update.arguments;
      const isQuestion = (id !== undefined && st.pendingQuestionId === id) || isQuestionTool(rawName);
      if (isQuestion) {
        if (!st.question && input !== undefined) {
          const inputRec = asRecord(input);
          const text = asString(inputRec?.text) ?? briefInput(input);
          st.question = text;
          st.pendingQuestionId = id ?? st.pendingQuestionId;
          events.push({ type: "question", text, data: { tool: name, ...(id ? { toolId: id } : {}) } });
        }
        if (status === "completed" || status === "failed" || status === "error") {
          if (!st.question) {
            st.question = briefInput(input) || "Question posted";
            events.push({ type: "question", text: st.question, data: { tool: name, ...(id ? { toolId: id } : {}) } });
          }
          const failed = status !== "completed" || isFailedOutput(update.rawOutput, update.content);
          st.questionPosted = !failed;
          st.shouldStop = true;
        }
      } else if (status === "failed" || status === "error") {
        const detail = update.rawOutput ?? update.content ?? update.error;
        events.push({
          type: "error",
          text: `${name} failed: ${briefInput(detail, 400)}`.trim(),
          data: id ? { toolId: id } : undefined,
        });
      }
      break;
    }
    case "plan": {
      if (!Array.isArray(update.entries)) break;
      const steps: PlanStep[] = [];
      for (const entry of update.entries) {
        const rec = asRecord(entry);
        const text = asString(rec?.content)?.trim();
        if (!text) continue;
        const status = asString(rec?.status);
        const state: PlanStep["state"] = status === "completed" ? "done" : status === "in_progress" ? "in_progress" : "pending";
        steps.push({ text, state });
      }
      const key = JSON.stringify(steps);
      if (key !== st.plan) {
        st.plan = key;
        events.push(planEvent(steps));
      }
      break;
    }
    case "usage_update": {
      const parsed = geminiUsage(update.usage ?? update, st.model);
      if (parsed) st.usage = parsed;
      break;
    }
    default:
      break;
  }
  return events;
}

/** Parse one JSON-RPC notification line from `agy acp` (or non-JSON output as a log line). */
export function parseGeminiLine(line: string, st: GeminiParseState): RunnerEvent[] {
  const msg = jsonLine(line);
  if (!msg) return [{ type: "log", text: line }];
  if (msg.method === "session/update") {
    const params = asRecord(msg.params);
    return parseGeminiAcpUpdate(params?.update, st);
  }
  return [];
}

/** Convert AirWaves's McpSpec to an ACP stdio MCP server entry. */
export function acpMcpServer(mcp: McpSpec): Record<string, unknown> {
  return {
    name: "scarlet",
    command: mcp.command,
    args: mcp.args,
    env: Object.keys(mcp.env)
      .sort()
      .map((name) => ({ name, value: mcp.env[name]! })),
  };
}

export interface GeminiCommand {
  file: string;
  args: string[];
}

/**
 * agy reads AirWaves's prompt from the session's own system prompt (`systemPromptMeta`), not a `GEMINI.md`: it cuts a
 * rule file off at 24,000 bytes, and a pass's prompt with the editor's skill runs past that.
 */
export function buildGeminiCommand(bin: string): GeminiCommand {
  return { file: bin, args: ["acp", "--sandbox", "--disable-telemetry"] };
}

/** `session/new` and `session/resume` meta that appends AirWaves's prompt to agy's system prompt. */
export function systemPromptMeta(systemPrompt: string) {
  return { antigravity: { systemPrompt: { append: systemPrompt } } };
}

/** How many times a run carries on after agy ended Gemini's turn on a tool AirWaves refused. */
export const MAX_CARRY_ONS = 4;

function findConfigOption(configs: AcpConfigOption[], category: string, ids: string[]): AcpConfigOption | undefined {
  return configs.find((c) => c.category === category || ids.includes(c.id ?? c.configId ?? ""));
}

function configOptionId(opt: AcpConfigOption): string | undefined {
  return opt.id ?? opt.configId;
}

function parseConfigOptions(result: Record<string, unknown>): AcpConfigOption[] {
  if (!Array.isArray(result.configOptions)) return [];
  return result.configOptions
    .map(asRecord)
    .filter((o): o is Record<string, unknown> => Boolean(o)) as AcpConfigOption[];
}

type PendingStep =
  | "initialize"
  | "authenticate"
  | "session_open"
  | "set_model"
  | "set_effort"
  | "prompt"
  | "done";

export async function runGemini(opts: RunAgentOptions): Promise<RunAgentResult> {
  const env = { ...(opts.env ?? process.env) };
  const bin = await resolveCli("agy", opts.bin, env);
  const cmd = buildGeminiCommand(bin);

  const st = newGeminiState();
  let requestId = 1;
  let step: PendingStep = "initialize";
  let triedApiKeyAuth = false;
  let resumeFailed = false;
  let cancelSent = false;
  let configOptions: AcpConfigOption[] = [];
  let hasLegacyModels = false;
  let sentUsage: AgentUsage | undefined;
  // Tools AirWaves refused during the turn under way. agy ends Gemini's turn on a refusal.
  let refused: string[] = [];
  let carryOns = 0;
  const hasApiKey = Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
  const resuming = Boolean(opts.resumeSession);

  const reportUsage = () => {
    if (!opts.onUsage || !st.usage) return;
    const now = usageWithModel(st.usage, opts.model);
    if (!now || JSON.stringify(now) === JSON.stringify(sentUsage)) return;
    sentUsage = now;
    opts.onUsage(now);
  };

  const emit = (evs: RunnerEvent[]) => {
    for (const ev of evs) opts.onEvent(ev);
  };

  let handle: ReturnType<typeof spawnLines>;

  const send = (message: Record<string, unknown>): boolean => {
    if (!handle?.child.stdin || handle.child.stdin.destroyed || !handle.child.stdin.writable) return false;
    handle.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    return true;
  };

  const sendRequest = (method: string, params: Record<string, unknown>) => {
    send({ id: ++requestId, method, params });
  };

  const cancelTurn = (): boolean => {
    if (cancelSent || step === "done" || !st.sessionId) return false;
    cancelSent = send({ method: "session/cancel", params: { sessionId: st.sessionId } });
    return cancelSent;
  };

  const stopSession = () => {
    step = "done";
    handle.child.stdin?.end();
  };

  const failSession = (message: string) => {
    st.failed = message;
    opts.onEvent({ type: "error", text: message });
    stopSession();
  };

  const sendOpenSession = () => {
    step = "session_open";
    const mcpServers = [acpMcpServer(opts.mcp)];
    const _meta = systemPromptMeta(opts.systemPrompt);
    if (opts.resumeSession) {
      sendRequest("session/resume", { sessionId: opts.resumeSession, cwd: opts.cwd, mcpServers, _meta });
    } else {
      sendRequest("session/new", { cwd: opts.cwd, mcpServers, _meta });
    }
  };

  const sendTurn = (text: string) => {
    step = "prompt";
    refused = [];
    sendRequest("session/prompt", {
      sessionId: st.sessionId!,
      prompt: [{ type: "text", text }],
    });
  };
  const sendPrompt = () => sendTurn(opts.instruction);

  // agy ends Gemini's turn as soon as AirWaves refuses one of its tools, before the model hears why, and reports the
  // turn ended as if it were finished. Tell the model what was refused and let it carry on.
  const carryOnAfterRefusal = (): boolean => {
    if (!refused.length) return false;
    const names = [...new Set(refused)].join(", ");
    if (carryOns >= MAX_CARRY_ONS) {
      failSession(`Gemini stopped after AirWaves refused ${names}, a tool that doesn't run in AirWaves, ${carryOns + 1} times.`);
      return true;
    }
    carryOns += 1;
    opts.onEvent({ type: "log", text: `AirWaves refused ${names}: only AirWaves's tools run here. Gemini carries on.`, data: { kind: "tool_refused", harnessTool: names } });
    sendTurn(`AirWaves refused ${names}: only AirWaves's own tools (the scarlet MCP server) run here, with no shell or file tools. Carry on with the request using AirWaves's tools.`);
    return true;
  };

  const maybeSetEffortThenPrompt = () => {
    if (opts.effort) {
      const thoughtOpt = findConfigOption(configOptions, "thought_level", ["thought_level", "reasoning_effort", "thinking_level"]);
      const configId = thoughtOpt ? configOptionId(thoughtOpt) : undefined;
      if (configId) {
        step = "set_effort";
        sendRequest("session/set_config_option", { sessionId: st.sessionId!, configId, value: opts.effort });
        return;
      }
    }
    sendPrompt();
  };

  handle = spawnLines(cmd.file, cmd.args, {
    cwd: opts.cwd,
    env,
    interactive: true,
    signal: opts.signal,
    interrupt: cancelTurn,
    timeoutMs: opts.timeoutMs,
    stallMs: opts.stallMs ?? DEFAULT_STALL_MS,
    onLine: (line) => {
      const msg = jsonLine(line);
      if (!msg) {
        opts.onEvent({ type: "log", text: line });
        return;
      }

      // Incoming agent -> client request or notification
      if (typeof msg.method === "string") {
        if (msg.id !== undefined) {
          if (msg.method === "session/request_permission") {
            const allow = isScarletMcpPermission(msg.params);
            if (!allow) refused.push(extractToolName(asRecord(asRecord(msg.params)?.toolCall) ?? {}));
            send({ id: msg.id, result: { outcome: permissionOutcome(msg.params, allow) } });
          } else {
            send({ id: msg.id, error: { code: -32601, message: "Unsupported by AirWaves" } });
          }
          return;
        }
        if (msg.method === "session/update") {
          const params = asRecord(msg.params);
          emit(parseGeminiAcpUpdate(params?.update, st));
          reportUsage();
          if (st.shouldStop) {
            st.shouldStop = false;
            if (!cancelTurn()) setTimeout(() => handle.kill(), 250).unref();
            else setTimeout(() => handle.kill(), 2000).unref();
          }
        }
        return;
      }

      // Response to our pending request
      if (msg.id !== requestId || step === "done") return;

      const err = asRecord(msg.error);
      if (err) {
        const detail = asString(err.message) ?? briefInput(err, 400) ?? "unknown error";
        const code = typeof err.code === "number" ? err.code : undefined;
        if (step === "session_open" && !triedApiKeyAuth && hasApiKey && (code === -32000 || /auth/i.test(detail))) {
          triedApiKeyAuth = true;
          step = "authenticate";
          sendRequest("authenticate", { methodId: "gemini-api-key" });
          return;
        }
        if (step === "session_open" && resuming) {
          resumeFailed = true;
          st.failed = `Gemini could not resume session: ${detail}`;
          stopSession();
          return;
        }
        failSession(`Gemini ${step} failed: ${detail}`);
        return;
      }

      const result = asRecord(msg.result) ?? {};
      switch (step) {
        case "initialize": {
          sendOpenSession();
          break;
        }
        case "authenticate": {
          sendOpenSession();
          break;
        }
        case "session_open": {
          st.sessionId = asString(result.sessionId) ?? opts.resumeSession;
          if (!st.sessionId) {
            failSession("Gemini session returned no sessionId");
            return;
          }
          configOptions = parseConfigOptions(result);
          const legacyModels = asRecord(result.models);
          hasLegacyModels = Boolean(legacyModels);
          const modelOpt = findConfigOption(configOptions, "model", ["model"]);
          st.model = opts.model ?? asString(modelOpt?.currentValue) ?? asString(legacyModels?.currentModelId);
          opts.onEvent({
            type: "log",
            text: `Gemini session started${st.model ? ` (${st.model})` : ""}`,
            data: { kind: "init", ...(st.model ? { model: st.model } : {}), sessionId: st.sessionId },
          });
          if (opts.model) {
            const modelConfigId = modelOpt ? configOptionId(modelOpt) : undefined;
            if (modelConfigId) {
              step = "set_model";
              sendRequest("session/set_config_option", { sessionId: st.sessionId, configId: modelConfigId, value: opts.model });
              return;
            }
            if (hasLegacyModels) {
              step = "set_model";
              sendRequest("session/set_model", { sessionId: st.sessionId, modelId: opts.model });
              return;
            }
          }
          maybeSetEffortThenPrompt();
          break;
        }
        case "set_model": {
          st.model = opts.model ?? st.model;
          const refreshed = parseConfigOptions(result);
          if (refreshed.length > 0) configOptions = refreshed;
          maybeSetEffortThenPrompt();
          break;
        }
        case "set_effort": {
          const refreshed = parseConfigOptions(result);
          if (refreshed.length > 0) configOptions = refreshed;
          sendPrompt();
          break;
        }
        case "prompt": {
          const flushEvs: RunnerEvent[] = [];
          flushStreams(st, flushEvs);
          emit(flushEvs);
          const turnUsage = geminiUsage(result.usage, st.model ?? opts.model);
          if (turnUsage) {
            st.usage = turnUsage;
            reportUsage();
          }
          const stopReason = asString(result.stopReason) ?? "end_turn";
          if (stopReason === "cancelled" && st.question) {
            stopSession();
            return;
          }
          if (stopReason === "end_turn" && carryOnAfterRefusal()) return;
          if (stopReason === "end_turn" || stopReason === "max_tokens" || stopReason === "stop_sequence") {
            st.completed = true;
            opts.onEvent({
              type: "result",
              text: tailSummary(st.texts) || "done",
              ...(result.usage ? { data: { usage: result.usage } } : {}),
            });
            stopSession();
            return;
          }
          failSession(`Gemini ended with stopReason ${stopReason}`);
          break;
        }
      }
    },
  });

  // Start the ACP handshake.
  send({
    id: requestId,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "scarlet", version: "0.1.4" } },
  });

  const outcome = await handle.done;

  const remaining: RunnerEvent[] = [];
  flushStreams(st, remaining);
  emit(remaining);

  const usage = usageWithModel(st.usage, opts.model);
  if (resumeFailed) {
    return { ok: false, summary: "", error: st.failed, resumeFailed: true, exitCode: outcome.code, usage };
  }
  const early = earlyResult(st, outcome, { sessionId: st.sessionId, usage });
  if (early) return early;
  const ok = !st.failed && st.completed;
  return {
    ok,
    summary: tailSummary(st.texts),
    error: ok
      ? undefined
      : st.failed ?? `agy exited with code ${outcome.code}${outcome.stderr ? `: ${outcome.stderr.trim().slice(-800)}` : ""}`,
    exitCode: outcome.code,
    sessionId: st.sessionId,
    usage,
  };
}
