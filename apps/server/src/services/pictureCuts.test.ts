import { describe, expect, it } from "vitest";
import { cutsIn } from "./pictureCuts.js";

const cols = 8, rows = 4, cells = cols * rows;
/** Frames 1/30 s apart whose cells are `grey(frame, cell)`. */
function frames(count: number, grey: (frame: number, cell: number) => number, size = cells) {
  const greys = Array.from({ length: count }, (_, f) => Float32Array.from({ length: size }, (_, c) => grey(f, c)));
  return { greys, times: greys.map((_, f) => 10 + f / 30) };
}
const bits = (cut: { cells: string }) => [...Buffer.from(cut.cells, "base64")].flatMap(b => Array.from({ length: 8 }, (_, i) => (b >> i) & 1)).slice(0, cells);

describe("cutsIn", () => {
  it("finds a switch to another window: much of the picture changes at once and holds either side", () => {
    // The left half switches from dark to light at frame 10.
    const { greys, times } = frames(20, (f, c) => c % cols < cols / 2 && f >= 10 ? 200 : 20);
    const cuts = cutsIn(greys, times, cols, rows);
    expect(cuts.map(c => [c.at, c.share])).toEqual([[10.333, 0.5]]);
    expect(bits(cuts[0]!)).toEqual(Array.from({ length: cells }, (_, c) => c % cols < cols / 2 ? 1 : 0));
  });

  it("counts a picture drawn over two frames once", () => {
    const { greys, times } = frames(20, (f, c) => f >= 11 || (f === 10 && c < cells / 2) ? 200 : 20);
    expect(cutsIn(greys, times, cols, rows).map(c => [c.at, c.share])).toEqual([[10.333, 1]]);
  });

  it("finds nothing in a page that scrolls or a game that plays: its cells keep changing", () => {
    const scroll = frames(30, (f, c) => ((Math.floor(c / cols) + f) % 2) * 120 + 40);
    expect(cutsIn(scroll.greys, scroll.times, cols, rows)).toEqual([]);
    // A picture that updates every other frame keeps changing too.
    const choppy = frames(30, (f, c) => ((Math.floor(c / cols) + Math.floor(f / 2)) % 2) * 120 + 40);
    expect(cutsIn(choppy.greys, choppy.times, cols, rows)).toEqual([]);
  });

  it("leaves out a change too small to be more than a pointer, and a change too faint to see", () => {
    // One cell of 64 by 36 is the size of a pointer.
    const pointer = frames(20, (f, c) => c === 300 && f >= 10 ? 200 : 20, 64 * 36);
    expect(cutsIn(pointer.greys, pointer.times, 64, 36)).toEqual([]);
    const faint = frames(20, (f) => f >= 10 ? 25 : 20);
    expect(cutsIn(faint.greys, faint.times, cols, rows)).toEqual([]);
  });
});
