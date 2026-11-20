import { describe, expect, it } from "vitest";
import { applyOps, emptyTimeline } from "@scarlet/timeline";
import { screenReadings, type ScreenLine } from "./screen-reading.js";
import { framingReport } from "./framing-report.js";
import { motionSpans } from "./screen-motion.js";
import type { TimelineWord } from "./timeline-perception.js";

// A screen recording 10 s into its file plays from timeline 0 to 20 under a camera recording that is heard.
function timeline(screen: Record<string, unknown> = {}) {
  return applyOps(emptyTimeline("p"), [
    { op: "addTrack", track: { id: "cam", kind: "video", name: "Camera", clips: [] } },
    { op: "addTrack", track: { id: "scr", kind: "video", name: "Screen", clips: [] } },
    { op: "addClip", trackId: "cam", clip: { id: "c", kind: "media", mediaId: "camera", sourceIn: 0, sourceOut: 20, timelineIn: 0 } },
    { op: "addClip", trackId: "scr", clip: { id: "s1", kind: "media", mediaId: "screen", sourceIn: 10, sourceOut: 20, timelineIn: 0, ...screen } },
    { op: "addClip", trackId: "scr", clip: { id: "s2", kind: "media", mediaId: "screen", sourceIn: 22, sourceOut: 32, timelineIn: 10, ...screen } },
  ]);
}

const said = (text: string, start: number, step = 0.3): TimelineWord[] =>
  text.split(" ").map((word, i) => ({ mediaId: "camera", index: i, text: word, start: start + i * step, end: start + i * step + 0.25 }));

const lines: ScreenLine[] = [
  { start: 10, end: 25, text: "Leave your Lineage pure: do not investigate", box: [0.3, 0.5, 0.6, 0.52] },
  { start: 10, end: 25, text: "origin, ancestry, or self-inflicted", box: [0.3, 0.53, 0.55, 0.55] },
  { start: 10, end: 32, text: "Settings", box: [0.9, 0.02, 0.95, 0.04] },
  { start: 26, end: 32, text: "Price per million tokens", box: [0.1, 0.2, 0.4, 0.23] },
];

describe("screenReadings", () => {
  it("finds a passage read aloud across lines, with the area of the lines it was read from", () => {
    const words = [...said("so it told me this", 1), ...said("leave your lineage pure do not investigate origin ancestry or self-inflicted", 3)];
    const [reading, ...rest] = screenReadings(timeline(), words, new Map([["screen", lines]]));
    expect(rest).toEqual([]);
    expect(reading).toMatchObject({ mediaId: "screen", from: 3, matched: 11, said: "leave your lineage pure do not investigate origin ancestry or self-inflicted",
      box: [0.3, 0.5, 0.6, 0.55] });
    expect(reading!.lines.map(l => l.text)).toEqual([lines[0]!.text, lines[1]!.text]);
    // Source seconds of the screen recording, 10 s into its file.
    expect(reading!.source[0]).toBeCloseTo(13);
  });

  it("matches only text on screen as it is said, and not a few common words", () => {
    // "price per million tokens" is on screen only from source 26, timeline 14.
    expect(screenReadings(timeline(), said("the price per million tokens", 2), new Map([["screen", lines]]))).toEqual([]);
    expect(screenReadings(timeline(), said("the price per million tokens", 15), new Map([["screen", lines]]))).toHaveLength(1);
    expect(screenReadings(timeline(), said("do not go", 15), new Map([["screen", lines]]))).toEqual([]);
  });
});

