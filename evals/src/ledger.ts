/**
 * The dialogue ledger: every mistake the editor has reported in a dialogue cut, each with a check of whether the
 * current code still makes it, and a scoreboard row for every recorded check run. See evals/DIALOGUE.md.
 *
 * It lives with the eval data, never in the repository (it holds the editor's words and times):
 *   $SCARLET_EVAL_DATA/dialogue/ledger.json       the entries
 *   $SCARLET_EVAL_DATA/dialogue/history.md        what each report was, its cause, what was tried, what shipped
 *   $SCARLET_EVAL_DATA/dialogue/scoreboard.jsonl  one row per recorded check run
 *
 * The free checks spend no model tokens: a replay sends the model's own requests from the reported run through the
 * current planning code (replay.ts), and a command check runs a test or script. A trials check needs model passes,
 * which cost tokens, so `check` never starts one: it says what was last measured.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, isMain, list, main } from "./args.ts";
import { loadCase } from "./case.ts";
import { overlap, type Range } from "./intervals.ts";
import type { MediaEvidence } from "./metrics.ts";
import { scoreMoments } from "./moments.ts";
import { checkedPath, dataDir, readJson, REPO_ROOT } from "./paths.ts";
import { replayParts, type PartsResult, type ReplayResult } from "./replay.ts";

const USAGE = `Usage:
  tsx evals/src/ledger.ts check [--id a,b] [--record] [--label text]   run every free check (no model tokens)
  tsx evals/src/ledger.ts list                                         the entries and how each is checked
  tsx evals/src/ledger.ts board [--last 10]                            the scoreboard, oldest first

check exits 1 when an entry marked fixed fails or can't be checked. --record appends the run to the scoreboard.`;

/** Where the mistake came from, which says where its fix belongs (docs/skills-and-tools.md). */
export type Cause = "transcript" | "placement" | "model" | "eval" | "flow";

/** What the current code must do at the reported spot, given the model's requests from the reported run. */
export type Expect =
  /** What the edit plays in a stretch of the recording, as words. `asked` accepts a cut staged for the editor there that plays them once approved. */
  | { plays: string | string[]; mediaId: string; start: number; end: number; accept?: Array<"right" | "asked"> }
  /**
   * An edge a cut places near `near` (within `within` s, default 0.3), applied or staged, lands between `min` and `max`,
   * source seconds. The model's first request there is checked, since its later ones answer what the code did with the
   * first; `every` checks each request that places an edge there.
   */
  | { edge: { mediaId: string; near: number; min: number; max: number; within?: number; every?: boolean } }
  /** Nothing in this stretch is taken out without the editor: the cuts the run asked for there are held, staged or refused. */
  | { notApplied: { mediaId: string; start: number; end: number } };

export type Check =
  | { kind: "replay"; case: string; expect: Expect[] }
  /** Exit status 0 passes. Runs from the repository root: a unit test with a synthetic fixture, or a script. */
  | { kind: "command"; run: string; timeoutSeconds?: number }
  /** Only model passes can show it. `last` says what the last trials found, with their run ids. */
  | { kind: "trials"; case?: string; moment?: string; last?: string }
  | { kind: "none"; why: string };

export interface Entry {
  id: string;
  /** YYYY-MM-DD. */
  reported: string;
  /** The editor's report, in their own words where they were kept. */
  said: string;
  project?: string;
  task?: string;
  /** Where on the timeline the editor saw it, as they said it. */
  at?: string;
  cause: Cause;
  /** The PRs or commits that fixed it. */
  fix?: string;
  status: "fixed" | "open";
  check: Check;
  /** What the check can't show, or anything the next thread must know before trusting its verdict. */
  note?: string;
}

export interface LedgerFile { schema: 1; entries: Entry[] }

export type Verdict = "pass" | "fail" | "error" | "model" | "unchecked";
export interface EntryResult { id: string; verdict: Verdict; detail: string; ms: number }

/** A whole replayed pass, summed over its parts: how far a change moved the pass beyond the reported spots. */
export interface PassTotals { removals: number; applied: number; review: number; notCut: number; moved: number; appliedEdges: number; appliedOnSpeech: number }

export interface BoardRow {
  schema: 1;
  at: string;
  commit?: string;
  branch?: string;
  /** Uncommitted files under the code a cut depends on. */
  dirty: string[];
  label?: string;
  results: Record<string, { verdict: Verdict; detail: string }>;
  passes: Record<string, PassTotals>;
}

export const ledgerDir = () => checkedPath(dataDir(), join(dataDir(), "dialogue"));
export const ledgerPath = () => join(ledgerDir(), "ledger.json");
export const boardPath = () => join(ledgerDir(), "scoreboard.jsonl");

