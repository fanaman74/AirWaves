import { describe, expect, it } from "vitest";
import type { MediaEvidence } from "../src/metrics.ts";
import { agreement, armsMarkdown, removedWords, scoreMoments, spoken, summarizeArm, type LeftEdit, type Moment } from "../src/moments.ts";

const MIC = "med_mic";
// "a time where would <pause> where you would occasionally": a broken first take and the take that replaced it.
const said = ["a", "time", "where", "would", "where", "you", "would", "occasionally"];
const starts = [0, 0.2, 0.4, 0.6, 1.5, 1.7, 1.9, 2.3];
const evidence = new Map<string, MediaEvidence>([[MIC, { mediaId: MIC, duration: 3,
  words: said.map((text, i) => ({ text, start: starts[i]!, end: starts[i]! + 0.18 })) }]]);
const moment: Moment = { id: "where-would", mediaId: MIC, start: 0, end: 3, plays: "A time where you would occasionally." };
const left = (removed: Array<[number, number]>, staged: Array<[number, number]> = []): LeftEdit => {
  const gone = removed.map(([start, end]) => ({ start, end }));
  const kept = [];
  let at = 0;
  for (const r of gone) { kept.push({ start: at, end: r.start }); at = r.end; }
  kept.push({ start: at, end: 3 });
  return { kept: { [MIC]: kept }, removed: { [MIC]: gone }, staged: staged.map(([start, end]) => ({ mediaId: MIC, start, end })) };
};

describe("known moments", () => {
  it("compares words as said", () => {
    expect(spoken("Opus 5.5, at $7.63 — you’ll see.")).toBe("opus 5.5 at 7.63 you'll see");
  });

  it("is right whichever of two matching words the cut took", () => {
    expect(scoreMoments([moment], evidence, left([[0.4, 1.5]]))[0]).toEqual({ id: "where-would", outcome: "right", played: "a time where you would occasionally" });
    expect(scoreMoments([moment], evidence, left([[0.6, 1.7]]))[0]!.outcome).toBe("right");
  });

  it("is wrong when the take that says the line whole is the one removed", () => {
    expect(scoreMoments([moment], evidence, left([[0.8, 2.2]]))[0]).toEqual({ id: "where-would", outcome: "wrong", played: "a time where would occasionally" });
  });

  it("reports a staged cut as asked, with what approving it plays", () => {
    const [asked] = scoreMoments([moment], evidence, left([], [[0.4, 1.5]]));
    expect(asked).toEqual({ id: "where-would", outcome: "asked", played: "a time where would where you would occasionally",
      approved: { played: "a time where you would occasionally", right: true } });
    expect(scoreMoments([moment], evidence, left([], [[0.8, 2.2]]))[0]!.approved!.right).toBe(false);
  });

  it("reports a wrong cut the pass flagged for the editor as asked, and a right one as right", () => {
    const flagged = (removed: Array<[number, number]>) => ({ ...left(removed), flagged: [{ mediaId: MIC, start: 0.4, end: 2.2 }] });
    expect(scoreMoments([moment], evidence, flagged([[0.8, 2.2]]))[0]).toEqual({ id: "where-would", outcome: "asked", played: "a time where would occasionally" });
    expect(scoreMoments([moment], evidence, flagged([[0.4, 1.5]]))[0]!.outcome).toBe("right");
  });

  it("leaves a staged cut elsewhere out of the moment", () => {
    const elsewhere: Moment = { ...moment, id: "start", end: 0.39, plays: "a time" };
    expect(scoreMoments([elsewhere], evidence, left([], [[0.4, 1.5]]))[0]!.outcome).toBe("right");
  });
});

describe("agreement between trials", () => {
  const words = (removed: Array<[number, number]>) => removedWords(evidence, left(removed).removed);

  it("counts the words every trial removed, the ones they split on and the places those fall in", () => {
    // Trial one takes the broken take, trial two the whole one, trial three the broken take and the last word.
    const result = agreement([words([[0.4, 1.5]]), words([[1.5, 2.2]]), words([[0.4, 1.5], [2.2, 3]])]);
    expect(result).toMatchObject({ trials: 3, removedByAll: 0, split: 6, splitPlaces: 1 });
    expect(result.pairF1!.min).toBe(0);
    expect(result.pairF1!.max).toBeCloseTo(0.8);
  });

  it("says how often the reference removed what all trials removed, and what they split on", () => {
    const reference = new Set([`${MIC}:2`, `${MIC}:3`]);
    const result = agreement([words([[0.4, 1.5]]), words([[0.4, 1.5], [2.2, 3]])], reference);
    expect(result).toMatchObject({ removedByAll: 2, split: 1, reference: { ofRemovedByAll: 1, ofSplit: 0 } });
  });

  it("is full agreement for one trial", () => {
    expect(agreement([words([[0.4, 1.5]])])).toMatchObject({ trials: 1, pairF1: null, removedByAll: 2, split: 0, splitPlaces: 0 });
  });
});

describe("an arm's summary", () => {
  it("tallies each moment over the arm's trials and reads results saved before a trial stored what it left", () => {
    const trials = [
      { score: { left: left([[0.4, 1.5]]), headline: { wordF1: 0.8 } } },
      { score: { left: left([[0.8, 2.2]]), headline: { wordF1: 0.9 } } },
      { score: { applied: { cuts: [] }, review: { cuts: [{ mediaId: MIC, start: 0.4, end: 1.5 }] }, headline: { wordF1: 0.7 } } },
    ];
    const arm = summarizeArm("main", trials, [moment], evidence);
    expect(arm.moments).toEqual([{ id: "where-would", right: 1, asked: 1, askedRight: 1, wrong: 1, wrongPlayed: { "a time where would occasionally": 1 } }]);
    expect(arm.headline.wordF1).toMatchObject({ n: 3 });
    expect(arm.headline.wordF1!.mean).toBeCloseTo(0.8);
    const text = armsMarkdown([arm], [moment]);
    expect(text).toContain("| where-would | 1 / 1 (1) / 1 |");
    expect(text).toContain("main · where-would · 1×: “a time where would occasionally”");
  });
});