describe("framingReport", () => {
  const media = [{ id: "screen", kind: "video", width: 1920, height: 1080 }, { id: "camera", kind: "video", width: 1920, height: 1080 }] as never;
  const canvas = { width: 1920, height: 1080 };

  it("gives where the frame holds and moves, a move starting on a cut, and a passage read aloud that the frame leaves out", () => {
    const before = timeline();
    // Zoomed to the top left on the first clip; the second starts there and moves to the bottom right over its first second.
    const after = applyOps(before, [
      { op: "updateClip", clipId: "s1", patch: { transform: { scale: 2, x: 0.5, y: 0.5 } } },
      { op: "updateClip", clipId: "s2", patch: { transform: { scale: 2, x: 0.5, y: 0.5 }, keyframes: [
        { time: 0, transform: { scale: 2, x: 0.5, y: 0.5 }, ease: "linear" }, { time: 1, transform: { scale: 2, x: -0.5, y: -0.5 }, ease: "linear" }] } },
    ]);
    const reading = { from: 3, to: 6, mediaId: "screen", source: [13, 16] as [number, number], said: "leave your lineage", matched: 3, lines: [], box: [0.3, 0.5, 0.6, 0.55] as [number, number, number, number] };
    const [stretch, ...rest] = framingReport(before, after, media, canvas, [reading]);
    expect(rest).toEqual([]);
    expect(stretch).toMatchObject({ mediaId: "screen", trackId: "scr", from: 0, to: 20, clips: 2 });
    expect(stretch!.holds.map(h => [h.from, h.frame])).toEqual([[0, [0, 0, 50, 50]], [11, [50, 50, 100, 100]]]);
    expect(stretch!.moves).toEqual([{ from: 10, to: 11, fromFrame: [0, 0, 50, 50], toFrame: [50, 50, 100, 100], onCut: true }]);
    // The top-left quarter leaves out most of a passage at 30-60% across, 50-55% down.
    expect(stretch!.readsHidden).toEqual([expect.objectContaining({ from: 3, outsideFrame: 100 })]);
    // The cube still turning low on the picture as the frame moves up and away from it.
    const turning = [{ mediaId: "screen", from: 10, to: 12, box: [0.6, 0.6, 0.9, 0.9] as [number, number, number, number], share: 0.1 }];
    expect(framingReport(before, after, media, canvas, [], turning)[0]!.actionHidden).toEqual([{ from: 10, to: 12, box: [60, 60, 90, 90], outsideFrame: 100 }]);
    // Nothing the edit didn't frame is reported.
    expect(framingReport(after, after, media, canvas)).toEqual([]);
  });

  it("gives the video beside a stretch where the recording, off picture, still shows what the frame did, on the clock of the camera beside it", () => {
    // The camera plays throughout, cut at 25 to later footage; the screen, 10 s ahead of it, is framed on its top-left quarter from 5 to 15.
    const before = applyOps(emptyTimeline("p"), [
      { op: "addTrack", track: { id: "cam", kind: "video", name: "Camera", clips: [] } },
      { op: "addTrack", track: { id: "scr", kind: "video", name: "Screen", clips: [] } },
      { op: "addClip", trackId: "cam", clip: { id: "c1", kind: "media", mediaId: "camera", sourceIn: 0, sourceOut: 25, timelineIn: 0 } },
      { op: "addClip", trackId: "cam", clip: { id: "c2", kind: "media", mediaId: "camera", sourceIn: 60, sourceOut: 75, timelineIn: 25 } },
      { op: "addClip", trackId: "scr", clip: { id: "s1", kind: "media", mediaId: "screen", sourceIn: 15, sourceOut: 25, timelineIn: 5 } },
    ]);
    const after = applyOps(before, [{ op: "updateClip", clipId: "s1", patch: { transform: { scale: 2, x: 0.5, y: 0.5 } } }]);
    const demo: ScreenLine = { start: 12, end: 34, text: "Watermelon vs. rifle bullet", box: [0.1, 0.1, 0.4, 0.15] };
    const outside: ScreenLine = { start: 0, end: 90, text: "Settings", box: [0.6, 0.6, 0.9, 0.65] };
    const changes = (...at: number[]) => at.map(s => ({ at: s, areas: [[0.1, 0.2, 0.4, 0.45, 0.05]] as Array<[number, number, number, number, number]> }));
    const words = said("I mean it's pretty cool to watch", 16, 1);
    const report = (lines: ScreenLine[], seconds: ReturnType<typeof changes>) =>
      framingReport(before, after, media, canvas, [], [], { lines: new Map([["screen", lines]]), seconds: new Map([["screen", seconds]]), words })[0]!;

    // The demo's title stays on screen to source 34, timeline 24, while the frame's area keeps moving from source 27.
    const stretch = report([demo, outside], changes(11, 27));
    expect(stretch.shownAfter).toEqual({ from: 15, to: 24, showing: ["Watermelon vs. rifle bullet"], said: "I mean it's pretty cool to watch" });
    // Before, the title came up at source 12, timeline 2, and the frame's area held still from then on.
    expect(stretch.shownBefore).toEqual({ from: 2, to: 5, showing: ["Watermelon vs. rifle bullet"], unchanged: true });
    // A screen that moves on as the stretch ends has nothing beside it; text outside the frame doesn't count.
    expect(report([{ ...demo, end: 25 }, outside], changes(25)).shownAfter).toBeUndefined();
    // With no text, an area that holds still says so, up to where the camera's cut takes the clock past its change.
    expect(report([], changes(11, 40)).shownAfter).toEqual({ from: 15, to: 25, unchanged: true, said: "I mean it's pretty cool to watch" });
  });
});

describe("motionSpans", () => {
  it("runs seconds where the same area changes into one span on the timeline, and keeps a pointer apart", () => {
    const seconds = [
      { at: 12, areas: [[0.3, 0.3, 0.6, 0.8, 0.1], [0.9, 0.1, 0.91, 0.12, 0.001]] as Array<[number, number, number, number, number]> },
      { at: 13, areas: [[0.32, 0.3, 0.62, 0.85, 0.12]] as Array<[number, number, number, number, number]> },
      // The pointer alone, then a new area elsewhere.
      { at: 15, areas: [[0.7, 0.2, 0.71, 0.22, 0.001]] as Array<[number, number, number, number, number]> },
      { at: 16, areas: [[0.05, 0.05, 0.2, 0.2, 0.05]] as Array<[number, number, number, number, number]> },
    ];
    expect(motionSpans(timeline(), new Map([["screen", seconds]]))).toEqual([
      { mediaId: "screen", from: 2, to: 4, box: [0.3, 0.3, 0.62, 0.85], share: 0.12, small: [[0.905, 0.11]] },
      { mediaId: "screen", from: 5, to: 6, box: [0.7, 0.2, 0.71, 0.22], share: 0.001 },
      { mediaId: "screen", from: 6, to: 7, box: [0.05, 0.05, 0.2, 0.2], share: 0.05 },
    ]);
  });
});
