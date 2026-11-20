import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createProject, NO_CAPTION_TRACK, NO_CAPTIONS_IN_RANGE, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-caption-export-test-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  project = workspace.ctx.repos.projects.insert(createProject("Weekly interview"));
});
afterEach(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

async function api(method: string, path: string, body?: unknown) {
  const res = await workspace.app.request("/api" + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, ...(body !== undefined && { "Content-Type": "application/json" }) } });
  const text = await res.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, json, text, headers: res.headers };
}

const captions = [
  { op: "addTrack" as const, track: { id: "cap", kind: "caption" as const, name: "Captions" } },
  { op: "addClip" as const, trackId: "cap", clip: { id: "c1", kind: "caption" as const, timelineIn: 0.2, timelineOut: 2.4, text: "Welcome back", enabled: true } },
  { op: "addClip" as const, trackId: "cap", clip: { id: "c2", kind: "caption" as const, timelineIn: 5.6, timelineOut: 7.6, text: "Three things today", enabled: true } },
];

async function addCaptions(ops = captions) {
  const posted = await api("POST", `/projects/${project.id}/changes`, { description: "Add captions", skipRender: true, autoApprove: true, ops });
  expect(posted.status).toBe(201);
  return posted;
}

it("exports SubRip and WebVTT for the first caption track, named after the project", async () => {
  await addCaptions();
  const srt = await api("GET", `/projects/${project.id}/versions/head/export.srt`);
  expect(srt.status).toBe(200);
  expect(srt.headers.get("content-type")).toContain("application/x-subrip");
  expect(srt.headers.get("content-disposition")).toMatch(/attachment; filename="Weekly_interview-[0-9a-f]{16}\.srt"/);
  expect(srt.text).toContain("00:00:00,200 --> 00:00:02,400");
  expect(srt.text).toContain("Welcome back");
  expect(srt.text).toContain("00:00:07,600");
  expect(srt.text).not.toContain("WEBVTT");

  const vtt = await api("GET", `/projects/${project.id}/versions/head/export.vtt`);
  expect(vtt.status).toBe(200);
  expect(vtt.headers.get("content-type")).toContain("text/vtt");
  expect(vtt.headers.get("content-disposition")).toMatch(/\.vtt"/);
  expect(vtt.text.startsWith("WEBVTT\n")).toBe(true);
  expect(vtt.text).toContain("00:00:00.200 --> 00:00:02.400");
  expect(vtt.text).toContain("00:00:05.600 --> 00:00:07.600");
});

it("shifts a range so 0 is the range start, and answers 404 when there is no caption track", async () => {
  const missing = await api("GET", `/projects/${project.id}/versions/head/export.srt`);
  expect(missing.status).toBe(404);
  expect(missing.json).toMatchObject({ error: { code: "no_caption_track", message: NO_CAPTION_TRACK } });

  await addCaptions();
  const ranged = await api("GET", `/projects/${project.id}/versions/head/export.srt?start=1&end=6`);
  expect(ranged.status).toBe(200);
  expect(ranged.text).toContain("00:00:00,000 --> 00:00:01,400");
  expect(ranged.text).toContain("00:00:04,600 --> 00:00:05,000");
  expect(ranged.text).not.toContain("00:00:05,600");

  const named = await api("GET", `/projects/${project.id}/versions/head/export.vtt?trackId=cap`);
  expect(named.status).toBe(200);
  expect(named.text).toContain("Welcome back");

  const gone = await api("GET", `/projects/${project.id}/versions/head/export.srt?trackId=missing`);
  expect(gone.status).toBe(404);
  expect(gone.json).toMatchObject({ error: { code: "track_not_found", message: "That caption track isn’t in this version." } });
  const video = await api("GET", `/projects/${project.id}/versions/head/export.srt?trackId=v1`);
  expect(video.status).toBe(400);
  expect(video.json).toMatchObject({ error: { code: "not_caption_track" } });

  const beforeZero = await api("GET", `/projects/${project.id}/versions/head/export.srt?start=-1&end=6`);
  expect(beforeZero.status).toBe(400);
  expect(beforeZero.json).toMatchObject({ error: { code: "bad_range", message: "Range start must be at least 0." } });
  for (const format of ["srt", "vtt"]) {
    const backwards = await api("GET", `/projects/${project.id}/versions/head/export.${format}?start=5&end=4`);
    expect(backwards.status).toBe(400);
    expect(backwards.json).toMatchObject({ error: { code: "bad_range", message: "Range end must be after its start." } });
  }

  const missed = await api("GET", `/projects/${project.id}/versions/head/export.vtt?start=20&end=21`);
  expect(missed.status).toBe(400);
  expect(missed.json).toMatchObject({ error: { code: "no_captions_in_range", message: NO_CAPTIONS_IN_RANGE } });
});

it("refuses an empty caption track or a range with no cues, and 404 when every caption track is hidden or a hidden one is asked for", async () => {
  await addCaptions([{ op: "addTrack", track: { id: "cap", kind: "caption", name: "Captions" } }]);
  const empty = await api("GET", `/projects/${project.id}/versions/head/export.srt`);
  expect(empty.status).toBe(400);
  expect(empty.json).toMatchObject({ error: { code: "no_captions_in_range", message: NO_CAPTIONS_IN_RANGE } });
  const emptyVtt = await api("GET", `/projects/${project.id}/versions/head/export.vtt`);
  expect(emptyVtt.status).toBe(400);
  expect(emptyVtt.json).toMatchObject({ error: { code: "no_captions_in_range", message: NO_CAPTIONS_IN_RANGE } });

  const hidden = createProject("Hidden captions");
  workspace.ctx.repos.projects.insert(hidden);
  const posted = await api("POST", `/projects/${hidden.id}/changes`, {
    description: "Hide captions", skipRender: true, autoApprove: true,
    ops: [
      { op: "addTrack", track: { id: "cap", kind: "caption", name: "Captions", hidden: true } },
      { op: "addClip", trackId: "cap", clip: { id: "c1", kind: "caption", timelineIn: 0, timelineOut: 1, text: "Hi", enabled: true } },
    ],
  });
  expect(posted.status).toBe(201);
  const refused = await api("GET", `/projects/${hidden.id}/versions/head/export.srt`);
  expect(refused.status).toBe(404);
  expect(refused.json).toMatchObject({ error: { code: "no_caption_track" } });
  for (const format of ["srt", "vtt"]) {
    const byId = await api("GET", `/projects/${hidden.id}/versions/head/export.${format}?trackId=cap`);
    expect(byId.status).toBe(404);
    expect(byId.json).toMatchObject({ error: { code: "track_hidden" } });
  }
});
