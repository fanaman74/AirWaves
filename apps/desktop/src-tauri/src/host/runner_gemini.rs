//! Gemini via Antigravity CLI (`agy acp`), speaking Agent Client Protocol (JSON-RPC 2.0) over stdio.
//! Runs with `--sandbox` and an explicit `session/request_permission` handler that allows only
//! Scarlet MCP tools and rejects all built-in file/shell tools. Supports model selection,
//! thinking level (`thought_level`), session resume (`session/resume`), and token usage reporting.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::runner::{cut_short, exit_error, report_usage, EventSink, RunOptions, RunnerCommand, UsageSink};
use super::spawn::{resolve_cli, spawn_interactive, SpawnLinesOptions};
use super::types::{
    brief, brief_input, is_question_tool, plan_event, pretty_tool_name, tail_summary, McpSpec, PlanStep, RunResult,
    RunnerEvent,
};
use super::usage::{gemini_usage, AgentUsage};
use crate::util::env_get;

const STOP_GRACE: Duration = Duration::from_secs(2);
/// How many times a run carries on after agy ended Gemini's turn on a tool Scarlet refused.
const MAX_CARRY_ONS: u32 = 4;

#[derive(Debug, Default, Clone)]
pub struct GeminiState {
    pub texts: Vec<String>,
    /// Accumulated streamed assistant message (delta chunks).
    pub partial: String,
    /// Accumulated streamed reasoning/thought chunks.
    pub thought: String,
    /// Tool call names keyed by toolCallId so updates know which tool finished or failed.
    pub tool_names: HashMap<String, String>,
    pub pending_question_id: Option<String>,
    pub question: Option<String>,
    pub question_posted: bool,
    pub should_stop: bool,
    pub completed: bool,
    pub failed: Option<String>,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub usage: Option<AgentUsage>,
    pub plan: Option<String>,
}

fn non_empty_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|p| match p {
                Value::String(s) => s.clone(),
                Value::Object(o) => {
                    if let Some(t) = o.get("text").and_then(Value::as_str) {
                        t.to_string()
                    } else {
                        content_text(o.get("content"))
                    }
                }
                _ => String::new(),
            })
            .collect(),
        Some(Value::Object(o)) => {
            if let Some(t) = o.get("text").and_then(Value::as_str) {
                t.to_string()
            } else {
                content_text(o.get("content"))
            }
        }
        _ => String::new(),
    }
}

fn flush_thought(st: &mut GeminiState, events: &mut Vec<RunnerEvent>) {
    let trimmed = st.thought.trim();
    if !trimmed.is_empty() {
        events.push(RunnerEvent::with(
            "log",
            format!("(thinking) {}", brief_input(Some(&Value::String(trimmed.to_string())), 200)),
            json!({ "kind": "reasoning" }),
        ));
    }
    st.thought.clear();
}

fn flush_partial(st: &mut GeminiState, events: &mut Vec<RunnerEvent>) {
    if !st.partial.trim().is_empty() {
        st.texts.push(st.partial.clone());
        events.push(RunnerEvent::new("log", st.partial.clone()));
    }
    st.partial.clear();
}

fn flush_streams(st: &mut GeminiState, events: &mut Vec<RunnerEvent>) {
    flush_thought(st, events);
    flush_partial(st, events);
}

/// Whether an ACP `session/request_permission` request targets a Scarlet MCP tool.
pub fn is_scarlet_mcp_permission(params: &Value) -> bool {
    let Some(tc) = params.get("toolCall").and_then(Value::as_object) else {
        return false;
    };
    let meta = tc.get("_meta").and_then(Value::as_object);
    let server_candidates = [
        meta.and_then(|m| m.get("mcpServer")),
        meta.and_then(|m| m.get("server")),
        meta.and_then(|m| m.get("serverName")),
        tc.get("mcpServer"),
        tc.get("server"),
        tc.get("serverName"),
    ];
    for server in server_candidates.into_iter().flatten() {
        if server.as_str().is_some_and(|s| s.eq_ignore_ascii_case("scarlet")) {
            return true;
        }
    }
    for key in ["name", "toolName", "title"] {
        if let Some(candidate) = tc.get(key).and_then(Value::as_str) {
            let trimmed = candidate.trim().to_ascii_lowercase();
            if ["mcp__scarlet__", "mcp_scarlet_", "scarlet__", "scarlet.", "scarlet/", "scarlet:"]
                .iter()
                .any(|prefix| trimmed.starts_with(prefix))
            {
                return true;
            }
        }
    }
    false
}

/// Pick the best ACP permission outcome for allow vs reject.
pub fn permission_outcome(params: &Value, allow: bool) -> Value {
    let options = params.get("options").and_then(Value::as_array);
    let preferred = if allow {
        ["allow_once", "allow_always"]
    } else {
        ["reject_once", "reject_always"]
    };
    if let Some(options) = options {
        for kind in preferred {
            if let Some(id) = options.iter().find_map(|o| {
                (o.get("kind").and_then(Value::as_str) == Some(kind))
                    .then(|| o.get("optionId").and_then(Value::as_str))
                    .flatten()
            }) {
                return json!({ "outcome": "selected", "optionId": id });
            }
        }
    }
    json!({ "outcome": "cancelled" })
}

fn first<'a>(obj: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| obj.get(*k)).filter(|v| !v.is_null())
}

