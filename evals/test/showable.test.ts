import { describe, expect, it } from "vitest";
import type { MediaClip, Timeline } from "../../packages/timeline/src/index.ts";
import { edgeFit, holdsOf, labelFor, scoreShowable, type Area, type ShowableFile } from "../src/showable.ts";
import type { Gray } from "../src/picture.ts";

const W = 320, H = 180;
/** A dark desktop with one lighter window on it. */
function desktop(window: Area): Gray {
  const data = new Float32Array(W * H).fill(20);
  for (let y = Math.round(window.top * H); y < Math.round(window.bottom * H); y++) for (let x = Math.round(window.left * W); x < Math.round(window.right * W); x++) data[y * W + x] = 90;
  return { width: W, height: H, data };
}
const box: Area = { left: 0.1, top: 0.1, right: 0.8, bottom: 0.9 };

describe("a confirmed box on a frame", () => {
  it("holds while the window stays and stops when it moves", () => {
    expect(edgeFit(desktop(box), box)).toBeGreaterThan(0.9);
    expect(edgeFit(desktop({ ...box, right: 0.7 }), box)).toBeLessThan(0.5);
  });
  it("needs no line for an edge on the frame's own edge or one marked soft", () => {
    const cutOff: Area = { left: 0, top: 0.1, right: 0.8, bottom: 0.9 };
    expect(edgeFit(desktop(cutOff), cutOff)).toBeGreaterThan(0.9);
    expect(edgeFit(desktop({ ...box, bottom: 1 }), box, ["bottom"])).toBeGreaterThan(0.9);
  });
  it("picks the label that fits, and joins frames into stretches", () => {
    const labels = [{ at: 10, area: box }, { at: 50, area: { ...box, right: 0.6 } }];
    expect(labelFor(desktop(box), 40, labels)?.at).toBe(10);
    expect(labelFor(desktop({ ...box, right: 0.6 }), 12, labels)?.at).toBe(50);
    expect(labelFor(desktop({ left: 0.3, top: 0.3, right: 0.5, bottom: 0.5 }), 12, labels)).toBeUndefined();
    expect(holdsOf([{ second: 2.5, label: 10 }, { second: 7.5, label: 10 }, { second: 12.5 }, { second: 17.5, label: 50 }], 5))
      .toEqual([{ from: 0, to: 10, label: 10 }, { from: 15, to: 20, label: 50 }]);
  });
});

describe("scoring a cut against the boxes", () => {
  const screen = (timelineIn: number, sourceIn: number, length: number, transform: Partial<MediaClip["transform"]>): MediaClip =>
    ({ id: `c${timelineIn}`, kind: "media", mediaId: "screen", timelineIn, sourceIn, sourceOut: sourceIn + length, transform }) as MediaClip;
  const timeline = (clips: MediaClip[]): Timeline => ({ tracks: [{ id: "v1", kind: "video", clips }] }) as unknown as Timeline;
  const file: ShowableFile = { schema: 1, recording: "screen", labels: [{ at: 10, area: box }], holds: [{ from: 0, to: 30, label: 10 }] };

  it("passes a clip cropped to the box and fails one that shows the whole desktop", () => {
    const inside = screen(0, 0, 10, { cropLeft: 0.1, cropTop: 0.1, cropRight: 0.2, cropBottom: 0.1 });
    const whole = screen(10, 10, 10, {});
    const score = scoreShowable(timeline([inside, whole]), file);
    expect(score.screenSeconds).toBe(20);
    expect(score.labelledSeconds).toBe(20);
    expect(score.outsideSeconds).toBe(10);
    expect(score.outsideShare).toBe(0.5);
    expect(score.farOutsideShare).toBe(0.5);
    expect(score.bySide).toEqual({ left: 10, top: 10, right: 10, bottom: 10 });
    expect(score.worst).toHaveLength(1);
    expect(score.worst[0]).toMatchObject({ side: "right", over: 0.2 });
  });
  it("leaves out screen time no box holds for", () => {
    const score = scoreShowable(timeline([screen(0, 40, 10, {})]), file);
    expect(score).toMatchObject({ screenSeconds: 10, labelledSeconds: 0, outsideShare: null });
  });
  it("reads a punch-in as inside when the zoom stays in the box", () => {
    const score = scoreShowable(timeline([screen(0, 0, 10, { scale: 2, x: 0.05 })]), file);
    expect(score.outsideSeconds).toBe(0);
  });
});
