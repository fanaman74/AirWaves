/**
 * A cut read against the editor's own, decision by decision. Word counts flatter a pass: most of what comes out of a
 * raw recording is long retakes and production talk that any cut removes, so the few dozen hard calls vanish in the
 * thousands of easy words. Here each run of removed words is one decision however long it is, each pause either
 * editor could trim is one pause, and each line said twice is one choice of take.
 *
 * Pure: the scorecard feeds it a recording's words and what each cut kept of it, in source seconds.
 */
import { findRestarts } from "../../packages/shared/src/restarts.ts";
import { covered, merge, type Range } from "./intervals.ts";
import { labelWords, type Label, type Word } from "./metrics.ts";

/** A pause shorter than this is the space between words, not a pause anyone trims. */
export const PAUSE_SECONDS = 0.4;
/** A piece shorter than this between two cuts plays as a stutter. */
export const STUTTER_SECONDS = 1;
/** A run of this many words or more that one cut plays and the other doesn't is one a viewer would notice. */
export const NOTICED_WORDS = 2;
/** A run of this many words or more that Scarlet left in and the editor cut is a clear missed removal, not a brief tightening. */
export const LONG_MISSED_WORDS = 6;

/** Consecutive in-scope words one cut removed and the other kept: `words` long, from `start` to `end`. */
export interface Disagreement extends Range { words: number; text: string }

export interface CutDetail {
  /** Removals as decisions: a run of words a cut takes out, one decision whatever its length. */
  decisions: {
    editor: number; scarlet: number;
    /** The editor's removals Scarlet made too (it cut at least half their words), and Scarlet's the editor made too. */
    editorMatched: number; scarletMatched: number;
  };
  /** Runs Scarlet cut that the editor kept, and runs Scarlet left in that the editor cut. */
  wronglyCut: Disagreement[];
  leftIn: Disagreement[];
  /** Pauses of PAUSE_SECONDS or more between two words both cuts play. */
  pauses: { total: number; editorTrimmed: number; scarletTrimmed: number; bothTrimmed: number };
  /** Lines said twice where the editor kept one delivery: whether Scarlet kept the same one. */
  takes: { decided: number; same: number; other: number; both: number; neither: number };
  /** Pieces between two of Scarlet's cuts that play for under STUTTER_SECONDS. */
  pieces: { total: number; short: number; editorTotal: number; editorShort: number };
}

const text = (ws: readonly Word[]) => ws.map(w => w.text.trim()).join(" ");

/** Maximal runs of consecutive words (by index in `labels`) for which `pick` holds; a word out of scope ends a run. */
function runs(labels: ReadonlyArray<Label | undefined>, pick: (i: number) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let from = -1;
  for (let i = 0; i <= labels.length; i++) {
    const on = i < labels.length && labels[i] !== undefined && pick(i);
    if (on && from < 0) from = i;
    if (!on && from >= 0) { out.push([from, i]); from = -1; }
  }
  return out;
}

const share = (labels: ReadonlyArray<Label | undefined>, [a, b]: [number, number], label: Label) => {
  let n = 0;
  for (let i = a; i < b; i++) if (labels[i] === label) n++;
  return n / (b - a);
};

/** Pieces a cut plays, and how many are short: the first and last piece of a recording aren't between two cuts. */
function pieces(kept: readonly Range[]) {
  const ps = merge(kept, 0.001);
  return { total: ps.length, short: ps.slice(1, -1).filter(p => p.end - p.start < STUTTER_SECONDS).length };
}

/**
 * One recording. `base` is what the source version plays of it, `scarlet` what the pass left, `editor` what the
 * published video kept. A word is kept by a cut that plays at least half of it.
 */