fn extract_tool_name(update: &Value) -> String {
    non_empty_str(update.get("name"))
        .or_else(|| non_empty_str(update.get("toolName")))
        .or_else(|| non_empty_str(update.get("title")))
        .unwrap_or("tool")
        .to_string()
}

fn is_failed_output(raw_output: Option<&Value>, content: Option<&Value>) -> bool {
    if let Some(out) = raw_output.and_then(Value::as_object) {
        if out.get("isError").and_then(Value::as_bool) == Some(true)
            || out.get("is_error").and_then(Value::as_bool) == Some(true)
            || out.get("error").is_some_and(|v| !v.is_null() && v != &Value::Bool(false) && v != &Value::String(String::new()))
        {
            return true;
        }
    }
    if let Some(c) = content.and_then(Value::as_object) {
        if c.get("isError").and_then(Value::as_bool) == Some(true)
            || c.get("is_error").and_then(Value::as_bool) == Some(true)
        {
            return true;
        }
    }
    false
}

/// Parse one ACP `session/update` payload (`params.update`).
pub fn parse_gemini_acp_update(update: &Value, st: &mut GeminiState) -> Vec<RunnerEvent> {
    if !update.is_object() {
        return Vec::new();
    }
    let mut events = Vec::new();
    let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");

    match kind {
        "agent_message_chunk" => {
            flush_thought(st, &mut events);
            let text = content_text(update.get("content").or_else(|| update.get("text")));
            if !text.is_empty() {
                st.partial.push_str(&text);
            }
        }
        "agent_thought_chunk" => {
            let text = content_text(update.get("content").or_else(|| update.get("text")));
            if !text.is_empty() {
                st.thought.push_str(&text);
            }
        }
        "tool_call" => {
            flush_streams(st, &mut events);
            let raw_name = extract_tool_name(update);
            let name = pretty_tool_name(&raw_name);
            let id = non_empty_str(update.get("toolCallId"))
                .or_else(|| non_empty_str(update.get("id")))
                .map(String::from);
            if let Some(ref call_id) = id {
                st.tool_names.insert(call_id.clone(), raw_name.clone());
            }
            let input = first(update, &["rawInput", "parameters", "input", "arguments"]);
            let status = update.get("status").and_then(Value::as_str);
            if is_question_tool(Some(&raw_name)) {
                let q_text = input.and_then(|i| non_empty_str(i.get("text"))).map(String::from);
                if st.question.is_none() && (q_text.is_some() || input.is_some()) {
                    let text = q_text.unwrap_or_else(|| brief(input));
                    st.question = Some(text.clone());
                    st.pending_question_id = id.clone();
                    let mut data = serde_json::Map::new();
                    data.insert("tool".into(), Value::String(name));
                    if let Some(ref call_id) = id {
                        data.insert("toolId".into(), Value::String(call_id.clone()));
                    }
                    events.push(RunnerEvent::with("question", text, Value::Object(data)));
                } else if st.pending_question_id.is_none() {
                    st.pending_question_id = id;
                }
                if matches!(status, Some("completed" | "failed" | "error")) {
                    let failed = status != Some("completed")
                        || is_failed_output(update.get("rawOutput"), update.get("content"));
                    st.question_posted = !failed;
                    st.should_stop = true;
                }
            } else {
                let text = format!("{name} {}", brief(input)).trim().to_string();
                let mut data = serde_json::Map::new();
                data.insert("tool".into(), Value::String(name));
                if let Some(i) = input {
                    data.insert("input".into(), i.clone());
                }
                if let Some(ref call_id) = id {
                    data.insert("toolId".into(), Value::String(call_id.clone()));
                }
                events.push(RunnerEvent::with("tool", text, Value::Object(data)));
            }
        }
        "tool_call_update" => {
            let id = non_empty_str(update.get("toolCallId"))
                .or_else(|| non_empty_str(update.get("id")))
                .map(String::from);
            let raw_name = id
                .as_ref()
                .and_then(|cid| st.tool_names.get(cid).cloned())
                .or_else(|| {
                    non_empty_str(update.get("name"))
                        .or_else(|| non_empty_str(update.get("toolName")))
                        .or_else(|| non_empty_str(update.get("title")))
                        .map(String::from)
                });
            let name = raw_name.as_deref().map(pretty_tool_name).unwrap_or_else(|| "tool".into());
            let status = update.get("status").and_then(Value::as_str);
            let input = first(update, &["rawInput", "parameters", "input", "arguments"]);
            let is_question = (id.is_some() && st.pending_question_id == id) || is_question_tool(raw_name.as_deref());
            if is_question {
                if st.question.is_none() && input.is_some() {
                    let text = input
                        .and_then(|i| non_empty_str(i.get("text")))
                        .map(String::from)
                        .unwrap_or_else(|| brief(input));
                    st.question = Some(text.clone());
                    if id.is_some() {
                        st.pending_question_id = id.clone();
                    }
                    let mut data = serde_json::Map::new();
                    data.insert("tool".into(), Value::String(name.clone()));
                    if let Some(ref call_id) = id {
                        data.insert("toolId".into(), Value::String(call_id.clone()));
                    }
                    events.push(RunnerEvent::with("question", text, Value::Object(data)));
                }
                if matches!(status, Some("completed" | "failed" | "error")) {
                    if st.question.is_none() {
                        let fallback = {
                            let b = brief(input);
                            if b.is_empty() { "Question posted".to_string() } else { b }
                        };
                        st.question = Some(fallback.clone());
                        let mut data = serde_json::Map::new();
                        data.insert("tool".into(), Value::String(name));
                        if let Some(ref call_id) = id {
                            data.insert("toolId".into(), Value::String(call_id.clone()));
                        }
                        events.push(RunnerEvent::with("question", fallback, Value::Object(data)));
                    }
                    let failed = status != Some("completed")
                        || is_failed_output(update.get("rawOutput"), update.get("content"));
                    st.question_posted = !failed;
                    st.should_stop = true;
                }
            } else if matches!(status, Some("failed" | "error")) {
                let detail = first(update, &["rawOutput", "content", "error"]);
                let text = format!("{name} failed: {}", brief_input(detail, 400)).trim().to_string();
                if let Some(call_id) = id {
                    events.push(RunnerEvent::with("error", text, json!({ "toolId": call_id })));
                } else {
                    events.push(RunnerEvent::new("error", text));
                }
            }
        }
        "plan" => {
            if let Some(entries) = update.get("entries").and_then(Value::as_array) {
                let mut steps = Vec::new();
                for entry in entries {
                    let Some(text) = entry.get("content").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
                        continue;
                    };
                    let state = match entry.get("status").and_then(Value::as_str) {
                        Some("completed") => "done",
                        Some("in_progress") => "in_progress",
                        _ => "pending",
                    };
                    steps.push(PlanStep { text: text.to_string(), state });
                }
                let key = serde_json::to_string(
                    &steps.iter().map(|s| (&s.text, s.state)).collect::<Vec<_>>(),
                )
                .unwrap_or_default();
                if st.plan.as_deref() != Some(key.as_str()) {
                    st.plan = Some(key);
                    events.push(plan_event(&steps));
                }
            }
        }
        "usage_update" => {
            let source = update.get("usage").unwrap_or(update);
            if let Some(usage) = gemini_usage(Some(source), st.model.as_deref()) {
                st.usage = Some(usage);
            }
        }
        _ => {}
    }

    events
}

