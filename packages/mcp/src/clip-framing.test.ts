import { describe, expect, it } from "vitest";
import { applyOps, emptyTimeline } from "@scarlet/timeline";
import { insetsToLook, unframedBeside } from "./clip-framing.js";

const inset = { x: 0.35, y: 0.315, scale: 0.32, rotation: 0, cropLeft: 0.15, cropRight: 0.15, cropTop: 0.09, cropBottom: 0.09 };

function base() {
  return applyOps(emptyTimeline("p"), [
    { op: "addTrack", track: { id: "cam", kind: "video", name: "Camera", clips: [] } },
    { op: "addClip", trackId: "cam", clip: { id: "a", kind: "media", mediaId: "camera", sourceIn: 0, sourceOut: 10, timelineIn: 0, transform: inset } },
    { op: "addClip", trackId: "cam", clip: { id: "b", kind: "media", mediaId: "camera", sourceIn: 30, sourceOut: 40, timelineIn: 10, transform: inset } },
  ]);
}

describe("unframedBeside", () => {
  it("names a clip put back full frame between framed clips of the same recording", () => {
    const before = base();
    const after = applyOps(before, [
      { op: "rippleInsertGap", at: 10, duration: 5 },
      { op: "addClip", trackId: "cam", clip: { id: "back", kind: "media", mediaId: "camera", sourceIn: 10, sourceOut: 30, timelineIn: 10, speed: 4 } },
    ]);
    expect(unframedBeside(before, after)).toEqual([{ clipId: "back", trackId: "cam", at: 10, beside: { clipId: "a", transform: expect.objectContaining({ scale: 0.32 }) } }]);
  });

  it("says nothing when the added clip is framed, or its neighbours are another recording or unframed too", () => {
    const before = base();
    const framed = applyOps(before, [
      { op: "rippleInsertGap", at: 10, duration: 5 },
      { op: "addClip", trackId: "cam", clip: { id: "back", kind: "media", mediaId: "camera", sourceIn: 10, sourceOut: 15, timelineIn: 10, transform: inset } },
    ]);
    expect(unframedBeside(before, framed)).toEqual([]);
    const other = applyOps(before, [
      { op: "rippleInsertGap", at: 10, duration: 5 },
      { op: "addClip", trackId: "cam", clip: { id: "still", kind: "media", mediaId: "photo", sourceIn: 0, sourceOut: 5, timelineIn: 10 } },
    ]);
    expect(unframedBeside(before, other)).toEqual([]);
    // A split keeps the framing on both halves, so nothing it makes is new and unframed.
    expect(unframedBeside(before, applyOps(before, [{ op: "splitClip", clipId: "a", at: 5, newClipId: "a2" }]))).toEqual([]);
  });
});

describe("insetsToLook", () => {
  const media = [
    { id: "screen", kind: "video", width: 3024, height: 1964 },
    { id: "camera", kind: "video", width: 3840, height: 2160 },
  ] as never;
  const canvas = { width: 1920, height: 1080 };
  function withInset(transform: typeof inset, count = 5) {
    return applyOps(emptyTimeline("p"), [
      { op: "addTrack", track: { id: "screen", kind: "video", name: "Screen", clips: [] } },
      { op: "addTrack", track: { id: "inset", kind: "video", name: "Inset", clips: [] } },
      { op: "addClip", trackId: "screen", clip: { id: "s", kind: "media", mediaId: "screen", sourceIn: 0, sourceOut: 10 * count, timelineIn: 0 } },
      ...Array.from({ length: count }, (_, i) => ({ op: "addClip" as const, trackId: "inset",
        clip: { id: `i${i}`, kind: "media" as const, mediaId: "camera", sourceIn: 100 + 10 * i, sourceOut: 110 + 10 * i, timelineIn: 10 * i, transform } })),
    ]);
  }

  it("names an inset an edit cropped anew, with its crop and moments spread over its clips", () => {
    const after = withInset(inset);
    expect(insetsToLook(null, after, media, canvas)).toEqual([{ mediaId: "camera", trackId: "inset", clips: 5,
      crop: [0.15, 0.09, 0.85, 0.91], at: [105, 125, 145] }]);
    const tighter = withInset({ ...inset, cropTop: 0.01, cropLeft: 0.25, cropRight: 0.25 });
    expect(insetsToLook(after, tighter, media, canvas).map(i => i.crop)).toEqual([[0.25, 0.01, 0.75, 0.91]]);
  });

  it("says nothing when the inset keeps its crop and size, or the picture fills the video", () => {
    const after = withInset(inset);
    const moved = withInset({ ...inset, x: -0.35 });
    expect(insetsToLook(after, moved, media, canvas)).toEqual([]);
    expect(insetsToLook(after, applyOps(after, [{ op: "splitClip", clipId: "i0", at: 5, newClipId: "i0b" }]), media, canvas)).toEqual([]);
    expect(insetsToLook(null, withInset({ ...inset, x: 0, y: 0, scale: 1.2 }), media, canvas)).toEqual([]);
  });
});
