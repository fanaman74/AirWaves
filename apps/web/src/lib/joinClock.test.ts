import { describe, expect, it } from "vitest";
import type { Timeline } from "@scarlet/timeline";
import { composeClocks, joinClock, verifiedJoinClock } from "./joinClock";

describe("joinClock", () => {
  const clock = joinClock([{ start: 40, end: 50 }, { start: 10, end: 20 }, { start: 18, end: 25 }], 100);

  it("merges overlapping removals and maps both ways", () => {
    expect(clock.removed).toEqual([{ start: 10, end: 25 }, { start: 40, end: 50 }]);
    expect(clock.toMedia(5)).toBe(5);
    expect(clock.toMedia(30)).toBe(15);
    expect(clock.toMedia(60)).toBe(35);
    expect(clock.toView(5)).toBe(5);
    expect(clock.toView(15.5)).toBe(30.5);
    expect(clock.toView(35)).toBe(60);
  });

  it("puts every moment of removed footage on its join, and reads a join as where the footage resumes", () => {
    expect(clock.toMedia(10)).toBe(10);
    expect(clock.toMedia(17)).toBe(10);
    expect(clock.toMedia(25)).toBe(10);
    expect(clock.toView(10)).toBe(25);
    expect(clock.toView(9.999)).toBeCloseTo(9.999, 9);
    expect(clock.toMedia(45)).toBe(25);
    expect(clock.toView(25)).toBe(50);
  });
});

describe("composeClocks", () => {
  // An earlier version 100 s long. The working cut took out 30–35 since; a call takes 24–30 of the working cut out,
  // which is 24–30 here too, so the two removals meet at the call's end.
  const earlier = joinClock([{ start: 30, end: 35 }], 100);
  const call = joinClock([{ start: 24, end: 30 }], 95);
  const both = composeClocks(earlier, call);

  it("removes what both clocks remove, in the earlier version's clock", () => {
    expect(both.duration).toBe(100);
    expect(both.removed).toEqual([{ start: 24, end: 35 }]);
  });

  it("plays the call's media for the earlier version, a moment in either removal landing on the one join", () => {
    expect(both.toMedia(10)).toBe(10);
    expect(both.toMedia(26)).toBe(24);
    expect(both.toMedia(32)).toBe(24);
    expect(both.toMedia(40)).toBe(29);
    expect(both.toView(24)).toBe(35);
    expect(both.toView(29)).toBe(40);
  });
});

describe("verifiedJoinClock", () => {
  const clip = (id: string, timelineIn: number, sourceIn: number, sourceOut: number) => ({ id, kind: "media", mediaId: "med_a", timelineIn, sourceIn, sourceOut,
    speed: 1, opacity: 1, volume: 1, enabled: true, audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0, effects: [] });
  const timeline = (version: string, clips: ReturnType<typeof clip>[]) => ({ version, projectId: "prj", name: "Main", markers: [], createdAt: "",
    tracks: [{ id: "v1", kind: "video", clips }] }) as unknown as Timeline;
  const before = timeline("v_before", [clip("a", 0, 0, 60)]);
  const after = timeline("v_after", [clip("a", 0, 0, 10), clip("b", 10, 20, 60)]);

  it("accepts a version that is exactly the view with the removals out", () => {
    const clock = verifiedJoinClock(before, after, [{ start: 10, end: 20 }], 30, [8, 10, 20, 23]);
    expect(clock?.toMedia(23)).toBe(13);
  });

  it("reuses the source index but verifies each audition on its own part of the footage", () => {
    const wrongTail = timeline("v_wrong_tail", [clip("a", 0, 0, 10), clip("b", 10, 21, 61)]);
    const removed = [{ start: 10, end: 20 }];
    expect(verifiedJoinClock(before, wrongTail, removed, 30, [8])).toBeDefined();
    expect(verifiedJoinClock(before, wrongTail, removed, 30, [23])).toBeUndefined();
  });

  it("refuses one that differs in any other way, so the caller keeps its own playback", () => {
    expect(verifiedJoinClock(before, after, [{ start: 10, end: 19 }], 30, [8, 23])).toBeUndefined();
    const shifted = timeline("v_shifted", [clip("a", 0, 0, 10), clip("b", 10, 21, 61)]);
    expect(verifiedJoinClock(before, shifted, [{ start: 10, end: 20 }], 30, [8, 23])).toBeUndefined();
  });
});