/// Parse one JSON-RPC notification line from `agy acp` (or non-JSON output as a log line).
pub fn parse_gemini_line(line: &str, st: &mut GeminiState) -> Vec<RunnerEvent> {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v @ Value::Object(_)) => v,
        _ => return vec![RunnerEvent::new("log", line)],
    };
    if msg.get("method").and_then(Value::as_str) == Some("session/update") {
        if let Some(update) = msg.pointer("/params/update") {
            return parse_gemini_acp_update(update, st);
        }
    }
    Vec::new()
}

/// Convert Scarlet's `McpSpec` to an ACP stdio MCP server entry.
pub fn acp_mcp_server(mcp: &McpSpec) -> Value {
    let env: Vec<Value> = mcp
        .env
        .iter()
        .map(|(name, value)| json!({ "name": name, "value": value }))
        .collect();
    json!({
        "name": "scarlet",
        "command": mcp.command,
        "args": mcp.args,
        "env": env,
    })
}

/// agy reads Scarlet's prompt from the session's own system prompt, not a `GEMINI.md`: it cuts a rule file off at
/// 24,000 bytes, and a pass's prompt with the editor's skill runs past that (28.5 KB on 2026-11-19, losing the skill's
/// pace, demo and punch-in sections).
pub fn build_gemini_command(bin: &str) -> RunnerCommand {
    RunnerCommand {
        file: bin.to_string(),
        args: vec!["acp".into(), "--sandbox".into(), "--disable-telemetry".into()],
        stdin: None,
        files: BTreeMap::new(),
    }
}

/// `session/new` and `session/resume` meta that appends Scarlet's prompt to agy's system prompt, which agy's
/// `initialize` offers as `_meta.antigravity.systemPrompt.append`.
pub fn system_prompt_meta(system_prompt: &str) -> Value {
    json!({ "antigravity": { "systemPrompt": { "append": system_prompt } } })
}

/// The name of the tool a permission request is for.
fn permission_tool(params: &Value) -> String {
    params
        .get("toolCall")
        .map(extract_tool_name)
        .unwrap_or_else(|| "tool".to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Initialize,
    Authenticate,
    SessionOpen,
    SetModel,
    SetEffort,
    Prompt,
    Done,
}

impl Step {
    fn label(self) -> &'static str {
        match self {
            Step::Initialize => "initialize",
            Step::Authenticate => "authenticate",
            Step::SessionOpen => "session_open",
            Step::SetModel => "set_model",
            Step::SetEffort => "set_effort",
            Step::Prompt => "prompt",
            Step::Done => "done",
        }
    }
}

fn parse_config_options(result: &Value) -> Vec<Value> {
    result
        .get("configOptions")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter(|v| v.is_object()).cloned().collect())
        .unwrap_or_default()
}

fn config_option_id(opt: &Value) -> Option<&str> {
    non_empty_str(opt.get("id")).or_else(|| non_empty_str(opt.get("configId")))
}

fn find_config_option<'a>(configs: &'a [Value], category: &str, ids: &[&str]) -> Option<&'a Value> {
    configs.iter().find(|c| {
        c.get("category").and_then(Value::as_str) == Some(category)
            || config_option_id(c).is_some_and(|id| ids.contains(&id))
    })
}

