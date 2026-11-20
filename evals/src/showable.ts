/**
 * Does a cut keep a screen recording's picture inside what the editor means viewers to see? The editor confirms a box
 * on a frame of the recording (the window they are presenting, without the desktop, other apps or the call beside it).
 * A box holds for as long as its straight edges stay where they were, so a few confirmed boxes label most of a
 * recording. The score is the share of the labelled screen time on picture that shows anything outside its box.
 */
import { timelineDuration, type Timeline } from "../../packages/timeline/src/index.ts";
import { shownAt, sourceSecondAt } from "./layout.ts";
import type { Gray } from "./picture.ts";

export type Side = "left" | "top" | "right" | "bottom";
const SIDES: readonly Side[] = ["left", "top", "right", "bottom"];
/** A box on the recording's picture, each edge a fraction of its width or height from the top left. */
export type Area = Record<Side, number>;

export interface ShowableLabel {
  /** The recording second of the frame the box was confirmed on. */
  at: number;
  area: Area;
  /** Edges with no line in the picture to find again (a page cut off above a toolbar): not needed for the box to hold. */
  soft?: Side[];
  by?: string;
  on?: string;
}

/** Recording seconds over which one label's box holds; `label` is that label's `at`. */
export interface Hold { from: number; to: number; label: number }

export interface ShowableFile {
  schema: 1;
  /** The screen recording's media id. */
  recording: string;
  labels: ShowableLabel[];
  /** Measured from the recording's frames by `showableMeasure.ts`. */
  holds?: Hold[];
}

/** Brightness steps this large across a pixel count as part of a line. */
const STEP = 4;
/** A box holds on a frame when every edge it needs is a line along at least this share of its length. */
export const HOLDS_AT = 0.5;

/**
 * How well a box's edges show in a frame, 0 to 1: the weakest needed edge's share of its length that is a line there,
 * read a little inside the box's corners and within a pixel of where the edge was. An edge on the frame's own edge always holds.
 */
export function edgeFit(frame: Gray, area: Area, soft: readonly Side[] = []): number {
  const { width: W, height: H, data } = frame;
  const y0 = Math.round(H * (area.top + 0.03)), y1 = Math.round(H * (area.bottom - 0.03));
  const x0 = Math.round(W * (area.left + 0.03)), x1 = Math.round(W * (area.right - 0.03));
  if (y1 <= y0 || x1 <= x0) return 0;
  const column = (x: number) => {
    if (x < 1 || x > W - 2) return 0;
    let n = 0;
    for (let y = y0; y < y1; y++) if (Math.abs(data[y * W + x + 1]! - data[y * W + x - 1]!) > STEP) n++;
    return n / (y1 - y0);
  };
  const row = (y: number) => {
    if (y < 1 || y > H - 2) return 0;
    let n = 0;
    for (let x = x0; x < x1; x++) if (Math.abs(data[(y + 1) * W + x]! - data[(y - 1) * W + x]!) > STEP) n++;
    return n / (x1 - x0);
  };
  let fit = 1;
  for (const side of SIDES) {
    if (soft.includes(side)) continue;
    const v = area[side], upright = side === "left" || side === "right";
    if (v <= 0.002 || v >= 0.998) continue;
    const c = Math.round(v * (upright ? W : H)), at = upright ? column : row;
    fit = Math.min(fit, Math.max(at(c - 1), at(c), at(c + 1)));
  }
  return fit;
}

/** The label whose box holds best on a frame at a recording second, if any does; of equals, the one confirmed nearest in time. */
export function labelFor(frame: Gray, second: number, labels: readonly ShowableLabel[]): ShowableLabel | undefined {
  let best: { label: ShowableLabel; fit: number } | undefined;
  for (const label of labels) {
    const fit = Math.round(edgeFit(frame, label.area, label.soft) * 100) / 100;
    if (fit < HOLDS_AT) continue;
    if (!best || fit > best.fit || (fit === best.fit && Math.abs(label.at - second) < Math.abs(best.label.at - second))) best = { label, fit };
  }
  return best?.label;
}

