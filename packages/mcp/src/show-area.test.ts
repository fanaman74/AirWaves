import { describe, expect, it } from "vitest";
import type { MediaAsset, MediaClip, Timeline } from "@scarlet/timeline";
import { showAreaFindings, showAreaRefusal, sourceShown, type RecordingAreas } from "./show-area.js";

const canvas = { width: 1920, height: 1080 };
const media = [{ id: "screen", kind: "video", width: 3840, height: 2160, duration: 100 }, { id: "cam", kind: "video", width: 1920, height: 1080, duration: 100 }] as unknown as MediaAsset[];
const clip = (id: string, mediaId: string, timelineIn: number, sourceIn: number, length: number, transform?: Partial<MediaClip["transform"]>): MediaClip =>
  ({ id, kind: "media", mediaId, timelineIn, sourceIn, sourceOut: sourceIn + length, speed: 1, opacity: 1, ...(transform && { transform }) }) as MediaClip;
const timeline = (...tracks: MediaClip[][]): Timeline => ({ version: "v", tracks: tracks.map((clips, i) => ({ id: `v${i}`, kind: "video", clips })) }) as unknown as Timeline;
const areas: RecordingAreas = { done: true, areas: [{ at: 5, area: [0.1, 0.1, 0.8, 0.9], noLine: [], holds: [[0, 50]] }], unset: [[50, 100]] };
const known = (id: string) => id === "screen" ? areas : undefined;
const inside = { cropLeft: 0.1, cropTop: 0.1, cropRight: 0.2, cropBottom: 0.1 };

describe("what a framed clip shows of its source", () => {
  it("is the crop, or the part a zoom leaves on the video", () => {
    expect(sourceShown(clip("a", "screen", 0, 0, 10, inside), 1, media[0]!, canvas)!.map(n => Math.round(n * 100))).toEqual([10, 10, 80, 90]);
    expect(sourceShown(clip("a", "screen", 0, 0, 10, { scale: 2 }), 1, media[0]!, canvas)!.map(n => Math.round(n * 100))).toEqual([25, 25, 75, 75]);
  });
});

describe("an edit against the areas viewers may see", () => {
  const base = timeline([clip("a", "screen", 0, 0, 10), clip("b", "screen", 10, 60, 10)]);

  it("passes a clip framed inside its area", () => {
    const found = showAreaFindings(base, timeline([clip("a", "screen", 0, 0, 10, inside), clip("b", "screen", 10, 60, 10)]), media, canvas, known);
    expect(found).toEqual({ outside: [], noArea: [], notRead: [] });
    expect(showAreaRefusal(found)).toBeUndefined();
  });
  it("names a clip framed past its area, by side", () => {
    const found = showAreaFindings(base, timeline([clip("a", "screen", 0, 0, 10, { ...inside, cropRight: 0.1 }), clip("b", "screen", 10, 60, 10)]), media, canvas, known);
    expect(found.outside).toHaveLength(1);
    expect(found.outside[0]).toMatchObject({ mediaId: "screen", clipId: "a", from: 0, to: 10, area: [10, 10, 80, 90], beyond: { right: 10 } });
    expect(showAreaRefusal(found)).toContain("past it right 10%");
  });
  it("asks for an area where a clip shows part of a picture that has none", () => {
    const found = showAreaFindings(base, timeline([clip("a", "screen", 0, 0, 10), clip("b", "screen", 10, 60, 10, { scale: 1.5 })]), media, canvas, known);
    expect(found.noArea).toEqual([expect.objectContaining({ mediaId: "screen", from: 50, to: 100, at: expect.any(Number) })]);
    expect(showAreaRefusal(found)).toContain("screen_area");
  });
  it("leaves alone a clip whose framing the edit did not change, one that shows its whole picture, and one under a full picture", () => {
    const wide = { ...inside, cropRight: 0 };
    const was = timeline([clip("a", "screen", 0, 0, 10, wide), clip("b", "screen", 10, 60, 10)]);
    expect(showAreaFindings(was, timeline([clip("a", "screen", 0, 0, 10, wide), clip("b", "screen", 10, 60, 10, { scale: 0.4, x: 0.3 })]), media, canvas, known).outside).toEqual([]);
    const covered = timeline([clip("a", "screen", 0, 0, 10, wide)], [clip("c", "cam", 0, 0, 10)]);
    expect(showAreaFindings(base, covered, media, canvas, known).outside).toEqual([]);
  });
  it("does not refuse while a recording's edges are unread or the engine has no answer", () => {
    const edit = timeline([clip("a", "screen", 0, 0, 10, { scale: 1.5 }), clip("b", "screen", 10, 60, 10)]);
    expect(showAreaRefusal(showAreaFindings(base, edit, media, canvas, () => ({ done: false, areas: [], unset: [] })))).toBeUndefined();
    expect(showAreaRefusal(showAreaFindings(base, edit, media, canvas, () => undefined))).toBeUndefined();
  });
  it("joins clips in a row with the same finding", () => {
    const out = { ...inside, cropRight: 0.1 };
    const found = showAreaFindings(base, timeline([clip("a", "screen", 0, 0, 5, out), clip("a2", "screen", 5, 5, 5, out), clip("b", "screen", 10, 60, 10)]), media, canvas, known);
    expect(found.outside).toEqual([expect.objectContaining({ clipId: "a", clips: 2, from: 0, to: 10 })]);
  });
});