export function loadLedger(path = ledgerPath()): LedgerFile {
  if (!existsSync(path)) throw new Error(`No ledger at ${path}. See evals/DIALOGUE.md.`);
  const file = readJson<LedgerFile>(path);
  if (file.schema !== 1 || !Array.isArray(file.entries)) throw new Error("ledger.json is not a schema 1 ledger.");
  const ids = new Set<string>();
  for (const e of file.entries) {
    if (!e.id || !e.reported || !e.said || !e.cause || !e.status || !e.check?.kind) throw new Error(`Entry ${e.id ?? "(no id)"} needs id, reported, said, cause, status and check.`);
    if (ids.has(e.id)) throw new Error(`Two entries are named ${e.id}.`);
    ids.add(e.id);
    if (e.check.kind === "replay" && (!e.check.case || !e.check.expect?.length)) throw new Error(`Entry ${e.id}: a replay check needs a case and what to expect.`);
  }
  return file;
}

export function loadBoard(path = boardPath()): BoardRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as BoardRow);
}

const touches = (r: ReplayResult, spot: { mediaId: string } & Range) =>
  r.cuts.some(c => c.mediaId === spot.mediaId && [c.replay, c.original].some(x => x && x.tier !== "kept" && overlap(x, spot) > 0)) ||
  (r.left.removed[spot.mediaId] ?? []).some(x => overlap(x, spot) > 0) ||
  r.left.staged.some(s => s.mediaId === spot.mediaId && overlap(s, spot) > 0);

/**
 * The part of a pass that decides what the edit plays at a spot: the last one whose requests reach it and that the
 * current code saves. A part it sends back to the model ("needsRevision") is left to the model's next try.
 */
export function partAt(parts: readonly ReplayResult[], spot: { mediaId: string } & Range): ReplayResult | undefined {
  return [...parts].reverse().find(p => p.outcome === "ready" && touches(p, spot));
}

const fmt = (t: number) => t.toFixed(2);

/**
 * Whether the current code does what the entry expects at the spot, over the parts of the replayed pass. Each part
 * is one of the model's requests placed by today's code, so an edge or an applied cut is checked in every part that
 * makes one there, and what the edit plays in the part that decides it.
 */
export function judge(expect: Expect, parts: readonly ReplayResult[], evidence: ReadonlyMap<string, MediaEvidence>): { ok: boolean; detail: string } {
  if ("plays" in expect) {
    const part = partAt(parts, expect);
    if (!part) {
      const back = parts.some(p => p.outcome !== "ready" && touches(p, expect));
      return { ok: false, detail: back ? "every request here goes back to the model: only a model pass can show what plays" : "no request in the run reaches this spot" };
    }
    const [result] = scoreMoments([{ id: "spot", ...expect }], evidence, part.left);
    const accept = expect.accept ?? ["right"];
    // An ask passes only when approving it plays the right words: an ask about the wrong cut still needs a Revise.
    const ok = (result!.outcome === "right" && accept.includes("right")) || (result!.outcome === "asked" && accept.includes("asked") && !!result!.approved?.right);
    const said = result!.outcome === "asked" ? `asks; plays "${result!.played}", approved "${result!.approved?.played}"` : `${result!.outcome}; plays "${result!.played}"`;
    return { ok, detail: said };
  }
  if ("edge" in expect) {
    const { mediaId, near, min, max, within = 0.3, every } = expect.edge;
    const placing = parts.map(p => [
      ...(p.left.removed[mediaId] ?? []).map(r => ({ r, how: "applied" })),
      ...p.left.staged.filter(s => s.mediaId === mediaId).map(r => ({ r, how: "staged" })),
    ].flatMap(({ r, how }) => [r.start, r.end].filter(t => Math.abs(t - near) <= within).map(t => ({ t, how })))).filter(l => l.length);
    const placed = every ? placing.flat() : placing[0] ?? [];
    if (!placed.length) return { ok: false, detail: `no edge placed within ${within} s of ${fmt(near)}` };
    const wrong = placed.filter(e => e.t < min || e.t > max);
    const list = (l: typeof placed) => [...new Set(l.map(e => `${fmt(e.t)} ${e.how}`))].join(", ");
    return wrong.length
      ? { ok: false, detail: `edge at ${list(wrong)} (wanted ${fmt(min)}–${fmt(max)})` }
      : { ok: true, detail: `edge at ${list(placed)}` };
  }
  const spot = expect.notApplied;
  const taken = parts.flatMap(p => (p.left.removed[spot.mediaId] ?? []).filter(r => overlap(r, spot) > 0.02));
  return taken.length
    ? { ok: false, detail: `applied without the editor: ${[...new Set(taken.map(r => `${fmt(r.start)}–${fmt(r.end)}`))].join(", ")}` }
    : { ok: true, detail: "nothing applied there" };
}

