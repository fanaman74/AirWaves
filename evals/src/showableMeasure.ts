/**
 * Label a screen recording from its confirmed boxes, and score a cut against them.
 * Reads the recording once with ffmpeg, read-only, one small frame every few seconds.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Timeline } from "../../packages/timeline/src/index.ts";
import { cli, isMain, main } from "./args.ts";
import { ffmpegPath } from "./evidence.ts";
import { readJson, writeChosenJson } from "./paths.ts";
import { holdsOf, labelFor, scoreShowable, type Hold, type ShowableFile, type ShowableLabel } from "./showable.ts";

const WIDTH = 960, HEIGHT = 540;

/** The stretches of a recording each confirmed box holds for, from one frame every `every` seconds. */
export async function measureHolds(recording: string, labels: readonly ShowableLabel[], every = 5): Promise<Hold[]> {
  const frames: Array<{ second: number; label?: number }> = [];
  const size = WIDTH * HEIGHT;
  let carry: Buffer = Buffer.alloc(0);
  const take = (chunk: Buffer) => {
    carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    while (carry.length >= size) {
      const second = frames.length * every + every / 2;
      frames.push({ second, label: labelFor({ width: WIDTH, height: HEIGHT, data: Float32Array.from(carry.subarray(0, size)) }, second, labels)?.at });
      carry = carry.subarray(size);
    }
  };
  await new Promise<void>((done, fail) => {
    const child = spawn(ffmpegPath(), ["-v", "error", "-nostdin", "-i", recording, "-an", "-vf", `fps=1/${every},scale=${WIDTH}:${HEIGHT}:flags=area,format=gray`, "-f", "rawvideo", "-"],
      { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", take);
    child.on("error", fail);
    child.on("close", code => code === 0 ? done() : fail(new Error(`ffmpeg left with ${code} reading ${recording}`)));
  });
  return holdsOf(frames, every);
}

const USAGE = `Usage:
  tsx evals/src/showableMeasure.ts --labels <showable.json> --recording <file>   measure where each box holds; writes holds into the labels file
  tsx evals/src/showableMeasure.ts --labels <showable.json> --timeline <json>    score a saved timeline version

The labels file is the editor's: {"schema":1,"recording":"<media id>","labels":[{"at":<second>,"area":{"left":0.08,"top":0.1,"right":0.84,"bottom":0.89}}]}.
Keep it with the case, outside the repository.`;

if (isMain(import.meta.url)) await main(async () => {
  const { values } = cli({ labels: { type: "string" }, recording: { type: "string" }, timeline: { type: "string" }, every: { type: "string" } }, USAGE);
  if (!values.labels || (!values.recording && !values.timeline)) throw new Error(USAGE);
  const file = readJson<ShowableFile>(resolve(values.labels));
  if (values.recording) {
    file.holds = await measureHolds(resolve(values.recording), file.labels, values.every ? Number(values.every) : 5);
    writeChosenJson(resolve(values.labels), file, values.labels);
    const held = file.holds.reduce((n, h) => n + h.to - h.from, 0);
    console.log(`${file.labels.length} boxes hold for ${Math.round(held)} s in ${file.holds.length} stretches.`);
  }
  if (values.timeline) {
    if (!file.holds) throw new Error("Measure the recording first: --recording <file>.");
    console.log(JSON.stringify(scoreShowable(readJson<Timeline>(resolve(values.timeline)), file), null, 1));
  }
});
