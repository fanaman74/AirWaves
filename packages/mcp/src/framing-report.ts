/**
 * What an edit's framing of a recording shows, stretch by stretch, read back from the clips it wrote.
 *
 * timeline_framing places a frame and says what it hides, but a run can frame every demo in one bulk timeline_propose
 * with transforms of its own, and then nothing it reads back says what the viewer sees. A pass did that (2026-11-17):
 * its frame on a demo cropped the page's title and buttons, it moved the picture down for a large cube and back up for
 * the scramble, and when a later save took the move down out, the move back up stayed, starting on a jump cut while
 * the cube was still large. This reports, for each stretch an edit framed, where the frame holds and where it moves,
 * and what of the text the speaker reads aloud there the frame leaves out or a picture over it covers.
 */
import { clipEnd, Transform as TransformSchema, type MediaAsset, type MediaClip, type Timeline } from "@scarlet/timeline";
import { frameShown, pictureBox, type Box } from "./framing.js";
import type { ScreenLine, ScreenReading } from "./screen-reading.js";
import { SMALL, type MotionSecond, type MotionSpan } from "./screen-motion.js";

interface Size { width: number; height: number }

export interface FramedStretch {
  mediaId: string; trackId: string;
  /** Timeline seconds the stretch covers, over the clips in a row the edit framed. */
  from: number; to: number;
  clips: number;
  /** Where the frame stands still: the area of the source picture that fills the video, in percent; empty where the picture doesn't fill the video. */
  holds: Array<{ from: number; to: number; frame: number[] }>;
  /** Where it moves from one frame to the next. `onCut` when the move starts on a cut in the picture. */
  moves: Array<{ from: number; to: number; fromFrame: number[]; toFrame: number[]; onCut?: true }>;
  /** Readings aloud (screen_reading) in the stretch whose lines the frame leaves out or a picture over it covers. */
  readsHidden?: Array<{ from: number; to: number; said: string; box: number[]; outsideFrame?: number; underCover?: number }>;
  /** Areas where the picture keeps changing (screen_motion) in the stretch that the frame leaves out or a picture over it covers. */
  actionHidden?: Array<{ from: number; to: number; box: number[]; outsideFrame?: number; underCover?: number }>;
  /** The video after the stretch, with the recording off picture, while the recording goes on showing what the frame showed last. */
  shownAfter?: ShownBeside;
  /** The video before the stretch, with the recording off picture, while the recording already showed what the frame shows first. */
  shownBefore?: ShownBeside;
}

/** Time of the video beside a framed stretch, with its recording off picture, while the recording shows what the frame did at that edge. */
export interface ShownBeside {
  /** Timeline seconds. */
  from: number; to: number;
  /** Lines of the recording's text in the frame at the edge that are still there, up to three. */
  showing?: string[];
  /** Nothing in the frame's area of the recording changes over it. */
  unchanged?: true;
  /** The words heard over it. */
  said?: string;
}

/** What recordings show while off picture, and what is said, for the time beside each stretch. */
export interface BesideEvidence {
  /** Each recording's text on screen, in source seconds (screen_text). */
  lines: ReadonlyMap<string, readonly ScreenLine[]>;
  /** Each recording's seconds whose picture changed, in source seconds (screen_motion). */
  seconds: ReadonlyMap<string, readonly MotionSecond[]>;
  /** The words heard on the timeline. */
  words: ReadonlyArray<{ text: string; start: number; end: number }>;
}

/** Frames are compared this often along a stretch. */
const STEP = 0.1;
/** A frame within this of the last, in fractions of the picture, holds. */
const STILL = 0.002;
/** A share of a reading's lines hidden below this goes unreported. */
const HIDDEN = 0.05;
/** A share of a changing area hidden below this goes unreported: the edge of a large change is often a shadow or a border. */
const ACTION_HIDDEN = 0.1;
/** The video beside a stretch is looked along in steps this long, as far as this. */
const BESIDE_STEP = 0.5;
export const BESIDE_MAX = 60;

