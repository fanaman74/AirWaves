import { describe, expect, it } from "vitest";
import { lipSyncStretches, mouthOf } from "./lipSync.js";

describe("lipSyncStretches", () => {
  it("spreads the stretches evenly across a long recording", () => {
    expect(lipSyncStretches(0, 600, 3, 30)).toEqual([{ from: 85, to: 115 }, { from: 285, to: 315 }, { from: 485, to: 515 }]);
  });

  it("splits a range shorter than all the stretches into stretches that cover it", () => {
    expect(lipSyncStretches(10, 70, 6, 30)).toEqual([{ from: 10, to: 40 }, { from: 40, to: 70 }]);
    expect(lipSyncStretches(0, 12, 6, 30)).toEqual([{ from: 0, to: 12 }]);
    expect(lipSyncStretches(5, 5)).toEqual([]);
  });
});

describe("mouthOf", () => {
  type Box = [number, number, number, number];
  const frames = (from: number, to: number, ...faces: Array<{ box: Box; yaw?: number }>) =>
    Array.from({ length: (to - from) * 2 }, (_, i) => ({ at: from + i / 2,
      faces: faces.map(f => [...f.box, 0.9, f.yaw ?? 0, 0.5, 0.3] as [number, number, number, number, number, number, number, number]) }));

  it("measures the face in frame most often, at the lower third of its usual box", () => {
    const face = mouthOf([
      ...frames(0, 20, { box: [0.4, 0.2, 0.6, 0.6] }, { box: [0.05, 0.05, 0.1, 0.1] }),
      ...frames(20, 30, { box: [0.42, 0.2, 0.62, 0.6], yaw: 20 }),
    ], 0, 30)!;
    expect(face.seconds).toBe(30);
    expect(face.yaw).toBe(0);
    expect(face.mouth).toEqual([0.43, 0.448, 0.57, 0.632]);
  });

  it("counts only the frames inside the stretch, and finds nothing without a face", () => {
    const face = mouthOf([...frames(0, 50, { box: [0.4, 0.2, 0.6, 0.6] }), ...frames(50, 100)], 40, 70)!;
    expect(face.seconds).toBe(10);
    expect(mouthOf(frames(0, 30), 0, 30)).toBeUndefined();
  });
});
