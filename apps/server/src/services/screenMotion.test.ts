import { describe, expect, it } from "vitest";
import { changedAreas } from "./screenMotion.js";

describe("changedAreas", () => {
  it("makes one area of cells that touch or nearly do, and keeps a lone cell apart, largest first", () => {
    const cols = 10, rows = 6, cells = new Uint8Array(cols * rows);
    for (const [x, y] of [[1, 1], [2, 1], [4, 2], [2, 3], [8, 5]]) cells[y * cols + x] = 1;
    expect(changedAreas(cells, cols, rows)).toEqual([[0.1, 0.167, 0.5, 0.667, 0.067], [0.8, 0.833, 0.9, 1, 0.017]]);
  });
});