struct AcpSession {
    input: Option<mpsc::UnboundedSender<String>>,
    request_id: u64,
    step: Step,
    tried_api_key_auth: bool,
    resume_failed: bool,
    cancel_sent: bool,
    has_api_key: bool,
    cwd: String,
    mcp_server: Value,
    model_override: Option<String>,
    effort_override: Option<String>,
    resume_session: Option<String>,
    instruction: String,
    system_prompt: String,
    /// Tools Scarlet refused during the turn under way. agy ends Gemini's turn on a refusal.
    refused: Vec<String>,
    carry_ons: u32,
    config_options: Vec<Value>,
    has_legacy_models: bool,
    st: GeminiState,
    sent_usage: Option<AgentUsage>,
    on_event: EventSink,
    on_usage: Option<UsageSink>,
}

impl AcpSession {
    fn send(&self, mut message: Value) -> bool {
        if let Some(obj) = message.as_object_mut() {
            obj.insert("jsonrpc".into(), json!("2.0"));
        }
        let Some(ref tx) = self.input else {
            return false;
        };
        tx.send(format!("{message}\n")).is_ok()
    }

    fn send_request(&mut self, method: &str, params: Value) -> bool {
        self.request_id += 1;
        let id = self.request_id;
        self.send(json!({ "id": id, "method": method, "params": params }))
    }

    fn cancel_turn(&mut self) -> bool {
        if self.cancel_sent || self.step == Step::Done {
            return false;
        }
        let Some(ref session_id) = self.st.session_id else {
            return false;
        };
        self.cancel_sent = self.send(json!({
            "method": "session/cancel",
            "params": { "sessionId": session_id }
        }));
        self.cancel_sent
    }

    fn stop_session(&mut self) {
        self.step = Step::Done;
        self.input.take();
    }

    fn fail_session(&mut self, message: impl Into<String>) {
        let msg = message.into();
        self.st.failed = Some(msg.clone());
        (self.on_event)(RunnerEvent::new("error", msg));
        self.stop_session();
    }

    fn emit_usage(&mut self) {
        let now = self
            .st
            .usage
            .clone()
            .map(|u| u.or_model(self.model_override.as_deref()));
        report_usage(&self.on_usage, &mut self.sent_usage, now);
    }

    fn send_open_session(&mut self) {
        self.step = Step::SessionOpen;
        let mcp_servers = vec![self.mcp_server.clone()];
        let meta = system_prompt_meta(&self.system_prompt);
        if let Some(ref resume_id) = self.resume_session {
            self.send_request(
                "session/resume",
                json!({ "sessionId": resume_id, "cwd": self.cwd, "mcpServers": mcp_servers, "_meta": meta }),
            );
        } else {
            self.send_request(
                "session/new",
                json!({ "cwd": self.cwd, "mcpServers": mcp_servers, "_meta": meta }),
            );
        }
    }

    fn send_prompt(&mut self) {
        let text = self.instruction.clone();
        self.send_turn(text);
    }

