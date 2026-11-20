import { describe, expect, it } from "vitest";
import { applyOps, emptyTimeline, type MediaAsset, type Timeline } from "@scarlet/timeline";
import { newBriefPictures, briefPictures, edgesOntoRecordingCuts, flashesOntoCuts, CUT_GRID, cutShareOf, type RecordingCut } from "./brief-pictures.js";

const canvas = { width: 3840, height: 2160 };
const media = [
  { id: "camera", kind: "video", width: 3840, height: 2160 },
  { id: "screen", kind: "video", width: 3840, height: 2160 },
] as MediaAsset[];
const tight = { x: -0.005, y: -0.061, scale: 1.18, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 };
const zoomed = { x: -0.08, y: -0.61, scale: 3.64, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 };

/** The stretch of his edit at 1:26 (2026-11-16): wide camera, a screen insert over it, then a punch-in at the next cut. */
function edit(insertEnd: number, extra: object[] = []): Timeline {
  return applyOps(emptyTimeline("p"), [
    { op: "addTrack", track: { id: "v_demo", kind: "video", name: "Screen", clips: [] } },
    { op: "addClip", trackId: "v1", clip: { id: "wide", kind: "media", mediaId: "camera", sourceIn: 308.35, sourceOut: 314.52, timelineIn: 80.15 } },
    { op: "addClip", trackId: "v1", clip: { id: "punch", kind: "media", mediaId: "camera", sourceIn: 332.44, sourceOut: 339.25, timelineIn: 86.32, transform: tight } },
    { op: "addClip", trackId: "v_demo", clip: { id: "wang_reply", kind: "media", mediaId: "screen", sourceIn: 322.22, sourceOut: 322.22 + (insertEnd - 83.05) * 0.25,
      speed: 0.25, timelineIn: 83.05, transform: zoomed } },
    ...extra,
  ] as never);
}

describe("briefPictures", () => {
  it("names the wide camera left on screen for four frames between an insert and a punch-in", () => {
    expect(briefPictures(edit(86.19), media, canvas)).toEqual([
      { from: 86.19, to: 86.32, seconds: 0.13, shows: ["wide"], before: ["wang_reply"], after: ["punch"] },
    ]);
  });

  it("says nothing when the insert ends on the cut, or the camera holds for a second", () => {
    expect(briefPictures(edit(86.32), media, canvas)).toEqual([]);
    expect(briefPictures(edit(85.2), media, canvas)).toEqual([]);
  });

  it("doesn't count a cut between two pieces at the same framing, or a change hidden under a full insert", () => {
    const tl = applyOps(emptyTimeline("p"), [
      { op: "addTrack", track: { id: "v2", kind: "video", name: "Screen", clips: [] } },
      { op: "addClip", trackId: "v1", clip: { id: "a", kind: "media", mediaId: "camera", sourceIn: 0, sourceOut: 5, timelineIn: 0 } },
      { op: "addClip", trackId: "v1", clip: { id: "b", kind: "media", mediaId: "camera", sourceIn: 9, sourceOut: 9.2, timelineIn: 5 } },
      { op: "addClip", trackId: "v1", clip: { id: "c", kind: "media", mediaId: "camera", sourceIn: 12, sourceOut: 20, timelineIn: 5.2, transform: tight } },
      { op: "addClip", trackId: "v1", clip: { id: "d", kind: "media", mediaId: "camera", sourceIn: 20, sourceOut: 20.2, timelineIn: 13.2 } },
      { op: "addClip", trackId: "v1", clip: { id: "e", kind: "media", mediaId: "camera", sourceIn: 22, sourceOut: 30, timelineIn: 13.4, transform: tight } },
      { op: "addClip", trackId: "v2", clip: { id: "s", kind: "media", mediaId: "screen", sourceIn: 0, sourceOut: 3, timelineIn: 12, transform: zoomed } },
    ] as never);
    // b is the same wide framing as a, so a→b→c changes the picture once; d plays only under the screen.
    expect(briefPictures(tl, media, canvas)).toEqual([]);
  });

  it("leaves a dissolve alone", () => {
    const tl = edit(86.19, [{ op: "updateClip", clipId: "punch", patch: { videoFadeIn: 0.3 } }]);
    expect(briefPictures(tl, media, canvas)).toEqual([]);
  });

  it("reports only a brief picture the edit makes, not one already in the video", () => {
    const before = edit(86.19);
    const after = applyOps(before, [{ op: "updateClip", clipId: "punch", patch: { opacity: 1 } }] as never);
    expect(newBriefPictures(before, after, media, canvas)).toEqual([]);
    expect(newBriefPictures(edit(86.32), before, media, canvas)).toHaveLength(1);
  });
});