export function passTotals(r: PartsResult): PassTotals {
  const t: PassTotals = { removals: 0, applied: 0, review: 0, notCut: 0, moved: 0, appliedEdges: 0, appliedOnSpeech: 0 };
  for (const p of r.parts) {
    t.removals += p.cuts.length;
    for (const c of p.cuts) {
      if (c.replay.tier === "applied") t.applied++;
      else if (c.replay.tier === "review") t.review++;
      else t.notCut++;
    }
    t.moved += p.gate.moved;
    const e = p.edges.replay.appliedOnFrames ?? p.edges.replay.applied;
    t.appliedEdges += e.total;
    t.appliedOnSpeech += e.speech;
  }
  return t;
}

function gitState() {
  const git = (...args: string[]) => execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();
  try {
    return {
      commit: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"),
      dirty: git("status", "--porcelain", "--", "packages", "apps/server/src", "skills").split("\n").filter(Boolean).map(l => l.slice(3)),
    };
  } catch {
    return { dirty: [] as string[] };
  }
}

/** The latest recorded row this checkout builds on: its commit is an ancestor of HEAD. */
export function baseRow(rows: readonly BoardRow[], isAncestor = (commit: string) => {
  try { execFileSync("git", ["-C", REPO_ROOT, "merge-base", "--is-ancestor", commit, "HEAD"], { stdio: "ignore" }); return true; } catch { return false; }
}): BoardRow | undefined {
  return [...rows].reverse().find(r => r.commit && !r.dirty.length && isAncestor(r.commit));
}

export async function runChecks(entries: readonly Entry[], log: (line: string) => void = () => {}): Promise<{ results: EntryResult[]; passes: Record<string, PassTotals> }> {
  const replays = new Map<string, Promise<{ parts: PartsResult; evidence: ReadonlyMap<string, MediaEvidence> }>>();
  const replayOf = (id: string) => {
    if (!replays.has(id)) replays.set(id, (async () => { const loaded = loadCase(id); return { parts: await replayParts(loaded), evidence: loaded.evidence }; })());
    return replays.get(id)!;
  };
  const results: EntryResult[] = [];
  for (const e of entries) {
    const started = Date.now();
    let verdict: Verdict, detail: string;
    try {
      const c = e.check;
      if (c.kind === "replay") {
        const { parts, evidence } = await replayOf(c.case);
        const judged = c.expect.map(x => judge(x, parts.parts, evidence));
        verdict = judged.every(j => j.ok) ? "pass" : "fail";
        detail = judged.map(j => j.detail).join("; ");
      } else if (c.kind === "command") {
        const run = spawnSync("sh", ["-c", c.run], { cwd: REPO_ROOT, encoding: "utf8", timeout: (c.timeoutSeconds ?? 600) * 1000, maxBuffer: 64 << 20 });
        verdict = run.status === 0 ? "pass" : run.error || run.status === null ? "error" : "fail";
        const tail = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
        detail = run.status === 0 ? "passed" : run.error ? run.error.message : tail.slice(0, 300);
      } else if (c.kind === "trials") {
        verdict = "model";
        detail = c.last ?? "never measured";
      } else {
        verdict = "unchecked";
        detail = c.why;
      }
    } catch (err) {
      verdict = "error";
      detail = (err as Error).message.slice(0, 300);
    }
    results.push({ id: e.id, verdict, detail, ms: Date.now() - started });
    log(`${verdict.padEnd(9)} ${e.id}: ${detail}`);
  }
  const passes: Record<string, PassTotals> = {};
  for (const [id, replay] of replays) {
    try { passes[id] = passTotals((await replay).parts); } catch { /* Its entries already say why. */ }
  }
  return { results, passes };
}

