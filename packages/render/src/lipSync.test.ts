import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bestShift, correlationAt, lipSyncStretch, resolveFfmpeg, runCapture } from "./index.js";

/** Syllables: on and off in runs of 3 to 12 frames, the same every time. */
function talking(frames: number) {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const on: boolean[] = [];
  while (on.length < frames) {
    const run = 3 + Math.floor(next() * 10), speaking = next() > 0.4;
    for (let i = 0; i < run && on.length < frames; i++) on.push(speaking);
  }
  return on;
}

describe("bestShift", () => {
  it("finds the frames the sound comes first by, and says so as a positive lead", () => {
    const fps = 30, on = talking(900), lead = 12;
    const motion = on.map(v => v ? 1 : 0);
    // The sound of frame i is heard `lead` frames before the picture shows it.
    const loudness = on.map((_, i) => on[i + lead] ? 1 : 0);
    const reading = bestShift(motion, loudness, fps, 45);
    expect(reading.soundLeads).toBeCloseTo(lead / fps, 2);
    expect(reading.match).toBeGreaterThan(0.9);
    expect(reading.matchInSync).toBeLessThan(0.5);
  });

  it("reads sound heard after the picture as a negative lead, and sound in time as none", () => {
    const fps = 30, on = talking(900);
    const motion = on.map(v => v ? 1 : 0);
    expect(bestShift(motion, on.map((_, i) => on[i - 6] ? 1 : 0), fps, 45).soundLeads).toBeCloseTo(-6 / fps, 2);
    const inTime = bestShift(motion, motion, fps, 45);
    expect(inTime.soundLeads).toBe(0);
    expect(inTime.match).toBe(inTime.matchInSync);
  });

  it("correlates only the frames both have", () => {
    expect(correlationAt([1, 2, 3, 4], [1, 2, 3, 4], 0)).toBeCloseTo(1);
    expect(correlationAt([1, 2, 3, 4], [9, 1, 2, 3], 1)).toBeCloseTo(1);
    expect(correlationAt([1, 2], [1, 2], 5)).toBe(0);
  });
});

it("measures a recording whose sound runs ahead of a moving mouth", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-lip-sync-"));
  try {
    const fps = 30, seconds = 12, frames = fps * seconds, rate = 48000, lead = 0.4;
    const on = talking(frames + fps);
    // The mouth: a square that flickers while speaking, on a still grey frame.
    const W = 128, H = 72, picture = Buffer.alloc(W * H * frames, 90);
    for (let f = 0; f < frames; f++) {
      if (!on[f]) continue;
      const shade = f % 2 ? 230 : 20;
      for (let y = 40; y < 60; y++) picture.fill(shade, f * W * H + y * W + 54, f * W * H + y * W + 74);
    }
    // The sound: a tone while speaking, heard `lead` seconds before the mouth moves.
    const sound = Buffer.alloc(2 * rate * seconds);
    for (let s = 0; s < rate * seconds; s++) {
      const f = Math.floor((s / rate + lead) * fps);
      sound.writeInt16LE(on[f] ? Math.round(12000 * Math.sin(2 * Math.PI * 220 * s / rate)) : 0, 2 * s);
    }
    const ffmpeg = resolveFfmpeg(), raw = join(dir, "mouth.gray"), file = join(dir, "talking.mp4");
    await writeFile(raw, picture);
    await runCapture(ffmpeg, ["-v", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", String(fps), "-i", raw,
      "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", "pipe:0", "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", "-c:a", "aac", file], { stdin: sound });
    const reading = await lipSyncStretch(file, { start: 1, end: 11 }, { box: [0.3, 0.4, 0.7, 0.95], width: W, height: H, fps, maxShift: 1.5 });
    expect(reading.soundLeads).toBeGreaterThan(lead - 1.5 / fps);
    expect(reading.soundLeads).toBeLessThan(lead + 1.5 / fps);
    expect(reading.match).toBeGreaterThan(reading.matchInSync + 0.3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