    fn send_turn(&mut self, text: String) {
        let Some(session_id) = self.st.session_id.clone() else {
            self.fail_session("Gemini session returned no sessionId");
            return;
        };
        self.step = Step::Prompt;
        self.refused.clear();
        self.send_request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": text }],
            }),
        );
    }

    /// agy ends Gemini's turn as soon as Scarlet refuses one of its tools, before the model hears why, and reports the
    /// turn ended as if it were finished. Tell the model what was refused and let it carry on.
    fn carry_on_after_refusal(&mut self) -> bool {
        if self.refused.is_empty() {
            return false;
        }
        let mut names: Vec<String> = Vec::new();
        for name in self.refused.drain(..) {
            if !names.contains(&name) {
                names.push(name);
            }
        }
        let names = names.join(", ");
        if self.carry_ons >= MAX_CARRY_ONS {
            self.fail_session(format!(
                "Gemini stopped after Scarlet refused {names}, a tool that doesn't run in Scarlet, {} times.",
                self.carry_ons + 1
            ));
            return true;
        }
        self.carry_ons += 1;
        (self.on_event)(RunnerEvent::with(
            "log",
            format!("Scarlet refused {names}: only Scarlet's tools run here. Gemini carries on."),
            json!({ "kind": "tool_refused", "harnessTool": names }),
        ));
        self.send_turn(format!(
            "Scarlet refused {names}: only Scarlet's own tools (the scarlet MCP server) run here, with no shell or file tools. Carry on with the request using Scarlet's tools."
        ));
        true
    }

    fn maybe_set_effort_then_prompt(&mut self) {
        if let Some(effort) = self.effort_override.clone() {
            if let Some(config_id) = find_config_option(
                &self.config_options,
                "thought_level",
                &["thought_level", "reasoning_effort", "thinking_level"],
            )
            .and_then(config_option_id)
            .map(String::from)
            {
                if let Some(session_id) = self.st.session_id.clone() {
                    self.step = Step::SetEffort;
                    self.send_request(
                        "session/set_config_option",
                        json!({ "sessionId": session_id, "configId": config_id, "value": effort }),
                    );
                    return;
                }
            }
        }
        self.send_prompt();
    }

    /// Handle one stdout line. Returns `true` when the runner should stop the child (after grace).
    fn on_line(&mut self, line: &str) -> bool {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v @ Value::Object(_)) => v,
            _ => {
                (self.on_event)(RunnerEvent::new("log", line));
                return false;
            }
        };

        // Incoming agent -> client request or notification
        if let Some(method) = msg.get("method").and_then(Value::as_str) {
            if let Some(id) = msg.get("id") {
                if method == "session/request_permission" {
                    let params = msg.get("params").unwrap_or(&Value::Null);
                    let allow = is_scarlet_mcp_permission(params);
                    if !allow {
                        self.refused.push(permission_tool(params));
                    }
                    self.send(json!({
                        "id": id,
                        "result": { "outcome": permission_outcome(params, allow) }
                    }));
                } else {
                    self.send(json!({
                        "id": id,
                        "error": { "code": -32601, "message": "Unsupported by Scarlet" }
                    }));
                }
                return false;
            }
            if method == "session/update" {
                if let Some(update) = msg.pointer("/params/update") {
                    for ev in parse_gemini_acp_update(update, &mut self.st) {
                        (self.on_event)(ev);
                    }
                    self.emit_usage();
                    if self.st.should_stop {
                        self.st.should_stop = false;
                        self.cancel_turn();
                        return true;
                    }
                }
            }
            return false;
        }

        // Response to our pending request
        if msg.get("id").and_then(Value::as_u64) != Some(self.request_id) || self.step == Step::Done {
            return false;
        }

        if let Some(err) = msg.get("error").filter(|v| v.is_object()) {
            let detail = non_empty_str(err.get("message"))
                .map(String::from)
                .unwrap_or_else(|| brief_input(Some(err), 400));
            let detail = if detail.is_empty() { "unknown error".to_string() } else { detail };
            let code = err.get("code").and_then(Value::as_i64);
            if self.step == Step::SessionOpen
                && !self.tried_api_key_auth
                && self.has_api_key
                && (code == Some(-32000) || detail.to_ascii_lowercase().contains("auth"))
            {
                self.tried_api_key_auth = true;
                self.step = Step::Authenticate;
                self.send_request("authenticate", json!({ "methodId": "gemini-api-key" }));
                return false;
            }
            if self.step == Step::SessionOpen && self.resume_session.is_some() {
                self.resume_failed = true;
                self.st.failed = Some(format!("Gemini could not resume session: {detail}"));
                self.stop_session();
                return true;
            }
            self.fail_session(format!("Gemini {} failed: {detail}", self.step.label()));
            return true;
        }

        let result = msg.get("result").unwrap_or(&Value::Null);
        match self.step {
            Step::Initialize | Step::Authenticate => {
                self.send_open_session();
            }
            Step::SessionOpen => {
                let session_id = non_empty_str(result.get("sessionId"))
                    .map(String::from)
                    .or_else(|| self.resume_session.clone());
                let Some(session_id) = session_id else {
                    self.fail_session("Gemini session returned no sessionId");
                    return true;
                };
                self.st.session_id = Some(session_id.clone());
                self.config_options = parse_config_options(result);
                let legacy_models = result.get("models").filter(|v| v.is_object());
                self.has_legacy_models = legacy_models.is_some();
                let model_opt = find_config_option(&self.config_options, "model", &["model"]);
                self.st.model = self
                    .model_override
                    .clone()
                    .or_else(|| model_opt.and_then(|o| non_empty_str(o.get("currentValue"))).map(String::from))
                    .or_else(|| legacy_models.and_then(|m| non_empty_str(m.get("currentModelId"))).map(String::from));

                let mut init_data = serde_json::Map::new();
                init_data.insert("kind".into(), json!("init"));
                if let Some(ref m) = self.st.model {
                    init_data.insert("model".into(), json!(m));
                }
                init_data.insert("sessionId".into(), json!(session_id));
                let init_text = format!(
                    "Gemini session started{}",
                    self.st.model.as_deref().map(|m| format!(" ({m})")).unwrap_or_default()
                );
                (self.on_event)(RunnerEvent::with("log", init_text, Value::Object(init_data)));

                if let Some(model) = self.model_override.clone() {
                    if let Some(config_id) = model_opt.and_then(config_option_id).map(String::from) {
                        self.step = Step::SetModel;
                        self.send_request(
                            "session/set_config_option",
                            json!({ "sessionId": session_id, "configId": config_id, "value": model }),
                        );
                        return false;
                    }
                    if self.has_legacy_models {
                        self.step = Step::SetModel;
                        self.send_request(
                            "session/set_model",
                            json!({ "sessionId": session_id, "modelId": model }),
                        );
                        return false;
                    }
                }
                self.maybe_set_effort_then_prompt();
            }
            Step::SetModel => {
                if let Some(ref m) = self.model_override {
                    self.st.model = Some(m.clone());
                }
                let refreshed = parse_config_options(result);
                if !refreshed.is_empty() {
                    self.config_options = refreshed;
                }
                self.maybe_set_effort_then_prompt();
            }
            Step::SetEffort => {
                let refreshed = parse_config_options(result);
                if !refreshed.is_empty() {
                    self.config_options = refreshed;
                }
                self.send_prompt();
            }
            Step::Prompt => {
                let mut flush_evs = Vec::new();
                flush_streams(&mut self.st, &mut flush_evs);
                for ev in flush_evs {
                    (self.on_event)(ev);
                }
                let model = self.st.model.as_deref().or(self.model_override.as_deref());
                if let Some(turn_usage) = gemini_usage(result.get("usage"), model) {
                    self.st.usage = Some(turn_usage);
                    self.emit_usage();
                }
                let stop_reason = non_empty_str(result.get("stopReason")).unwrap_or("end_turn");
                if stop_reason == "cancelled" && self.st.question.is_some() {
                    self.stop_session();
                    return true;
                }
                if stop_reason == "end_turn" && self.carry_on_after_refusal() {
                    return self.step == Step::Done;
                }
                if matches!(stop_reason, "end_turn" | "max_tokens" | "stop_sequence") {
                    self.st.completed = true;
                    let summary = {
                        let t = tail_summary(&self.st.texts);
                        if t.is_empty() { "done".to_string() } else { t }
                    };
                    if let Some(usage) = result.get("usage").filter(|v| !v.is_null()) {
                        (self.on_event)(RunnerEvent::with("result", summary, json!({ "usage": usage })));
                    } else {
                        (self.on_event)(RunnerEvent::new("result", summary));
                    }
                    self.stop_session();
                    return true;
                }
                self.fail_session(format!("Gemini ended with stopReason {stop_reason}"));
                return true;
            }
            Step::Done => {}
        }
        false
    }
}

