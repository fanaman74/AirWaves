import { describe, expect, it } from "vitest";
import { againstBase, baseRow, judge, partAt, type BoardRow, type Entry } from "../src/ledger.ts";
import type { MediaEvidence } from "../src/metrics.ts";
import type { ReplayResult } from "../src/replay.ts";

const M = "med_a";
const words = ["so", "the", "the", "plan", "works"].map((text, i) => ({ text, start: i, end: i + 0.8 }));
const evidence = new Map([[M, { mediaId: M, words } as unknown as MediaEvidence]]);

/** A replayed part that keeps the recording 0–5 s less `removed`, and stages `staged`. */
function part(removed: Array<[number, number]>, opts: { staged?: Array<[number, number]>; outcome?: ReplayResult["outcome"]; cut?: [number, number] } = {}): ReplayResult {
  const kept: Array<{ start: number; end: number }> = [];
  let at = 0;
  for (const [s, e] of [...removed].sort((a, b) => a[0] - b[0])) { if (s > at) kept.push({ start: at, end: s }); at = e; }
  if (at < 5) kept.push({ start: at, end: 5 });
  const cut = opts.cut ?? removed[0] ?? opts.staged?.[0];
  return {
    outcome: opts.outcome ?? "ready",
    left: { kept: { [M]: kept }, removed: { [M]: removed.map(([start, end]) => ({ start, end })) }, staged: (opts.staged ?? []).map(([start, end]) => ({ mediaId: M, start, end })) },
    cuts: cut ? [{ index: 0, mediaId: M, submitted: { start: cut[0], end: cut[1] }, replay: { tier: "applied", start: cut[0], end: cut[1] } }] : [],
  } as unknown as ReplayResult;
}

describe("judge", () => {
  const plays = { plays: "so the plan works", mediaId: M, start: 0, end: 5 };

  it("reads what the edit plays in the part that decides the spot", () => {
    expect(judge(plays, [part([[1, 2]])], evidence)).toMatchObject({ ok: true });
    expect(judge(plays, [part([[0, 2]])], evidence)).toEqual({ ok: false, detail: 'wrong; plays "the plan works"' });
  });

  it("takes the last part the code saves, leaving one it sends back to the model to the model", () => {
    const sentBack = part([[0, 2]], { outcome: "needsRevision" });
    expect(judge(plays, [part([[1, 2]]), sentBack], evidence).ok).toBe(true);
    expect(judge(plays, [sentBack], evidence)).toEqual({ ok: false, detail: "every request here goes back to the model: only a model pass can show what plays" });
    expect(partAt([part([[1, 2]]), part([[0, 1]])], { mediaId: M, start: 0, end: 5 })?.left.removed[M]).toEqual([{ start: 0, end: 1 }]);
  });

  it("accepts an ask only where it is allowed and approving it plays the right words", () => {
    const asked = [part([], { staged: [[1, 2]] })];
    expect(judge(plays, asked, evidence).ok).toBe(false);
    expect(judge({ ...plays, accept: ["right", "asked"] }, asked, evidence).ok).toBe(true);
    expect(judge({ ...plays, accept: ["right", "asked"] }, [part([], { staged: [[0, 2]] })], evidence).ok).toBe(false);
  });

  it("checks the first request that places an edge near the spot, or every one", () => {
    const edge = { edge: { mediaId: M, near: 2.1, min: 1.95, max: 2.12 } };
    const first = part([], { staged: [[2.05, 4]] }), later = part([[2.3, 4]]);
    expect(judge(edge, [first, later], evidence)).toEqual({ ok: true, detail: "edge at 2.05 staged" });
    expect(judge({ edge: { ...edge.edge, every: true } }, [first, later], evidence)).toEqual({ ok: false, detail: "edge at 2.30 applied (wanted 1.95–2.12)" });
    expect(judge(edge, [part([[3, 4]])], evidence)).toEqual({ ok: false, detail: "no edge placed within 0.3 s of 2.10" });
  });

  it("fails a stretch any part takes out without the editor", () => {
    const spot = { notApplied: { mediaId: M, start: 3, end: 4 } };
    expect(judge(spot, [part([[1, 2]]), part([], { staged: [[3, 4]] })], evidence)).toEqual({ ok: true, detail: "nothing applied there" });
    expect(judge(spot, [part([[3.5, 4.5]])], evidence)).toEqual({ ok: false, detail: "applied without the editor: 3.50–4.50" });
  });
});

describe("the scoreboard", () => {
  const entry = (id: string, status: Entry["status"]): Entry => ({ id, reported: "2026-11-18", said: "…", cause: "placement", status, check: { kind: "none", why: "" } });
  const row = (commit: string, results: Record<string, BoardRow["results"][string]["verdict"]>, dirty: string[] = []): BoardRow => ({
    schema: 1, at: "2026-11-18T10:00:00Z", commit, dirty, results: Object.fromEntries(Object.entries(results).map(([id, verdict]) => [id, { verdict, detail: "" }])),
    passes: { c: { removals: 10, applied: 8, review: 1, notCut: 1, moved: 2, appliedEdges: 16, appliedOnSpeech: 1 } },
  });

  it("compares against the latest clean run this checkout builds on", () => {
    const rows = [row("aaa", {}), row("bbb", {}), row("ccc", {}, ["packages/mcp/src/x.ts"]), row("zzz", {})];
    expect(baseRow(rows, c => c !== "zzz")?.commit).toBe("bbb");
  });

  it("says which entries broke, which now pass, and how far each whole pass moved", () => {
    const lines = againstBase([entry("a", "fixed"), entry("b", "open"), entry("c", "fixed")],
      [{ id: "a", verdict: "fail", detail: "", ms: 0 }, { id: "b", verdict: "pass", detail: "", ms: 0 }, { id: "c", verdict: "pass", detail: "", ms: 0 }],
      { c: { removals: 10, applied: 9, review: 0, notCut: 1, moved: 2, appliedEdges: 18, appliedOnSpeech: 1 } },
      row("abcdef12", { a: "pass", b: "fail" }));
    expect(lines).toEqual([
      "Fixed before and failing now: a.",
      "Against abcdef12 (2026-11-18T10:00):",
      "- broke: a",
      "- now pass: b",
      "- new entries: c",
      "- whole pass c: applied 8→9, review 1→0, appliedEdges 16→18",
    ]);
  });
});
