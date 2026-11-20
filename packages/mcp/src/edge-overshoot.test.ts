import { describe, expect, it } from "vitest";
import { edgeOvershoots } from "./edge-overshoot.js";

const w = (s: string) => s.split(" ");

describe("edgeOvershoots", () => {
  it("names the end of a kept phrase that a restart cut took with it", () => {
    // “absolutely beautiful. The detail, the, the detail” with “beautiful.” taken along with the restart.
    expect(edgeOvershoots(w("and I just think this is absolutely"), w("beautiful. The detail, the, the"), w("detail, the spatial awareness, it's 3D")))
      .toEqual([{ side: "out", words: "beautiful." }]);
  });

  it("passes the restart cut that keeps the phrase whole", () => {
    expect(edgeOvershoots(w("I just think this is absolutely beautiful."), w("The detail, the,"), w("the detail, the spatial awareness"))).toEqual([]);
    expect(edgeOvershoots(w("this is absolutely beautiful. The detail,"), w("the, the detail,"), w("the spatial awareness, it's 3D"))).toEqual([]);
  });

  it("names the start of the take a restart cut resumes with", () => {
    expect(edgeOvershoots(w("this test combines a few different capabilities,"), w("including 3D, including its"), w("ability to generate 3D models, spatial")))
      .toEqual(expect.arrayContaining([{ side: "in", words: "including its" }]));
  });

  it("passes the abandoned end of a first attempt, which the second never says", () => {
    expect(edgeOvershoots([], w("the first thing I wanted to test is for"), w("the first thing I wanted to show you"))).toEqual([]);
  });

  it("passes an aside taken out whole", () => {
    expect(edgeOvershoots(w("it's going to be very fast"), w("but it is surprisingly fast so what we're going to do"), w("I'm going to turn off reasoning")))
      .toEqual([]);
  });

  it("passes a hesitation at the edge and a phrase that closed its sentence", () => {
    expect(edgeOvershoots(w("here's a bunch of other models"), w("um here's"), w("here's Opus 5, Fable 5"))).toEqual([]);
    expect(edgeOvershoots(w("this is absolutely beautiful."), w("Wow. The detail, the, the"), w("detail, the spatial awareness"))).toEqual([]);
  });
});