export function cutDetail(words: readonly Word[], base: readonly Range[], scarlet: readonly Range[], editor: readonly Range[]): CutDetail {
  const sorted = words.filter(w => w.text.trim()).slice().sort((a, b) => a.start - b.start);
  const s = labelWords(sorted, base, scarlet), e = labelWords(sorted, base, editor);
  const cutBy = (l: ReadonlyArray<Label | undefined>) => runs(l, i => l[i] === "cut");
  const editorCuts = cutBy(e), scarletCuts = cutBy(s);
  const span = ([a, b]: [number, number]): Disagreement => ({ start: sorted[a]!.start, end: sorted[b - 1]!.end, words: b - a, text: text(sorted.slice(a, b)) });

  // Pauses both cuts could have trimmed: between two neighbouring words each of them plays.
  const sKept = merge(scarlet), eKept = merge(editor);
  const whole = (kept: readonly Range[], gap: Range) => covered(gap, kept) >= (gap.end - gap.start) - 0.02;
  const pauses = { total: 0, editorTrimmed: 0, scarletTrimmed: 0, bothTrimmed: 0 };
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (s[i] !== "keep" || s[i + 1] !== "keep" || e[i] !== "keep" || e[i + 1] !== "keep") continue;
    const gap = { start: sorted[i]!.end, end: sorted[i + 1]!.start };
    if (gap.end - gap.start < PAUSE_SECONDS) continue;
    const byEditor = !whole(eKept, gap), byScarlet = !whole(sKept, gap);
    pauses.total++;
    if (byEditor) pauses.editorTrimmed++;
    if (byScarlet) pauses.scarletTrimmed++;
    if (byEditor && byScarlet) pauses.bothTrimmed++;
  }

  // A line said twice: the editor chose a take where it kept one delivery and cut the other.
  const tokens = sorted.map(w => w.text.trim().toLowerCase().replace(/[^\p{L}\p{N}']+/gu, ""));
  const takes = { decided: 0, same: 0, other: 0, both: 0, neither: 0 };
  for (const r of findRestarts(tokens, sorted.map(w => w.start), sorted.map(w => w.end))) {
    if (r.length < 2) continue;
    const first: [number, number] = [r.at, r.at + r.length], second: [number, number] = [r.next, r.next + r.length];
    if (second[1] > sorted.length || [...Array(r.length)].some((_, k) => e[first[0] + k] === undefined || e[second[0] + k] === undefined)) continue;
    const kept = (l: ReadonlyArray<Label | undefined>, t: [number, number]) => share(l, t, "keep") >= 0.5;
    const eFirst = kept(e, first), eSecond = kept(e, second);
    if (eFirst === eSecond) continue;
    const sFirst = kept(s, first), sSecond = kept(s, second);
    takes.decided++;
    if (sFirst && sSecond) takes.both++;
    else if (!sFirst && !sSecond) takes.neither++;
    else if (sFirst === eFirst) takes.same++;
    else takes.other++;
  }

  const mine = pieces(scarlet), theirs = pieces(editor);
  return {
    decisions: {
      editor: editorCuts.length, scarlet: scarletCuts.length,
      editorMatched: editorCuts.filter(r => share(s, r, "cut") >= 0.5).length,
      scarletMatched: scarletCuts.filter(r => share(e, r, "cut") >= 0.5).length,
    },
    wronglyCut: runs(s, i => s[i] === "cut" && e[i] === "keep").map(span),
    leftIn: runs(s, i => s[i] === "keep" && e[i] === "cut").map(span),
    pauses, takes,
    pieces: { total: mine.total, short: mine.short, editorTotal: theirs.total, editorShort: theirs.short },
  };
}

/** Several recordings of one cut, added up. */
export function addCutDetails(parts: readonly CutDetail[]): CutDetail {
  const sum = <T extends Record<string, number>>(pick: (d: CutDetail) => T): T =>
    parts.reduce((acc, d) => { for (const [k, v] of Object.entries(pick(d))) (acc as Record<string, number>)[k] = ((acc as Record<string, number>)[k] ?? 0) + v; return acc; }, {} as T);
  return { decisions: sum(d => d.decisions), wronglyCut: parts.flatMap(d => d.wronglyCut), leftIn: parts.flatMap(d => d.leftIn),
    pauses: sum(d => d.pauses), takes: sum(d => d.takes), pieces: sum(d => d.pieces) };
}