describe("briefPictures with the cuts in a recording", () => {
  /** A cut at `at` source seconds changing the cells centred in `box` ([left, top, right, bottom] of the source). */
  const cutAt = (at: number, box = [0.22, 0.06, 0.86, 1]): RecordingCut => {
    const { cols, rows } = CUT_GRID, bits = new Uint8Array(cols * rows / 8);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const cx = (x + 0.5) / cols, cy = (y + 0.5) / rows;
      if (cx >= box[0]! && cx <= box[2]! && cy >= box[1]! && cy <= box[3]!) bits[(y * cols + x) >> 3]! |= 1 << ((y * cols + x) & 7);
    }
    return { at, share: 0.3, cells: Buffer.from(bits).toString("base64") };
  };
  const reply = { x: -0.06, y: -0.588, scale: 3.745, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 };
  /** His edit at 1:19 (2026-11-18): the wide camera, and over it 2.5 s of the screen that switched to another window and back. */
  const insert = (sourceIn = 323.82, sourceOut = 326.3) => applyOps(emptyTimeline("p"), [
    { op: "addTrack", track: { id: "v_screen", kind: "video", name: "Screen", clips: [] } },
    { op: "addClip", trackId: "v1", clip: { id: "wide", kind: "media", mediaId: "camera", sourceIn: 308.36, sourceOut: 314.53, timelineIn: 77.978 } },
    { op: "addClip", trackId: "v_screen", clip: { id: "wang_reply", kind: "media", mediaId: "screen", sourceIn, sourceOut, timelineIn: 79.613, transform: reply } },
  ] as never);
  const cuts = new Map([["screen", [cutAt(325.1), cutAt(325.967), cutAt(326.667)]]]);

  it("names the other window and the reply's return, each on screen for under a second", () => {
    expect(briefPictures(insert(), media, canvas)).toEqual([]);
    expect(briefPictures(insert(), media, canvas, undefined, cuts)).toEqual([
      { from: 80.893, to: 81.76, seconds: 0.867, shows: ["wang_reply"], before: ["wang_reply"], after: ["wang_reply"],
        recordingCuts: [{ at: 80.893, clip: "wang_reply", source: 325.1, changed: 100 }, { at: 81.76, clip: "wang_reply", source: 325.967, changed: 100 }] },
      { from: 81.76, to: 82.093, seconds: 0.333, shows: ["wang_reply"], before: ["wang_reply"], after: ["wide"],
        recordingCuts: [{ at: 81.76, clip: "wang_reply", source: 325.967, changed: 100 }] },
    ]);
  });

  it("says nothing of an insert that ends on the recording's cut", () => {
    expect(briefPictures(insert(323.82, 325.1), media, canvas, undefined, cuts)).toEqual([]);
  });

  it("leaves out a cut in a part of the recording the frame doesn't show", () => {
    const corner = new Map([["screen", [cutAt(325.1, [0, 0, 0.3, 0.3]), cutAt(325.967, [0, 0, 0.3, 0.3])]]]);
    expect(briefPictures(insert(), media, canvas, undefined, corner)).toEqual([]);
    expect(cutShareOf(cutAt(1, [0, 0, 0.5, 1]), [0.25, 0, 0.75, 1])).toBe(0.5);
  });

  it("reports a brief picture at a recording's cut once, also when its cuts were read after it was laid", () => {
    expect(newBriefPictures(insert(), insert(), media, canvas, cuts)).toEqual([]);
    expect(newBriefPictures(null, insert(), media, canvas, cuts)).toHaveLength(2);
    expect(newBriefPictures(insert(), insert(), media, canvas, cuts, new Set(["screen"]))).toHaveLength(2);
  });
});