pub async fn run_gemini(opts: RunOptions) -> RunResult {
    let bin = match opts.bin.clone().map(Ok).unwrap_or_else(|| resolve_cli("agy", &opts.env)) {
        Ok(b) => b,
        Err(e) => return RunResult::failed(e.to_string()),
    };
    let cmd = build_gemini_command(&bin);

    let (input, lines) = mpsc::unbounded_channel();
    let has_api_key = env_get(&opts.env, "GEMINI_API_KEY").is_some_and(|v| !v.is_empty())
        || env_get(&opts.env, "GOOGLE_API_KEY").is_some_and(|v| !v.is_empty());

    let session = AcpSession {
        input: Some(input),
        request_id: 1,
        step: Step::Initialize,
        tried_api_key_auth: false,
        resume_failed: false,
        cancel_sent: false,
        has_api_key,
        cwd: opts.cwd.to_string_lossy().into_owned(),
        mcp_server: acp_mcp_server(&opts.mcp),
        model_override: opts.model.clone(),
        effort_override: opts.effort.clone(),
        resume_session: opts.resume_session.clone(),
        instruction: opts.instruction.clone(),
        system_prompt: opts.system_prompt.clone(),
        refused: Vec::new(),
        carry_ons: 0,
        config_options: Vec::new(),
        has_legacy_models: false,
        st: GeminiState::default(),
        sent_usage: None,
        on_event: opts.on_event.clone(),
        on_usage: opts.on_usage.clone(),
    };

    // Start the ACP handshake immediately so the first request is queued on stdin.
    session.send(json!({
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": {},
            "clientInfo": { "name": "scarlet", "version": env!("CARGO_PKG_VERSION") }
        }
    }));

    let state = Arc::new(Mutex::new(session));
    let interrupt_state = state.clone();
    let interrupt = Box::new(move || interrupt_state.lock().unwrap().cancel_turn());
    let line_state = state.clone();
    let handler = Box::new(move |line: &str| line_state.lock().unwrap().on_line(line));

    let outcome = match spawn_interactive(
        &cmd.file,
        &cmd.args,
        SpawnLinesOptions {
            cwd: opts.cwd.clone(),
            env: opts.env.clone(),
            stdin: None,
            cancel: opts.cancel.clone(),
            timeout: opts.timeout,
            stall: opts.stall,
            task: opts.task.clone(),
        },
        lines,
        STOP_GRACE,
        interrupt,
        handler,
    )
    .await
    {
        Ok(o) => o,
        Err(e) => return RunResult::failed(e.to_string()),
    };

    let (st, resume_failed) = {
        let mut sess = state.lock().unwrap();
        let mut remaining = Vec::new();
        flush_streams(&mut sess.st, &mut remaining);
        for ev in remaining {
            (sess.on_event)(ev);
        }
        (sess.st.clone(), sess.resume_failed)
    };

    let usage = st.usage.clone().map(|u| u.or_model(opts.model.as_deref()));
    if resume_failed {
        return RunResult {
            ok: false,
            summary: String::new(),
            error: st.failed,
            resume_failed: true,
            exit_code: outcome.code,
            usage,
            ..Default::default()
        };
    }
    let base = RunResult {
        session_id: st.session_id.clone(),
        usage: usage.clone(),
        ..Default::default()
    };
    if let Some(result) = cut_short(&st.texts, st.question.as_ref(), st.question_posted, &outcome, &base) {
        return result;
    }
    let ok = st.failed.is_none() && st.completed;
    RunResult {
        ok,
        summary: tail_summary(&st.texts),
        error: if ok {
            None
        } else {
            Some(st.failed.clone().unwrap_or_else(|| exit_error("agy", &outcome)))
        },
        exit_code: outcome.code,
        session_id: st.session_id,
        usage,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(lines: &[&str], st: &mut GeminiState) -> Vec<RunnerEvent> {
        lines.iter().flat_map(|l| parse_gemini_line(l, st)).collect()
    }

    fn mcp() -> McpSpec {
        let mut env = BTreeMap::new();
        env.insert("SCARLET_SERVER".to_string(), "http://localhost:4000".to_string());
        env.insert("SCARLET_TOKEN".to_string(), "a\"b".to_string());
        McpSpec {
            command: "C:\\Program Files\\nodejs\\node.exe".into(),
            args: vec!["C:\\scarlet\\packages\\mcp\\dist\\cli.js".into()],
            env,
        }
    }

    const FIXTURE: [&str; 8] = [
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Checking transcript"}}}}"#,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Reading the "}}}}"#,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"transcript."}}}}"#,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":{"sessionUpdate":"tool_call","toolCallId":"c1","name":"mcp__scarlet__transcript_get","rawInput":{"mediaId":"m1"}}}}"#,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"completed"}}}"#,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":{"sessionUpdate":"tool_call","toolCallId":"c2","name":"scarlet:task_question","rawInput":{"text":"9:16 or 16:9?"}}}}"#,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":{"sessionUpdate":"tool_call_update","toolCallId":"c2","status":"completed","rawOutput":{"ok":true}}}}"#,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":{"sessionUpdate":"usage_update","usage":{"inputTokens":1200,"outputTokens":300,"cachedReadTokens":1000}}}}"#,
    ];

    #[test]
    fn accumulates_acp_deltas_maps_tools_and_detects_the_question() {
        let mut st = GeminiState { model: Some("gemini-3.1-pro".into()), ..Default::default() };
        let evs = feed(&FIXTURE, &mut st);
        assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "log", "tool", "question"]);
        assert!(evs[0].text.contains("Checking transcript"));
        assert_eq!(evs[1].text, "Reading the transcript.");
        assert_eq!(evs[2].text, r#"scarlet.transcript_get {"mediaId":"m1"}"#);
        assert_eq!(st.question.as_deref(), Some("9:16 or 16:9?"));
        assert!(st.question_posted);
        assert!(st.should_stop);
        let u = st.usage.unwrap();
        assert_eq!((u.input_tokens, u.output_tokens, u.cache_read_tokens), (200, 300, 1000));
        assert_eq!(u.model.as_deref(), Some("gemini-3.1-pro"));
    }

    #[test]
    fn maps_plan_updates_and_tool_failures() {
        let mut st = GeminiState::default();
        let evs = feed(
            &[
                r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"plan","entries":[{"content":"Inspect timeline","status":"completed"},{"content":"Trim intro","status":"in_progress"}]}}}"#,
                r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"c1","name":"scarlet__clip_cut"}}}"#,
                r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"failed","rawOutput":"clip missing"}}}"#,
            ],
            &mut st,
        );
        assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["plan", "tool", "error"]);
        assert!(evs[0].text.contains("[x] Inspect timeline"));
        assert!(evs[0].text.contains("[>] Trim intro"));
        assert!(evs[2].text.contains("scarlet.clip_cut failed"));
    }

    #[test]
    fn allows_only_scarlet_mcp_permissions() {
        assert!(is_scarlet_mcp_permission(&json!({ "toolCall": { "name": "mcp__scarlet__timeline_get" } })));
        assert!(is_scarlet_mcp_permission(&json!({ "toolCall": { "name": "scarlet:task_question" } })));
        assert!(is_scarlet_mcp_permission(&json!({ "toolCall": { "_meta": { "mcpServer": "scarlet" }, "name": "timeline_get" } })));
        assert!(!is_scarlet_mcp_permission(&json!({ "toolCall": { "name": "run_shell_command" } })));
        assert!(!is_scarlet_mcp_permission(&json!({ "toolCall": { "name": "write_file" } })));

        let params = json!({
            "options": [
                { "optionId": "allow_1", "kind": "allow_once" },
                { "optionId": "reject_1", "kind": "reject_once" }
            ]
        });
        assert_eq!(permission_outcome(&params, true), json!({ "outcome": "selected", "optionId": "allow_1" }));
        assert_eq!(permission_outcome(&params, false), json!({ "outcome": "selected", "optionId": "reject_1" }));
        assert_eq!(permission_outcome(&json!({}), false), json!({ "outcome": "cancelled" }));
    }

    #[test]
    fn builds_acp_command_prompt_meta_and_mcp_server_entry() {
        let mcp = mcp();
        let cmd = build_gemini_command("agy");
        assert_eq!(cmd.file, "agy");
        assert_eq!(cmd.args, ["acp", "--sandbox", "--disable-telemetry"]);
        assert_eq!(cmd.stdin, None);
        // No GEMINI.md: agy cuts a rule file off at 24,000 bytes.
        assert!(cmd.files.is_empty());
        assert_eq!(
            system_prompt_meta("SYS"),
            json!({ "antigravity": { "systemPrompt": { "append": "SYS" } } })
        );

        let server = acp_mcp_server(&mcp);
        assert_eq!(server["name"], json!("scarlet"));
        assert_eq!(server["command"], json!(mcp.command));
        assert_eq!(server["args"], json!(mcp.args));
        assert_eq!(
            server["env"],
            json!([
                { "name": "SCARLET_SERVER", "value": "http://localhost:4000" },
                { "name": "SCARLET_TOKEN", "value": "a\"b" }
            ])
        );
    }

    /// A fake `agy acp` that logs what it is sent. Its first turn asks to run a shell command, which Scarlet refuses,
    /// and ends there, as agy does. Unless `refuses_always`, the turn after says what it did.
    #[cfg(unix)]
    fn fake_agy(dir: &std::path::Path, refuses_always: bool) -> (std::path::PathBuf, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let log_path = dir.join("requests.jsonl");
        let script = dir.join("fake-agy");
        let carry_on = if refuses_always { "never-sent" } else { "Scarlet refused" };
        std::fs::write(
            &script,
            format!(
                r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{}'
  id=$(printf '%s' "$line" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  case "$line" in
    *'"method":"initialize"'*)
      echo '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"session/new"'*)
      echo '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"s-1","configOptions":[{{"id":"model","category":"model","currentValue":"gemini-3-flash"}},{{"id":"thought_level","category":"thought_level","currentValue":"medium"}}]}} }}'
      ;;
    *'"method":"session/set_config_option"'*'"configId":"model"'*)
      echo '{{"jsonrpc":"2.0","id":3,"result":{{"configOptions":[{{"id":"model","category":"model","currentValue":"gemini-3.1-pro"}},{{"id":"thought_level","category":"thought_level","currentValue":"medium"}}]}} }}'
      ;;
    *'"method":"session/set_config_option"'*'"configId":"thought_level"'*)
      echo '{{"jsonrpc":"2.0","id":4,"result":{{}}}}'
      ;;
    *'"method":"session/prompt"'*'{}'*)
      echo '{{"jsonrpc":"2.0","method":"session/update","params":{{"update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"Trimmed clip."}}}}}} }}'
      echo "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"stopReason\":\"end_turn\",\"usage\":{{\"inputTokens\":500,\"outputTokens\":100,\"cachedReadTokens\":200}}}}}}"
      ;;
    *'"method":"session/prompt"'*)
      echo '{{"jsonrpc":"2.0","id":99,"method":"session/request_permission","params":{{"toolCall":{{"name":"mcp__scarlet__timeline_get"}},"options":[{{"optionId":"yes","kind":"allow_once"}},{{"optionId":"no","kind":"reject_once"}}]}} }}'
      echo '{{"jsonrpc":"2.0","id":100,"method":"session/request_permission","params":{{"toolCall":{{"name":"run_shell_command"}},"options":[{{"optionId":"yes","kind":"allow_once"}},{{"optionId":"no","kind":"reject_once"}}]}} }}'
      echo "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"stopReason\":\"end_turn\"}}}}"
      ;;
  esac