const pct = (b: readonly number[]) => b.map(n => Math.round(n * 1000) / 10);
const r2 = (n: number) => Math.round(n * 100) / 100;
const framing = (clip: MediaClip) => JSON.stringify([TransformSchema.parse(clip.transform ?? {}), (clip.keyframes ?? []).map(k => [k.time, k.transform, k.ease ?? "linear"])]);
const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const meet = (a: Box, b: Box): Box => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

/**
 * The stretches `after` frames that `before` framed otherwise: clips of a recording on one track, in a row, that the edit
 * added or whose transform or keyframes it changed, with the stretch they make together.
 */
export function framingReport(before: Timeline | null, after: Timeline, media: readonly MediaAsset[], canvas: Size,
  readings: readonly ScreenReading[] = [], motion: readonly MotionSpan[] = [], beside?: BesideEvidence): FramedStretch[] {
  const was = new Map(before?.tracks.flatMap(t => t.clips.map(c => [c.id, c] as const)) ?? []);
  const assets = new Map(media.map(m => [m.id, m]));
  const size = (id: string): Size => ({ width: assets.get(id)?.width || canvas.width, height: assets.get(id)?.height || canvas.height });
  const visible = after.tracks.map((track, index) => ({ track, index })).filter(({ track }) => track.kind === "video" && !track.hidden);
  const opaque = (c: MediaClip) => c.enabled !== false && c.opacity > 0 && assets.get(c.mediaId)?.kind !== "graphic";
  const layers = visible.flatMap(({ track, index }) => track.clips.filter((c): c is MediaClip => c.kind === "media" && opaque(c)).map(clip => ({ clip, index })));
  const changed = (c: MediaClip) => {
    const old = was.get(c.id);
    return (!!c.transform || !!c.keyframes?.length) && !(old?.kind === "media" && framing(old) === framing(c));
  };

  const out: FramedStretch[] = [];
  for (const { track, index } of visible) {
    const clips = track.clips.filter((c): c is MediaClip => c.kind === "media" && opaque(c)).sort((a, b) => a.timelineIn - b.timelineIn);
    // Stretches: framed clips of one recording in a row, holding at least one the edit changed.
    let run: MediaClip[] = [];
    const flush = () => {
      // A picture that doesn't fill the video, such as a camera inset, has no frame to report.
      const made = run.some(changed) ? stretch(run, track.id, index) : undefined;
      if (made && [...made.holds.map(h => h.frame), ...made.moves.map(m => m.toFrame)].some(f => f.length)) out.push(made);
      run = [];
    };
    for (const clip of clips) {
      const prev = run.at(-1);
      const framed = !!clip.transform || !!clip.keyframes?.length;
      if (prev && (!framed || prev.mediaId !== clip.mediaId || clip.timelineIn - clipEnd(prev) > 0.05)) flush();
      if (framed) run.push(clip);
    }
    flush();
  }

  function stretch(run: MediaClip[], trackId: string, trackIndex: number): FramedStretch {
    const source = size(run[0]!.mediaId);
    const from = run[0]!.timelineIn, to = clipEnd(run.at(-1)!);
    const cuts = run.slice(1).map(c => c.timelineIn);
    // The frame along the stretch, sampled.
    const samples: Array<{ t: number; frame: Box | null }> = [];
    for (const clip of run) {
      const end = clipEnd(clip);
      for (let t = clip.timelineIn; t < end - 1e-6; t = Math.min(end, t + STEP)) {
        samples.push({ t, frame: frameShown(clip, t - clip.timelineIn, source, canvas) });
        if (end - t <= STEP) { samples.push({ t: end - 1e-3, frame: frameShown(clip, Math.max(0, end - 1e-3 - clip.timelineIn), source, canvas) }); break; }
      }
    }
    const same = (a: Box | null, b: Box | null) => a === b || (!!a && !!b && a.every((n, i) => Math.abs(n - b[i]!) < STILL));
    const frameAt = (n: number) => samples[n]!.frame ? pct(samples[n]!.frame!) : [];
    const crosses = (n: number) => cuts.some(c => samples[n - 1]!.t < c - 1e-6 && samples[n]!.t >= c - 1e-6);
    const holds: FramedStretch["holds"] = [], moves: FramedStretch["moves"] = [];
    if (samples.length === 1) holds.push({ from: r2(from), to: r2(to), frame: frameAt(0) });
    // Between each sample and the next the frame stays or changes; a run of either is a hold or a move.
    for (let a = 1; a < samples.length;) {
      const still = same(samples[a]!.frame, samples[a - 1]!.frame);
      let b = a;
      while (b + 1 < samples.length && same(samples[b + 1]!.frame, samples[b]!.frame) === still) b++;
      const first = samples[a - 1]!, last = samples[b]!;
      if (still) holds.push({ from: r2(first.t), to: r2(b === samples.length - 1 ? to : last.t), frame: frameAt(a - 1) });
      else {
        // A change between two samples across a cut is a cut to another frame, not a move.
        const jump = b === a && crosses(a);
        moves.push({ from: r2(first.t), to: r2(jump ? first.t : last.t), fromFrame: frameAt(a - 1), toFrame: frameAt(b),
          ...(!jump && cuts.some(c => Math.abs(c - first.t) <= STEP + 1e-6) && { onCut: true as const }) });
      }
      a = b + 1;
    }
    // A move held for a moment and moved on is one move: keyframes a hair apart read as a stutter of tiny moves otherwise.
    for (let n = moves.length - 1; n > 0; n--) {
      const prev = moves[n - 1]!, next = moves[n]!;
      if (next.from - prev.to > 0.3 || prev.to === prev.from || next.to === next.from) continue;
      prev.to = next.to; prev.toFrame = next.toFrame;
      moves.splice(n, 1);
      const gap = holds.findIndex(h => h.from >= prev.from - 1e-6 && h.to <= prev.to + 1e-6);
      if (gap >= 0) holds.splice(gap, 1);
    }

    /** The largest shares of an area of the source, over a stretch of time, that the frame leaves out and that a picture over it covers. */
    const hiddenOf = (box: Box, start: number, end: number) => {
      let out = 0, cover = 0;
      const area0 = area(box);
      if (area0 <= 0) return { out, cover };
      for (const s of samples) {
        if (s.t < start || s.t > end || !s.frame) continue;
        const f = s.frame, fw = f[2] - f[0], fh = f[3] - f[1];
        out = Math.max(out, 1 - area(meet(box, f)) / area0);
        // The area on the video, and the pictures over it there.
        const onVideo: Box = [(box[0] - f[0]) / fw, (box[1] - f[1]) / fh, (box[2] - f[0]) / fw, (box[3] - f[1]) / fh];
        const seen = meet(onVideo, [0, 0, 1, 1]);
        if (area(seen) <= 0) continue;
        const covers = layers.filter(l => l.index > trackIndex && l.clip.timelineIn <= s.t && s.t < clipEnd(l.clip))
          .map(l => pictureBox(l.clip, s.t - l.clip.timelineIn, size(l.clip.mediaId), canvas))
          .map(b => meet(b, [0, 0, 1, 1])).filter(b => area(b) > 0 && area(b) < 0.9);
        cover = Math.max(cover, Math.min(1, covers.reduce((n, c) => n + area(meet(seen, c)), 0) / area(onVideo)));
      }
      return { out, cover };
    };
    const shares = ({ out, cover }: { out: number; cover: number }, least: number) => ({
      ...(out >= least && { outsideFrame: Math.round(out * 100) }), ...(cover >= least && { underCover: Math.round(cover * 100) }) });

    // What of each reading aloud in the stretch the viewer doesn't see.
    const hidden: NonNullable<FramedStretch["readsHidden"]> = [];
    for (const r of readings) {
      if (r.mediaId !== run[0]!.mediaId || r.to <= from || r.from >= to) continue;
      const seen = hiddenOf(r.box as Box, r.from, r.to);
      if (seen.out >= HIDDEN || seen.cover >= HIDDEN) hidden.push({ from: r.from, to: r.to, said: r.said.length > 80 ? `${r.said.slice(0, 77)}…` : r.said, box: pct(r.box), ...shares(seen, HIDDEN) });
    }
    // And of each area where the picture keeps changing.
    const action: NonNullable<FramedStretch["actionHidden"]> = [];
    for (const m of motion) {
      if (m.mediaId !== run[0]!.mediaId || m.to <= from || m.from >= to || m.share < SMALL) continue;
      const seen = hiddenOf(m.box, m.from, m.to);
      if (seen.out < ACTION_HIDDEN && seen.cover < ACTION_HIDDEN) continue;
      const item = { from: m.from, to: m.to, box: pct(m.box), ...shares(seen, ACTION_HIDDEN) };
      // The same area changing again a moment later is one entry: a demo that animates throughout listed its page a dozen times.
      const last = action.at(-1);
      if (last && item.from - last.to <= 3 && last.box.every((n, i) => Math.abs(n - item.box[i]!) <= 5)) {
        last.to = item.to;
        last.box = last.box.map((n, i) => i < 2 ? Math.min(n, item.box[i]!) : Math.max(n, item.box[i]!));
        if (item.outsideFrame) last.outsideFrame = Math.max(last.outsideFrame ?? 0, item.outsideFrame);
        if (item.underCover) last.underCover = Math.max(last.underCover ?? 0, item.underCover);
      } else action.push(item);
    }
    const shownAfter = beside && besideShown(run, "after", samples.at(-1)?.frame ?? null, beside);
    const shownBefore = beside && besideShown(run, "before", samples[0]?.frame ?? null, beside);
    return { mediaId: run[0]!.mediaId, trackId, from: r2(from), to: r2(to), clips: run.length, holds, moves, ...(hidden.length && { readsHidden: hidden }), ...(action.length && { actionHidden: action.slice(0, 10) }),
      ...(shownAfter && { shownAfter }), ...(shownBefore && { shownBefore }) };
  }

  /**
   * The video beside a stretch, with its recording off picture, while the recording shows what the frame did at that
   * edge: a line of its text in the frame is still there, or nothing in the frame has changed since.
   */
  function besideShown(run: MediaClip[], side: "after" | "before", frame: Box | null, evidence: BesideEvidence): ShownBeside | undefined {
    const walk = besideWalk(after, run, side, layers.map(l => l.clip));
    if (!walk || !frame) return undefined;
    const mediaId = run[0]!.mediaId, edge = walk.edge;
    const inFrame = (b: readonly number[]) => area(meet(b as Box, frame)) >= area(b as Box) / 2;
    const lines = (evidence.lines.get(mediaId) ?? []).filter(l => l.start <= edge && l.end >= edge && inFrame(l.box));
    const changes = (evidence.seconds.get(mediaId) ?? []).filter(s => s.areas.some(a => a[4] >= SMALL && area(meet(a.slice(0, 4) as Box, frame)) > 0));
    let last: { t: number; showing: string[]; unchanged: boolean } | undefined;
    for (const { t, source } of walk.steps) {
      const [lo, hi] = side === "after" ? [edge, source] : [source, edge];
      const unchanged = !changes.some(s => s.at + 1 > lo && s.at < hi);
      const showing = lines.filter(l => side === "after" ? l.end >= source : l.start <= source).map(l => l.text);
      if (!unchanged && !showing.length) break;
      last = { t, showing, unchanged };
    }
    if (!last) return undefined;
    const [a, b] = side === "after" ? [walk.at, last.t + BESIDE_STEP / 2] : [last.t - BESIDE_STEP / 2, walk.at];
    if (b - a < 1) return undefined;
    const said = evidence.words.filter(w => w.start >= a - 0.05 && w.end <= b + 0.05).map(w => w.text.trim()).filter(Boolean).join(" ");
    return { from: r2(a), to: r2(b), ...(last.showing.length && { showing: [...new Set(last.showing)].slice(0, 3) }), ...(last.unchanged && { unchanged: true as const }),
      ...(said && { said: said.length > 200 ? `${said.slice(0, 197)}…` : said }) };
  }

  return out.sort((a, b) => a.from - b.from);
}

