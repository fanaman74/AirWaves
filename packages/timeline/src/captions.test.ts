import { describe, expect, it } from "vitest";
import {
  CaptionExportError, captionExportHasCues, captionExportRange, emptyTimeline, formatCaptionTime,
  makeTrack, NO_CAPTION_TRACK, NO_CAPTIONS_IN_RANGE, timelineToSrt, timelineToVtt,
  type CaptionClip, type Timeline,
} from "./index.js";

const line = (id: string, start: number, end: number, text: string, extra: Partial<CaptionClip> = {}): CaptionClip => ({
  id, kind: "caption", enabled: true, timelineIn: start, timelineOut: end, text, ...extra,
});

function cut(clips: CaptionClip[], extra: Partial<Timeline["tracks"][number]> = {}): Timeline {
  const tl = emptyTimeline("project");
  tl.tracks.push({ ...makeTrack("caption", "Captions", "cap"), clips, ...extra });
  return tl;
}

describe("caption sidecars", () => {
  it("writes two cues in SubRip with comma milliseconds and in WebVTT with a header and dots", () => {
    const tl = cut([line("cap_1", 0.2, 2.4, "Welcome back"), line("cap_2", 5.6, 7.6, "Three things today")]);
    expect(timelineToSrt(tl)).toBe([
      "1",
      "00:00:00,200 --> 00:00:02,400",
      "Welcome back",
      "",
      "2",
      "00:00:05,600 --> 00:00:07,600",
      "Three things today",
      "",
    ].join("\n"));
    expect(timelineToVtt(tl)).toBe([
      "WEBVTT",
      "",
      "00:00:00.200 --> 00:00:02.400",
      "Welcome back",
      "",
      "00:00:05.600 --> 00:00:07.600",
      "Three things today",
      "",
    ].join("\n"));
  });

  it("rounds to the millisecond and keeps hours on long times", () => {
    expect(formatCaptionTime(0.2, ",")).toBe("00:00:00,200");
    expect(formatCaptionTime(0.2, ".")).toBe("00:00:00.200");
    expect(formatCaptionTime(0.1 + 0.2, ",")).toBe("00:00:00,300");
    expect(formatCaptionTime(1.2346, ",")).toBe("00:00:01,235");
    expect(formatCaptionTime(3661.5, ",")).toBe("01:01:01,500");
    expect(formatCaptionTime(36000, ".")).toBe("10:00:00.000");
    const tl = cut([line("long", 3661.5, 3663.25, "Later")]);
    expect(timelineToSrt(tl)).toContain("01:01:01,500 --> 01:01:03,250");
    expect(timelineToVtt(tl)).toContain("01:01:01.500 --> 01:01:03.250");
  });

  it("keeps multi-line text, writes special characters, escapes them only in WebVTT, and turns --> into an arrow", () => {
    const tl = cut([
      line("multi", 0, 1, "Hello\r\n\nthere"),
      line("chars", 1, 2, "A < B & C --> D"),
    ]);
    expect(timelineToSrt(tl)).toContain("Hello\nthere");
    expect(timelineToSrt(tl)).toContain("A < B & C → D");
    expect(timelineToVtt(tl)).toContain("Hello\nthere");
    expect(timelineToVtt(tl)).toContain("A &lt; B &amp; C → D");
    expect(timelineToVtt(tl)).not.toContain("A < B");
  });

  it("drops whitespace-only lines inside a cue, so the cue after them is still read", () => {
    const tl = cut([line("first", 0, 1, "First\n   \nLast"), line("tab", 1, 2, "\t\nSecond\n \t ")]);
    expect(timelineToSrt(tl)).toBe("1\n00:00:00,000 --> 00:00:01,000\nFirst\nLast\n\n2\n00:00:01,000 --> 00:00:02,000\nSecond\n");
    expect(timelineToVtt(tl)).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nFirst\nLast\n\n00:00:01.000 --> 00:00:02.000\nSecond\n");
  });

  it("sorts cues by start, leaves overlapping lines as they are, and skips hidden tracks, disabled clips and empty text", () => {
    const tl = emptyTimeline("project");
    tl.tracks.push({
      ...makeTrack("caption", "Off", "hidden"), hidden: true,
      clips: [line("ghost", 0, 1, "Hidden")],
    });
    tl.tracks.push({
      ...makeTrack("caption", "Captions", "cap"),
      clips: [
        line("later", 4, 5, "Second"),
        line("empty", 0, 1, "   "),
        line("blank", 0.5, 1, "\n\n"),
        line("off", 1, 2, "Disabled", { enabled: false }),
        line("zero", 3, 3, "Instant"),
        line("first", 0.5, 4.5, "First"),
        line("overlap", 4, 6, "Overlap"),
        line("tiny", 7, 7.0004, "Too short"),
      ],
    });
    expect(timelineToSrt(tl)).toBe([
      "1",
      "00:00:00,500 --> 00:00:04,500",
      "First",
      "",
      "2",
      "00:00:04,000 --> 00:00:05,000",
      "Second",
      "",
      "3",
      "00:00:04,000 --> 00:00:06,000",
      "Overlap",
      "",
    ].join("\n"));
    // A hidden track stays out even when it is asked for by id.
    expect(() => timelineToSrt(tl, { trackId: "hidden" })).toThrow(CaptionExportError);
    expect(() => timelineToVtt(tl, { trackId: "hidden" })).toThrow("That caption track is hidden. Show it, then export again.");
  });

  it("keeps only cues that overlap a range, shifts them so 0 is the range start, and clips a cue that begins before it", () => {
    const tl = cut([
      line("early", 0.2, 2.4, "Welcome back"),
      line("mid", 5.6, 7.6, "Three things today"),
      line("late", 9, 10, "After"),
    ]);
    const range = { start: 1, end: 6 };
    expect(timelineToSrt(tl, { range })).toBe([
      "1",
      "00:00:00,000 --> 00:00:01,400",
      "Welcome back",
      "",
      "2",
      "00:00:04,600 --> 00:00:05,000",
      "Three things today",
      "",
    ].join("\n"));
    expect(timelineToVtt(tl, { range })).toContain("00:00:00.000 --> 00:00:01.400");
    expect(timelineToVtt(tl, { range })).toContain("00:00:04.600 --> 00:00:05.000");
    expect(timelineToVtt(tl, { range })).not.toContain("After");
  });

  it("refuses a version with no caption track, a missing track, and a track that isn't captions", () => {
    const empty = emptyTimeline("project");
    expect(() => timelineToSrt(empty)).toThrow(CaptionExportError);
    expect(() => timelineToSrt(empty)).toThrow(NO_CAPTION_TRACK);
    expect(() => timelineToVtt(empty)).toThrow(NO_CAPTION_TRACK);
    expect(() => timelineToSrt(cut([line("c", 0, 1, "Hi")]), { trackId: "missing" })).toThrow("That caption track isn’t in this version.");
    expect(() => timelineToSrt(empty, { trackId: "v1" })).toThrow("That track isn’t captions.");
    const hiddenOnly = emptyTimeline("project");
    hiddenOnly.tracks.push({ ...makeTrack("caption", "Off", "cap"), hidden: true, clips: [line("c", 0, 1, "Hi")] });
    expect(() => timelineToSrt(hiddenOnly)).toThrow(NO_CAPTION_TRACK);
  });

  it("refuses an empty track or a range that leaves no cues", () => {
    expect(() => timelineToSrt(cut([]))).toThrow(NO_CAPTIONS_IN_RANGE);
    expect(() => timelineToVtt(cut([]))).toThrow(NO_CAPTIONS_IN_RANGE);
    const tl = cut([line("early", 0.2, 2.4, "Welcome back")]);
    expect(captionExportHasCues(tl)).toBe(true);
    expect(captionExportHasCues(tl, { range: { start: 8, end: 10 } })).toBe(false);
    expect(() => timelineToSrt(tl, { range: { start: 8, end: 10 } })).toThrow(NO_CAPTIONS_IN_RANGE);
    expect(() => timelineToVtt(tl, { range: { start: 8, end: 10 } })).toThrow(NO_CAPTIONS_IN_RANGE);
  });

  it("refuses a range that starts before 0 or does not end after its start", () => {
    expect(() => captionExportRange(-0.1, 2)).toThrow(CaptionExportError);
    expect(() => captionExportRange(-0.1, 2)).toThrow("Range start must be at least 0.");
    expect(captionExportRange(0, 2)).toEqual({ start: 0, end: 2 });
    expect(() => captionExportRange(5, 4)).toThrow("Range end must be after its start.");
    expect(() => captionExportRange(3, 3)).toThrow(CaptionExportError);
    expect(() => captionExportRange(undefined, 0)).toThrow(CaptionExportError);
  });

  it("writes plain cue text and leaves out karaoke words and uppercase style", () => {
    const tl = cut([line("k", 0, 1, "Hello there", {
      words: [{ text: "Hello", start: 0, end: 0.4 }, { text: "there", start: 0.4, end: 1 }],
      style: { uppercase: true },
    })]);
    expect(timelineToSrt(tl)).toBe("1\n00:00:00,000 --> 00:00:01,000\nHello there\n");
    expect(timelineToVtt(tl)).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello there\n");
    expect(timelineToVtt(tl)).not.toContain("<c>");
    expect(timelineToSrt(tl)).not.toContain("HELLO");
  });
});