/** What changed since the row this checkout builds on: entries that broke or got fixed, and how far each whole pass moved. */
export function againstBase(entries: readonly Entry[], results: readonly EntryResult[], passes: Record<string, PassTotals>, base: BoardRow | undefined): string[] {
  const lines: string[] = [];
  const failing = results.filter(r => (r.verdict === "fail" || r.verdict === "error") && entries.find(e => e.id === r.id)?.status === "fixed");
  if (failing.length) lines.push(`Fixed before and failing now: ${failing.map(r => r.id).join(", ")}.`);
  if (!base) return [...lines, "No recorded run this checkout builds on: record one on main to compare against."];
  const was = (id: string) => base.results[id]?.verdict;
  const broke = results.filter(r => was(r.id) === "pass" && r.verdict !== "pass").map(r => r.id);
  const mended = results.filter(r => was(r.id) && was(r.id) !== "pass" && r.verdict === "pass").map(r => r.id);
  const added = results.filter(r => !was(r.id)).map(r => r.id);
  lines.push(`Against ${base.commit?.slice(0, 8)} (${base.at.slice(0, 16)}${base.label ? `, ${base.label}` : ""}):`,
    `- broke: ${broke.join(", ") || "none"}`, `- now pass: ${mended.join(", ") || "none"}`, ...(added.length ? [`- new entries: ${added.join(", ")}`] : []));
  for (const [id, now] of Object.entries(passes)) {
    const then = base.passes[id];
    if (!then) continue;
    const moved = (Object.keys(now) as Array<keyof PassTotals>).filter(k => now[k] !== then[k]).map(k => `${k} ${then[k]}→${now[k]}`);
    lines.push(`- whole pass ${id}: ${moved.join(", ") || "unchanged"}`);
  }
  return lines;
}

function table(entries: readonly Entry[], results: readonly EntryResult[]): string {
  const rows = results.map(r => {
    const e = entries.find(x => x.id === r.id)!;
    const detail = r.detail + (e.note && r.verdict !== "pass" ? ` (note: ${e.note})` : "");
    return `| ${r.verdict} | ${r.id} | ${e.cause} | ${e.status} | ${e.check.kind} | ${detail.replace(/\|/g, "/")} |`;
  });
  const n = (v: Verdict) => results.filter(r => r.verdict === v).length;
  return ["| Verdict | Entry | Cause | Status | Check | Detail |", "|---|---|---|---|---|---|", ...rows, "",
    `${n("pass")} pass, ${n("fail")} fail, ${n("error")} error, ${n("model")} need model passes, ${n("unchecked")} not checkable yet.`].join("\n");
}

async function ledgerCli(argv = process.argv.slice(2)) {
  const { values, positionals } = cli({ id: { type: "string" }, record: { type: "boolean" }, label: { type: "string" }, last: { type: "string" } }, USAGE, argv);
  const command = positionals[0];
  if (command === "board") {
    const rows = loadBoard().slice(-Number(values.last ?? 10));
    for (const r of rows) {
      const n = (v: Verdict) => Object.values(r.results).filter(x => x.verdict === v).length;
      const passes = Object.entries(r.passes).map(([id, t]) => `${id} ${t.applied}/${t.removals} applied, ${t.appliedOnSpeech} on speech`).join("; ");
      console.log(`${r.at.slice(0, 16)} ${r.commit?.slice(0, 8) ?? "?"} ${r.branch ?? ""}${r.dirty.length ? " +dirty" : ""}${r.label ? ` (${r.label})` : ""}: ` +
        `${n("pass")} pass, ${n("fail")} fail, ${n("error")} error · ${passes}`);
    }
    if (!rows.length) console.log("No recorded runs yet.");
    return;
  }
  const ledger = loadLedger();
  if (command === "list") {
    for (const e of ledger.entries) {
      console.log(`${e.status.padEnd(5)} ${e.cause.padEnd(10)} ${e.check.kind.padEnd(7)} ${e.id} · ${e.reported} · "${e.said.slice(0, 90)}"${e.fix ? ` · ${e.fix}` : ""}`);
      if (e.note) console.log(`      note: ${e.note}`);
    }
    return;
  }
  if (command !== "check") throw new Error(USAGE);
  const only = list(values.id);
  const entries = only.length ? ledger.entries.filter(e => only.includes(e.id)) : ledger.entries;
  if (only.length && entries.length !== only.length) throw new Error(`Unknown entry: ${only.filter(id => !entries.some(e => e.id === id)).join(", ")}`);
  const { results, passes } = await runChecks(entries, line => console.error(line));
  console.log(table(entries, results));
  const git = gitState();
  console.log("\n" + againstBase(entries, results, passes, baseRow(loadBoard())).join("\n"));
  if (values.record) {
    if (only.length) throw new Error("Record a run of every entry, not a selection.");
    const row: BoardRow = { schema: 1, at: new Date().toISOString(), ...git, ...(values.label && { label: values.label }),
      results: Object.fromEntries(results.map(r => [r.id, { verdict: r.verdict, detail: r.detail }])), passes };
    appendFileSync(boardPath(), JSON.stringify(row) + "\n");
    console.log(`\nRecorded in ${boardPath()}${git.dirty.length ? " (with uncommitted changes: never a base for later runs)" : ""}.`);
  }
  const blocking = results.filter(r => entries.find(e => e.id === r.id)!.status === "fixed" && (r.verdict === "fail" || r.verdict === "error"));
  if (blocking.length) process.exitCode = 1;
}

if (isMain(import.meta.url)) void main(() => ledgerCli());
