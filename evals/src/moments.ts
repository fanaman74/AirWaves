/**
 * Known moments, and how far trials agree.
 *
 * A moment is a place in a recording where a cut has gone wrong before: a restart left in, the wrong take kept, a line
 * dropped. The case says what the finished edit should play there, in words. Every trial is checked against it, so a
 * change is judged by how often each moment comes out right over several trials, not by one rerun.
 *
 * Two trials of the same configuration never make the same cut. `agreement` says how much they differ, which is the
 * spread a change has to beat before it counts.
 *
 * Moments are the editor's words and times: they live in the case folder (`moments.json`), never in the repository.
 */
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { cli, isMain, main } from "./args.ts";
import { loadCase } from "./case.ts";
import { merge, overlap, subtract, type Range } from "./intervals.ts";
import type { MediaEvidence, Word } from "./metrics.ts";
import { checkedPath, dataDir, readJson, resultsDir, writeChosenJson } from "./paths.ts";
import type { SourceRange } from "./timeline.ts";

export interface Moment {
  id: string;
  mediaId: string;
  /** The stretch of the recording to read, in its seconds. Wide enough to hold every delivery of the line. */
  start: number;
  end: number;
  /** What the finished edit plays of that stretch when the cut is right. Several readings can each be right. */
  plays: string | string[];
  note?: string;
}
export interface MomentsFile { schema: 1; moments: Moment[] }

/** What a task left of each recording: what still plays, what it took out, and the staged cuts waiting for the editor. */
export interface LeftEdit {
  kept: Record<string, Range[]>;
  removed: Record<string, Range[]>;
  staged: SourceRange[];
  /** Applied edits the pass flagged for the editor to check. */
  flagged?: SourceRange[];
}

export type MomentOutcome = "right" | "asked" | "wrong";
export interface MomentResult {
  id: string;
  outcome: MomentOutcome;
  /** The words the edit plays in the moment's stretch. */
  played: string;
  /** With a staged cut over the moment: what plays once the editor approves it, and whether that is right. */
  approved?: { played: string; right: boolean };
}

export const momentsPath = (dir: string) => checkedPath(dir, join(dir, "moments.json"));
export function loadMoments(caseDirectory: string): Moment[] {
  const path = momentsPath(caseDirectory);
  if (!existsSync(path)) return [];
  const file = readJson<MomentsFile>(path);
  if (file.schema !== 1 || !Array.isArray(file.moments)) throw new Error("moments.json is not a schema 1 moments file.");
  for (const m of file.moments) {
    if (!m.id || !m.mediaId || !(m.end > m.start) || !(typeof m.plays === "string" ? m.plays : m.plays?.length)) {
      throw new Error(`Moment ${m.id ?? "(no id)"} needs an id, a mediaId, start before end, and what it plays.`);
    }
  }
  return file.moments;
}

