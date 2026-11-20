import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MockClient } from "./MockClient";
import { PRJ } from "./fixtures";

let api: MockClient;
beforeEach(() => {
  vi.useFakeTimers();
  api = new MockClient(() => "mock");
});
afterEach(() => {
  vi.useRealTimers();
});

it("builds SubRip and WebVTT data URLs for the sample interview's captions", () => {
  const srt = decodeURIComponent(api.srtUrl(PRJ, "head").replace("data:text/plain;charset=utf-8,", ""));
  expect(srt).toContain("00:00:00,200 --> 00:00:02,400");
  expect(srt).toContain("Welcome back");
  expect(srt).toContain("00:00:08,000");
  const vtt = decodeURIComponent(api.vttUrl(PRJ, "ver_4").replace("data:text/vtt;charset=utf-8,", ""));
  expect(vtt.startsWith("WEBVTT\n")).toBe(true);
  expect(vtt).toContain("00:00:05.600 --> 00:00:07.600");
  expect(() => api.srtUrl(PRJ, "ver_2")).toThrow(/no caption track to export/);
  expect(() => api.srtUrl(PRJ, "head", { start: 12, end: 16 })).toThrow(/no captions in this range/);
});

it("refuses a backwards range as the engine does, not as a range with no captions", () => {
  for (const url of [() => api.srtUrl(PRJ, "head", { start: 5, end: 4 }), () => api.vttUrl(PRJ, "head", { start: 5, end: 4 })]) {
    expect(url).toThrow(expect.objectContaining({ status: 400, code: "bad_range", message: "Range end must be after its start." }));
  }
});
