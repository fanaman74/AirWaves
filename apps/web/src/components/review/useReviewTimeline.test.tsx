// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Timeline } from "@scarlet/timeline";
import { api } from "../../lib/client";
import { readTimeline } from "../../lib/timelineCache";
import { useReviewTimeline } from "./useReviewTimeline";

let root: Root;
let container: HTMLDivElement;
/** What the hook said on every render, in order. */
let seen: { version?: string; error?: string; loaded: boolean }[];

function Probe({ version }: { version?: string }) {
  const { timeline, error } = useReviewTimeline("prj", version);
  seen.push({ version, error, loaded: !!timeline });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  seen = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it("doesn't say the next version failed because the last one did", async () => {
  vi.spyOn(api, "timeline").mockImplementation((_project, version) =>
    version === "v_gone" ? Promise.reject(new Error("No such version")) : new Promise(() => {}));
  await act(async () => root.render(<Probe version="v_gone" />));
  expect(seen.at(-1)).toMatchObject({ version: "v_gone", error: "No such version" });

  // The next cut's version is still on its way. No render of it carries the last cut's error: a caller that waits
  // for "loaded or failed" would stop waiting and start playing on the wrong player.
  seen = [];
  await act(async () => root.render(<Probe version="v_next" />));
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter(s => s.version === "v_next" && s.error)).toEqual([]);
});

it("asks again for a version that failed, and drops the error once it loads", async () => {
  const load = vi.spyOn(api, "timeline").mockRejectedValueOnce(new Error("Engine busy"))
    .mockResolvedValue({ timeline: { version: "v_a" } } as Awaited<ReturnType<typeof api.timeline>>);
  let retry = () => {};
  function Retrying() {
    const read = useReviewTimeline("prj", "v_a");
    retry = read.retry;
    seen.push({ version: "v_a", error: read.error, loaded: !!read.timeline });
    return null;
  }
  await act(async () => root.render(<Retrying />));
  expect(seen.at(-1)).toMatchObject({ error: "Engine busy", loaded: false });
  await act(async () => retry());
  expect(load).toHaveBeenCalledTimes(2);
  expect(seen.at(-1)).toMatchObject({ error: undefined, loaded: true });
});

function Known({ version, known }: { version?: string; known?: Timeline | null }) {
  const { timeline } = useReviewTimeline("prj", version, known);
  seen.push({ version, loaded: !!timeline });
  return null;
}

it("keeps a version it had once the caller no longer has it to hand, and reads nothing again", async () => {
  const read = vi.spyOn(api, "timeline").mockImplementation(() => new Promise(() => {}));
  const before = { version: "v_before", tracks: [], markers: [] } as unknown as Timeline;
  await act(async () => root.render(<Known version="v_before" known={before} />));
  // The working cut moved on, as when the editor rejects an edit: the open cut's own version is still the same one.
  await act(async () => root.render(<Known version="v_before" known={{ ...before, version: "v_now" }} />));
  await act(async () => root.render(<Known version="v_before" />));
  expect(seen.every(render => render.loaded)).toBe(true);
  expect(read).not.toHaveBeenCalled();
});

it("shows a version that was read already in its first render, with no moment without it", async () => {
  const next = { version: "v_next", tracks: [], markers: [] } as unknown as Timeline;
  vi.spyOn(api, "timeline").mockResolvedValue({ timeline: next });
  // Read ahead, as the card does before it goes on to the next cut.
  await readTimeline("prj", "v_next");
  await act(async () => root.render(<Known version="v_before" known={{ ...next, version: "v_before" }} />));
  seen = [];
  await act(async () => root.render(<Known version="v_next" />));
  expect(seen.map(render => render.loaded)).not.toContain(false);
});