/** Words compared as said: case, punctuation and currency signs don't count, a decimal point inside a number does. */
export function spoken(text: string): string {
  return (text.toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}]+(?:['.][\p{L}\p{N}]+)*/gu) ?? []).join(" ");
}

const middle = (w: Word) => (w.start + w.end) / 2;
const inside = (t: number, ranges: readonly Range[]) => ranges.some(r => t >= r.start && t < r.end);

export function scoreMoments(moments: readonly Moment[], evidence: ReadonlyMap<string, MediaEvidence>, left: LeftEdit): MomentResult[] {
  return moments.map(m => {
    const words = (evidence.get(m.mediaId)?.words ?? []).filter(w => middle(w) >= m.start && middle(w) < m.end);
    const kept = left.kept[m.mediaId] ?? [];
    const accepted = (typeof m.plays === "string" ? [m.plays] : m.plays).map(spoken);
    const read = (ranges: readonly Range[]) => spoken(words.filter(w => inside(middle(w), ranges)).map(w => w.text).join(" "));
    const played = read(kept);
    const staged = left.staged.filter(s => s.mediaId === m.mediaId && overlap(s, m) > 0);
    const right = accepted.includes(played);
    // A flagged edit is applied and the editor is asked to check it: a wrong one there reaches them.
    const flagged = !right && (left.flagged ?? []).some(s => s.mediaId === m.mediaId && overlap(s, m) > 0);
    if (!staged.length) return { id: m.id, outcome: right ? "right" : flagged ? "asked" : "wrong", played };
    const after = read(subtract(kept, merge(staged)));
    return { id: m.id, outcome: "asked", played, approved: { played: after, right: accepted.includes(after) } };
  });
}

/** Every word of the recordings the task took out, as `mediaId:index`. */
export function removedWords(evidence: ReadonlyMap<string, MediaEvidence>, removed: Record<string, Range[]>): Set<string> {
  const out = new Set<string>();
  for (const [mediaId, ranges] of Object.entries(removed)) {
    (evidence.get(mediaId)?.words ?? []).forEach((w, i) => { if (inside(middle(w), ranges)) out.add(`${mediaId}:${i}`); });
  }
  return out;
}

export interface Agreement {
  trials: number;
  /** F1 of the removed words of each pair of trials. */
  pairF1: { mean: number; min: number; max: number } | null;
  removedByAll: number;
  /** Words some trials removed and others played, and the places they fall in (runs of neighbouring words). */
  split: number;
  splitPlaces: number;
  /** With a reference: how often it also removed a word every trial removed, and one they split on. */
  reference?: { ofRemovedByAll: number | null; ofSplit: number | null };
}

export function agreement(trials: ReadonlyArray<ReadonlySet<string>>, referenceRemoved?: ReadonlySet<string>): Agreement {
  const count = new Map<string, number>();
  for (const t of trials) for (const w of t) count.set(w, (count.get(w) ?? 0) + 1);
  const all = [...count].filter(([, n]) => n === trials.length).map(([w]) => w);
  const split = [...count].filter(([, n]) => n < trials.length).map(([w]) => w);
  const at = (w: string) => { const i = w.lastIndexOf(":"); return { media: w.slice(0, i), index: Number(w.slice(i + 1)) }; };
  const ordered = split.map(at).sort((a, b) => a.media.localeCompare(b.media) || a.index - b.index);
  const places = ordered.filter((w, i) => i === 0 || ordered[i - 1]!.media !== w.media || ordered[i - 1]!.index !== w.index - 1).length;
  const f1s: number[] = [];
  for (let i = 0; i < trials.length; i++) for (let j = i + 1; j < trials.length; j++) {
    const a = trials[i]!, b = trials[j]!;
    let both = 0;
    for (const w of a) if (b.has(w)) both++;
    f1s.push(a.size + b.size ? 2 * both / (a.size + b.size) : 1);
  }
  const share = (words: string[]) => words.length ? words.filter(w => referenceRemoved!.has(w)).length / words.length : null;
  return {
    trials: trials.length,
    pairF1: f1s.length ? { mean: f1s.reduce((x, y) => x + y, 0) / f1s.length, min: Math.min(...f1s), max: Math.max(...f1s) } : null,
    removedByAll: all.length, split: split.length, splitPlaces: places,
    ...(referenceRemoved && { reference: { ofRemovedByAll: share(all), ofSplit: share(split) } }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading finished trials

interface StoredScore {
  left?: LeftEdit;
  applied?: { cuts?: SourceRange[] };
  review?: { cuts?: SourceRange[] } | null;
  headline?: Record<string, number | null>;
}
interface StoredTrial { dir: string; state?: string; score: StoredScore }

/** What a stored trial left. Results from before `left` was saved give the applied cuts and the scored review's. */
function leftOf(score: StoredScore, evidence: ReadonlyMap<string, MediaEvidence>): LeftEdit {
  if (score.left) return score.left;
  const removed: Record<string, Range[]> = {};
  for (const c of score.applied?.cuts ?? []) (removed[c.mediaId] ??= []).push({ start: c.start, end: c.end });
  const kept: Record<string, Range[]> = {};
  for (const [mediaId, e] of evidence) {
    const end = Math.max(e.duration ?? 0, ...(e.words ?? []).map(w => w.end));
    kept[mediaId] = subtract([{ start: 0, end }], merge(removed[mediaId] ?? []));
  }
  return { kept, removed, staged: (score.review?.cuts ?? []).map(c => ({ mediaId: c.mediaId, start: c.start, end: c.end })) };
}

function trialsUnder(run: string, caseId: string): StoredTrial[] {
  const root = isAbsolute(run) ? run : join(resultsDir(), "runs", run);
  const base = checkedPath(isAbsolute(run) ? run : dataDir(), join(root, caseId));
  if (!existsSync(base)) throw new Error(`No results for case ${caseId} under ${root}.`);
  const out: StoredTrial[] = [];
  for (const config of readdirSync(base)) for (const trial of readdirSync(join(base, config)).filter(d => d.startsWith("trial-")).sort()) {
    const dir = join(base, config, trial);
    if (!existsSync(join(dir, "evaluation.json"))) continue;
    const state = existsSync(join(dir, "task.json")) ? readJson<{ task?: { state?: string } }>(join(dir, "task.json")).task?.state : undefined;
    out.push({ dir, state, score: readJson<{ score: StoredScore }>(join(dir, "evaluation.json")).score });
  }
  return out;
}

const HEADLINE = ["wordF1", "deadAirSeconds", "clippedWordsOnSound", "appliedSpeechEdges", "repeatsLeft", "requiredLinesMissing", "needsYourCall", "toolErrors", "activeMinutes"];

export interface ArmSummary {
  label: string;
  trials: number;
  headline: Record<string, { mean: number; sd: number; n: number } | null>;
  moments: Array<{ id: string; right: number; asked: number; askedRight: number; wrong: number; wrongPlayed: Record<string, number> }>;
  agreement: Agreement;
}

export function summarizeArm(label: string, trials: ReadonlyArray<{ score: StoredScore }>, moments: readonly Moment[],
  evidence: ReadonlyMap<string, MediaEvidence>, referenceRemoved?: ReadonlySet<string>): ArmSummary {
  const lefts = trials.map(t => leftOf(t.score, evidence));
  const results = lefts.map(l => scoreMoments(moments, evidence, l));
  const stat = (key: string) => {
    const values = trials.map(t => t.score.headline?.[key]).filter((v): v is number => typeof v === "number");
    if (!values.length) return null;
    const mean = values.reduce((x, y) => x + y, 0) / values.length;
    return { mean, sd: Math.sqrt(values.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, values.length - 1)), n: values.length };
  };
  return {
    label, trials: trials.length,
    headline: Object.fromEntries(HEADLINE.map(k => [k, stat(k)])),
    moments: moments.map((m, i) => {
      const mine = results.map(r => r[i]!);
      const wrongPlayed: Record<string, number> = {};
      for (const r of mine) if (r.outcome === "wrong") wrongPlayed[r.played] = (wrongPlayed[r.played] ?? 0) + 1;
      return { id: m.id, right: mine.filter(r => r.outcome === "right").length, asked: mine.filter(r => r.outcome === "asked").length,
        askedRight: mine.filter(r => r.outcome === "asked" && r.approved?.right).length, wrong: mine.filter(r => r.outcome === "wrong").length, wrongPlayed };
    }),
    agreement: agreement(lefts.map(l => removedWords(evidence, l.removed)), referenceRemoved),
  };
}

export function armsMarkdown(arms: readonly ArmSummary[], moments: readonly Moment[]): string {
  const cell = (s: { mean: number; sd: number; n: number } | null) => !s ? "–" :
    `${s.mean.toFixed(Math.abs(s.mean) < 10 ? 2 : 1)}${s.n > 1 ? ` ± ${s.sd.toFixed(Math.abs(s.mean) < 10 ? 2 : 1)}` : ""}`;
  const pct = (v: number | null | undefined) => v == null ? "–" : `${Math.round(v * 100)}%`;
  const lines = ["## Headline, mean ± spread", "", `| Arm | Trials | ${HEADLINE.join(" | ")} |`, `|---|---|${HEADLINE.map(() => "---").join("|")}|`,
    ...arms.map(a => `| ${a.label} | ${a.trials} | ${HEADLINE.map(k => cell(a.headline[k] ?? null)).join(" | ")} |`)];
  if (moments.length) {
    lines.push("", "## Known moments: right / asked (right once approved) / wrong", "", `| Moment | ${arms.map(a => a.label).join(" | ")} |`, `|---|${arms.map(() => "---").join("|")}|`,
      ...moments.map((m, i) => `| ${m.id} | ${arms.map(a => { const r = a.moments[i]!; return `${r.right} / ${r.asked} (${r.askedRight}) / ${r.wrong}`; }).join(" | ")} |`));
    const wrong = arms.flatMap(a => a.moments.flatMap(r => Object.entries(r.wrongPlayed).map(([played, n]) => `- ${a.label} · ${r.id} · ${n}×: “${played}”`)));
    if (wrong.length) lines.push("", "Played when wrong:", ...wrong);
  }
  lines.push("", "## How far trials of one arm agree", "", "| Arm | Pairs' F1 on removed words (min–max) | Removed by all | Split words | Split places | Reference cut: of removed by all | of split |", "|---|---|---|---|---|---|---|",
    ...arms.map(a => { const g = a.agreement; return `| ${a.label} | ${g.pairF1 ? `${g.pairF1.mean.toFixed(3)} (${g.pairF1.min.toFixed(3)}–${g.pairF1.max.toFixed(3)})` : "–"} | ${g.removedByAll} | ${g.split} | ${g.splitPlaces} | ${pct(g.reference?.ofRemovedByAll)} | ${pct(g.reference?.ofSplit)} |`; }));
  return lines.join("\n") + "\n";
}

const USAGE = `Usage:
  moments.ts --case <id> --runs <label>=<run>[,<run>...] [--runs ...] [--all-states] [--json <file>]

Reads finished trials of a case and reports, for each labelled set of runs (an arm): its headline numbers with their
spread, how each known moment of the case came out (the case folder's moments.json), and how far the arm's trials agree
with each other. A run is a folder name under $SCARLET_EVAL_DATA/results/runs, or a path. Trials that did not finish
are left out unless --all-states is given.`;

async function runCli(argv = process.argv.slice(2)) {
  const { values } = cli({ case: { type: "string" }, runs: { type: "string", multiple: true }, "all-states": { type: "boolean" }, json: { type: "string" } }, USAGE, argv);
  if (!values.case || !values.runs?.length) throw new Error("Give --case and at least one --runs.\n\n" + USAGE);
  const loaded = loadCase(values.case);
  const moments = loadMoments(loaded.dir);
  const published = loaded.file.reference?.published?.kept;
  const referenceRemoved = published && new Set(Object.entries(published).flatMap(([mediaId, kept]) =>
    (loaded.evidence.get(mediaId)?.words ?? []).flatMap((w, i) => inside(middle(w), kept) ? [] : [`${mediaId}:${i}`])));
  const arms = values.runs.map(spec => {
    const at = spec.indexOf("=");
    if (at < 1) throw new Error(`--runs takes label=run[,run...], not “${spec}”.`);
    const trials = spec.slice(at + 1).split(",").filter(Boolean).flatMap(run => trialsUnder(run.trim(), loaded.file.id))
      .filter(t => values["all-states"] || t.state === undefined || t.state === "done");
    if (!trials.length) throw new Error(`No finished trials for ${spec.slice(0, at)}.`);
    return summarizeArm(spec.slice(0, at), trials, moments, loaded.evidence, referenceRemoved);
  });
  if (values.json) writeChosenJson(values.json, { schema: 1, caseId: loaded.file.id, arms }, values.json);
  console.log(armsMarkdown(arms, moments));
}

if (isMain(import.meta.url)) void main(runCli);