/**
 * The steps along the video beside a run of a recording's clips, after its end or before its start, while the recording
 * is off picture, with its source second at each. Its clock there is the clock of another recording that plays at the
 * edge and on beside it, heard ones first, as a camera's sound is, at the offset the two have at the edge. Undefined
 * when nothing else plays there.
 */
export function besideWalk(tl: Timeline, run: readonly MediaClip[], side: "after" | "before", pictures?: readonly MediaClip[]) {
  const mediaId = run[0]!.mediaId;
  const edgeClip = side === "after" ? run.at(-1)! : run[0]!;
  const at = side === "after" ? clipEnd(edgeClip) : edgeClip.timelineIn;
  const inside = side === "after" ? at - 1e-3 : at + 1e-3;
  const sourceAt = (c: MediaClip, t: number) => c.sourceIn + (t - c.timelineIn) * (c.speed ?? 1);
  const edge = sourceAt(edgeClip, inside);
  const media = tl.tracks.flatMap(t => t.clips.filter((c): c is MediaClip => c.kind === "media" && c.enabled !== false));
  const others = media.filter(c => c.mediaId !== mediaId && (c.speed ?? 1) === 1);
  const playing = (id: string, t: number) => others.find(c => c.mediaId === id && c.timelineIn <= t + 1e-6 && t < clipEnd(c) - 1e-6);
  const step = side === "after" ? BESIDE_STEP : -BESIDE_STEP;
  const clock = others.filter(c => c.timelineIn <= inside && inside < clipEnd(c) && playing(c.mediaId, at + step / 2))
    .sort((a, b) => Number(b.volume > 0) - Number(a.volume > 0))[0];
  if (!clock) return undefined;
  const offset = edge - sourceAt(clock, inside);
  const own = (pictures ?? tl.tracks.filter(t => t.kind === "video" && !t.hidden).flatMap(t => t.clips.filter((c): c is MediaClip => c.kind === "media" && c.enabled !== false)))
    .filter(c => c.mediaId === mediaId);
  const steps: Array<{ t: number; source: number }> = [];
  for (let t = at + step / 2; Math.abs(t - at) < BESIDE_MAX && t >= 0; t += step) {
    if (own.some(c => c.timelineIn <= t && t < clipEnd(c))) break;
    const c = playing(clock.mediaId, t);
    if (!c) break;
    steps.push({ t, source: sourceAt(c, t) + offset });
  }
  return { at, edge, steps };
}