/** Join per-frame answers, `every` seconds apart, into the stretches each label holds for. */
export function holdsOf(frames: ReadonlyArray<{ second: number; label?: number }>, every: number): Hold[] {
  const holds: Hold[] = [];
  for (const f of frames) {
    if (f.label === undefined) continue;
    const from = f.second - every / 2, to = f.second + every / 2, last = holds.at(-1);
    if (last && last.label === f.label && Math.abs(last.to - from) < 1e-6) last.to = to;
    else holds.push({ from, to, label: f.label });
  }
  return holds;
}

export interface ShowableScore {
  /** Seconds of the cut with the screen recording's picture on it. */
  screenSeconds: number;
  /** Of those, the seconds that play a part of the recording a confirmed box holds for. Only these are scored. */
  labelledSeconds: number;
  /** Labelled seconds that show anything outside their box. */
  outsideSeconds: number;
  /** outsideSeconds / labelledSeconds; null with nothing labelled on picture. */
  outsideShare: number | null;
  /** Labelled seconds that show well outside their box (`far` past it): another window, not a sliver of border. */
  farOutsideSeconds: number;
  farOutsideShare: number | null;
  /** Seconds showing past each edge of the box. One moment can count on several sides. */
  bySide: Record<Side, number>;
  /** The moments furthest outside, one per stretch: cut second, recording second, and how far past the box as a fraction of the picture. */
  worst: Array<{ t: number; source: number; side: Side; over: number }>;
}

export interface ScoreOptions {
  /** Seconds of the cut between two looks. */
  every: number;
  /** How far past a box still counts as inside, as a fraction of the picture: a window's own border and shadow. */
  slack: number;
  /** How far past a box is well outside it, as a fraction of the picture. */
  far: number;
}
export const SCORE_DEFAULTS: ScoreOptions = { every: 0.5, slack: 0.01, far: 0.05 };

/** Score one version of a timeline against a recording's confirmed boxes. Needs `file.holds`. */
export function scoreShowable(tl: Timeline, file: ShowableFile, options: Partial<ScoreOptions> = {}): ShowableScore {
  const { every, slack, far } = { ...SCORE_DEFAULTS, ...options };
  const areas = new Map(file.labels.map(l => [l.at, l.area]));
  const holds = file.holds ?? [];
  const score: ShowableScore = { screenSeconds: 0, labelledSeconds: 0, outsideSeconds: 0, outsideShare: null, farOutsideSeconds: 0, farOutsideShare: null, bySide: { left: 0, top: 0, right: 0, bottom: 0 }, worst: [] };
  const stretches: Array<{ t: number; source: number; side: Side; over: number; until: number }> = [];
  const length = timelineDuration(tl);
  for (let t = every / 2; t < length; t += every) {
    const placed = shownAt(tl, t)[file.recording], source = sourceSecondAt(tl, file.recording, t);
    if (!placed || source === undefined) continue;
    score.screenSeconds += every;
    const hold = holds.find(h => source >= h.from && source < h.to), area = hold && areas.get(hold.label);
    if (!area) continue;
    score.labelledSeconds += every;
    const s = placed.shown;
    const over: Record<Side, number> = { left: area.left - s.x, top: area.top - s.y, right: s.x + s.w - area.right, bottom: s.y + s.h - area.bottom };
    const past = SIDES.filter(side => over[side] > slack);
    if (!past.length) continue;
    score.outsideSeconds += every;
    if (past.some(side => over[side] > far)) score.farOutsideSeconds += every;
    for (const side of past) score.bySide[side] += every;
    const side = past.reduce((a, b) => over[b] > over[a] ? b : a), last = stretches.at(-1);
    if (last && t - last.until <= every + 1e-6) { last.until = t; if (over[side] > last.over) Object.assign(last, { t, source, side, over: over[side] }); }
    else stretches.push({ t, source, side, over: over[side], until: t });
  }
  const round = (v: number) => Math.round(v * 1000) / 1000;
  score.outsideShare = score.labelledSeconds ? round(score.outsideSeconds / score.labelledSeconds) : null;
  score.farOutsideShare = score.labelledSeconds ? round(score.farOutsideSeconds / score.labelledSeconds) : null;
  score.worst = stretches.sort((a, b) => b.over - a.over).slice(0, 8).map(w => ({ t: round(w.t), source: round(w.source), side: w.side, over: round(w.over) }));
  return score;
}