describe("flashesOntoCuts", () => {
  const all = () => true;
  /** Wide camera, then a punch-in at 86.32; a silent screen insert over the wide shot from `start` to `end`. */
  const over = (start: number, end: number, volume = 0) => applyOps(emptyTimeline("p"), [
    { op: "addTrack", track: { id: "v_demo", kind: "video", name: "Screen", clips: [] } },
    { op: "addClip", trackId: "v1", clip: { id: "wide", kind: "media", mediaId: "camera", sourceIn: 308.35, sourceOut: 314.52, timelineIn: 80.15 } },
    { op: "addClip", trackId: "v1", clip: { id: "punch", kind: "media", mediaId: "camera", sourceIn: 332.44, sourceOut: 339.25, timelineIn: 86.32, transform: tight } },
    { op: "addClip", trackId: "v_demo", clip: { id: "insert", kind: "media", mediaId: "screen", sourceIn: 100, sourceOut: 100 + end - start, timelineIn: start, volume,
      transform: zoomed, keyframes: [{ time: 0, transform: zoomed }, { time: 1, transform: { ...zoomed, scale: 3 } }] } },
  ] as never);
  const plain = applyOps(emptyTimeline("p"), [
    { op: "addClip", trackId: "v1", clip: { id: "wide", kind: "media", mediaId: "camera", sourceIn: 308.35, sourceOut: 314.52, timelineIn: 80.15 } },
    { op: "addClip", trackId: "v1", clip: { id: "punch", kind: "media", mediaId: "camera", sourceIn: 332.44, sourceOut: 339.25, timelineIn: 86.32, transform: tight } },
  ] as never);

  it("ends an insert that stops two frames short of the camera's cut on that cut", () => {
    // Zzz at 0:55 (2026-11-17): the screen ended at 55.222 and the camera cut to the next take at 55.289.
    const after = over(83.05, 86.25);
    const { ops, met } = flashesOntoCuts(plain, after, media, canvas, all);
    expect(met).toEqual([{ from: 86.25, to: 86.32, seconds: 0.07, clips: ["insert"] }]);
    expect(ops).toHaveLength(1);
    const fixed = applyOps(after, ops);
    expect(fixed.tracks.find(t => t.id === "v_demo")!.clips[0]).toMatchObject({ timelineIn: 83.05 });
    expect(fixed.tracks.find(t => t.id === "v_demo")!.clips[0]!.sourceOut).toBeCloseTo(103.27, 6);
    expect(briefPictures(fixed, media, canvas)).toEqual([]);
  });

  it("starts an insert that begins two frames after the cut on that cut, keeping its moves where they were", () => {
    const after = over(86.38, 89);
    const { ops, met } = flashesOntoCuts(plain, after, media, canvas, all);
    expect(met).toEqual([{ from: 86.32, to: 86.38, seconds: 0.06, clips: ["insert"] }]);
    const insert = applyOps(after, ops).tracks.find(t => t.id === "v_demo")!.clips[0]!;
    expect(insert.timelineIn).toBeCloseTo(86.32, 6);
    expect(insert.sourceIn).toBeCloseTo(99.94, 6);
    expect(insert.kind === "media" && insert.keyframes!.map(k => k.time)).toEqual([expect.closeTo(0.06, 6), expect.closeTo(1.06, 6)]);
  });

  it("leaves a longer brief picture, an audible insert, one already in the video and a clip it can't name to the run", () => {
    expect(flashesOntoCuts(plain, over(83.05, 86.19), media, canvas, all).met).toEqual([]);
    expect(flashesOntoCuts(plain, over(83.05, 86.25, 1), media, canvas, all).met).toEqual([]);
    expect(flashesOntoCuts(over(83.05, 86.25), over(83.05, 86.25), media, canvas, all).met).toEqual([]);
    expect(flashesOntoCuts(plain, over(83.05, 86.25), media, canvas, id => id !== "insert").met).toEqual([]);
  });
});