done
"#,
                log_path.display(),
                carry_on
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        (script, log_path)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_acp_session_with_model_effort_permissions_and_usage() {
        let dir = tempfile::tempdir().unwrap();
        let (script, log_path) = fake_agy(dir.path(), false);
        let (mut opts, events) = super::super::runner::testing::options("gemini", dir.path(), Some(script.to_string_lossy().into_owned()));
        opts.model = Some("gemini-3.1-pro".into());
        opts.effort = Some("high".into());
        opts.instruction = "Trim the clip".into();
        opts.system_prompt = "You are editing a video in Scarlet".into();

        let res = run_gemini(opts).await;
        assert!(res.ok, "unexpected error: {:?}", res.error);
        assert_eq!(res.summary, "Trimmed clip.");
        assert_eq!(res.session_id.as_deref(), Some("s-1"));
        let u = res.usage.unwrap();
        assert_eq!((u.input_tokens, u.output_tokens, u.cache_read_tokens), (300, 100, 200));
        assert_eq!(u.model.as_deref(), Some("gemini-3.1-pro"));

        let sent = std::fs::read_to_string(&log_path).unwrap();
        assert!(sent.contains(r#""systemPrompt":{"append":"You are editing a video in Scarlet"}"#));
        assert!(!dir.path().join("GEMINI.md").exists());
        assert!(sent.contains(r#""configId":"model""#));
        assert!(sent.contains(r#""value":"gemini-3.1-pro""#));
        assert!(sent.contains(r#""configId":"thought_level""#));
        assert!(sent.contains(r#""value":"high""#));
        assert!(sent.contains(r#""id":99"#) && sent.contains(r#""optionId":"yes""#));
        assert!(sent.contains(r#""id":100"#) && sent.contains(r#""optionId":"no""#));
        // agy ended the first turn on the refused shell command: the run carried on, and was told why.
        assert_eq!(sent.matches(r#""method":"session/prompt""#).count(), 2);
        assert!(sent.contains("Scarlet refused run_shell_command: only Scarlet's own tools"));
        let events = events.lock().unwrap();
        assert!(events.iter().any(|e| e.kind == "log"
            && e.data.as_ref().is_some_and(|d| d["kind"] == "tool_refused" && d["harnessTool"] == "run_shell_command")));
        assert_eq!(events.iter().filter(|e| e.kind == "result").count(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stops_a_run_whose_turns_keep_ending_on_refused_tools() {
        let dir = tempfile::tempdir().unwrap();
        let (script, log_path) = fake_agy(dir.path(), true);
        let (opts, events) = super::super::runner::testing::options("gemini", dir.path(), Some(script.to_string_lossy().into_owned()));

        let res = run_gemini(opts).await;
        assert!(!res.ok);
        assert_eq!(
            res.error.as_deref(),
            Some("Gemini stopped after Scarlet refused run_shell_command, a tool that doesn't run in Scarlet, 5 times.")
        );
        let sent = std::fs::read_to_string(&log_path).unwrap();
        assert_eq!(sent.matches(r#""method":"session/prompt""#).count(), 5);
        assert!(!events.lock().unwrap().iter().any(|e| e.kind == "result"));
    }
}