/** The source seconds of each recording that the video beside the framed stretches reaches, to read what it shows there. */
export function besideSources(tl: Timeline, framed: readonly FramedStretch[]): Array<{ id: string; from: number; to: number }> {
  const reach = new Map<string, { from: number; to: number }>();
  for (const f of framed) {
    const run = (tl.tracks.find(t => t.id === f.trackId)?.clips ?? [])
      .filter((c): c is MediaClip => c.kind === "media" && c.mediaId === f.mediaId && c.enabled !== false && c.timelineIn >= f.from - 0.01 && clipEnd(c) <= f.to + 0.01)
      .sort((a, b) => a.timelineIn - b.timelineIn);
    if (!run.length) continue;
    for (const side of ["after", "before"] as const) {
      const walk = besideWalk(tl, run, side);
      if (!walk?.steps.length) continue;
      const seconds = [walk.edge, ...walk.steps.map(s => s.source)];
      const was = reach.get(f.mediaId);
      reach.set(f.mediaId, { from: Math.min(was?.from ?? Infinity, ...seconds), to: Math.max(was?.to ?? -Infinity, ...seconds) });
    }
  }
  return [...reach].map(([id, r]) => ({ id, from: Math.max(0, Math.floor(r.from) - 1), to: Math.ceil(r.to) + 1 }));
}

export const FRAMING_REPORT_NEXT = "framed lists each stretch this edit framed: where the frame holds and where it moves, as the area of the source picture that fills the video ([left, top, right, bottom] in percent); readsHidden, the passages the speaker reads aloud there (screen_reading) whose lines the frame leaves out (outsideFrame) or a picture over it covers (underCover), in percent of those lines; actionHidden, the areas where the picture keeps changing (screen_motion) that it leaves out or covers, in percent of each area; and shownAfter and shownBefore, the video just after the stretch ends or just before it starts, with the recording off picture, while the recording still shows what the frame showed at that edge: lines of its text still there (showing), or nothing in the frame changed (unchanged), with the words heard over it (said). A move marked onCut starts on a cut in the picture. frame_contact_sheet on the new version shows any of it as it plays.";