describe("edgesOntoRecordingCuts", () => {
  const all = () => true;
  const cutAt = (at: number): RecordingCut => ({ at, share: 1, cells: Buffer.alloc(CUT_GRID.cols * CUT_GRID.rows / 8, 0xff).toString("base64") });
  const reply = { x: -0.06, y: -0.588, scale: 3.745, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 };
  const base = applyOps(emptyTimeline("p"), [
    { op: "addTrack", track: { id: "v_screen", kind: "video", name: "Screen", clips: [] } },
    { op: "addTrack", track: { id: "v_inset", kind: "video", name: "Inset", clips: [] } },
    { op: "addClip", trackId: "v1", clip: { id: "wide", kind: "media", mediaId: "camera", sourceIn: 300, sourceOut: 340, timelineIn: 70 } },
  ] as never);
  /** A silent screen insert with the camera inset beside it over the same time, from `start` to `end` of the timeline. */
  const laid = (start: number, end: number, sourceIn: number, volume = 0) => applyOps(base, [
    { op: "addClip", trackId: "v_screen", clip: { id: "screen", kind: "media", mediaId: "screen", sourceIn, sourceOut: sourceIn + end - start, timelineIn: start, volume, transform: reply,
      keyframes: [{ time: 0, transform: reply }, { time: 2, transform: { ...reply, scale: 3 } }] } },
    { op: "addClip", trackId: "v_inset", clip: { id: "inset", kind: "media", mediaId: "camera", sourceIn: 310, sourceOut: 310 + end - start, timelineIn: start, volume: 0,
      transform: { x: 0.35, y: 0.35, scale: 0.25, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 } } },
  ] as never);

  it("ends the insert at 1:20 where the recording first switched, taking out the other window and the reply's return", () => {
    // 2.48 s of the recording from 323.82, which switched to another window at 325.1 and back at 325.967 (2026-11-18).
    const cuts = new Map([["screen", [cutAt(325.1), cutAt(325.967), cutAt(326.667)]]]);
    const after = laid(79.613, 82.093, 323.82);
    const { ops, met } = edgesOntoRecordingCuts(base, after, media, canvas, cuts, all);
    expect(met).toEqual([{ from: 82.093, to: 80.893, seconds: 1.2, clips: ["screen", "inset"], source: 325.1 }]);
    const fixed = applyOps(after, ops);
    for (const id of ["screen", "inset"]) {
      const clip = fixed.tracks.flatMap(t => t.clips).find(c => c.id === id)!;
      expect(clip.timelineIn).toBeCloseTo(79.613, 6);
      expect(clip.timelineIn + clip.sourceOut - clip.sourceIn).toBeCloseTo(80.893, 6);
    }
    expect(briefPictures(fixed, media, canvas, undefined, cuts)).toEqual([]);
  });

  it("starts an insert that opens on a menu half a second before the game on the game, keeping its moves where they were", () => {
    const cuts = new Map([["screen", [cutAt(448.729)]]]);
    const after = laid(94.161, 99.73, 448.282);
    const { ops, met } = edgesOntoRecordingCuts(base, after, media, canvas, cuts, all);
    expect(met).toEqual([{ from: 94.161, to: 94.608, seconds: 0.447, clips: ["screen", "inset"], source: 448.729 }]);
    const screen = applyOps(after, ops).tracks.find(t => t.id === "v_screen")!.clips[0]!;
    expect(screen.timelineIn).toBeCloseTo(94.608, 3);
    expect(screen.sourceIn).toBeCloseTo(448.729, 3);
    expect(screen.kind === "media" && screen.keyframes!.map(k => k.time)).toEqual([expect.closeTo(-0.447, 3), expect.closeTo(1.553, 3)]);
  });

  it("leaves a switch and back in the middle of an insert, one that would leave the insert brief, an audible insert and one it can't name", () => {
    expect(edgesOntoRecordingCuts(base, laid(70, 76, 100), media, canvas, new Map([["screen", [cutAt(102), cutAt(102.5)]]]), all).met).toEqual([]);
    expect(edgesOntoRecordingCuts(base, laid(70, 71.5, 100), media, canvas, new Map([["screen", [cutAt(100.8)]]]), all).met).toEqual([]);
    // A game whose view swings round twice in an insert's last 1.8 s, with 0.5 s before: the insert would lose most of itself.
    expect(edgesOntoRecordingCuts(base, laid(70, 72.3, 100), media, canvas, new Map([["screen", [cutAt(100.5), cutAt(101.3)]]]), all).met).toEqual([]);
    const late = new Map([["screen", [cutAt(105.5)]]]);
    expect(edgesOntoRecordingCuts(base, laid(70, 76, 100), media, canvas, late, all).met).toHaveLength(1);
    expect(edgesOntoRecordingCuts(base, laid(70, 76, 100, 1), media, canvas, late, all).met).toEqual([]);
    expect(edgesOntoRecordingCuts(base, laid(70, 76, 100), media, canvas, late, id => id !== "inset").met).toEqual([]);
    expect(edgesOntoRecordingCuts(laid(70, 76, 100), laid(70, 76, 100), media, canvas, late, all).met).toEqual([]);
  });
});
