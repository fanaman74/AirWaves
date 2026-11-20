/** Regrade completed trial manifests from their saved tasks and an original local SQLite library. No engine or agent. */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import type { Change, Timeline } from "../../packages/timeline/src/index.ts";
import { wordDigest } from "../../packages/mcp/src/transcript-digest.ts";
import { isMain, main } from "./args.ts";
import { loadCase } from "./case.ts";
import { evaluateCaseOrigin, type Evaluation } from "./evaluate.ts";
import type { TaskRecord } from "./engine.ts";
import type { EventLike } from "./metrics.ts";
import { checkedPath, readJson, writeJson } from "./paths.ts";
import { eligibleTrials } from "./scorecard.ts";
import type { TrialRow } from "./report.ts";

async function rescore(run: string, database: string, output: string) {
  if (existsSync(output)) throw new Error("Use a new output directory; the saved run must stay unchanged.");
  const rows = readJson<TrialRow[]>(checkedPath(run, join(run, "trials.json")));
  const entries = eligibleTrials(run);
  if (!entries.length) throw new Error("No eligible trials.");
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec("BEGIN");
    const changeById = db.prepare("select json from changes where project_id=? and id=?");
    const versionById = db.prepare("select json from timeline_versions where project_id=? and version=?");
    for (const { file, row } of entries) {
      const old = readJson<Evaluation>(file), dir = dirname(file), loaded = loadCase(row.caseId);
      const saved = readJson<{task: TaskRecord; events: EventLike[]}>(checkedPath(run, join(dir, "task.json")));
      if (saved.task.state !== "done" || old.taskId !== row.taskId || old.caseId !== row.caseId || saved.task.id !== row.taskId || old.projectId !== saved.task.projectId || old.projectId !== loaded.file.projectId) throw new Error("Task or case identity mismatch");
      const transcripts = readJson<{before: {mediaId: string; frozenSha256: string; sha256: string}[]; mismatchedMedia: string[]}>(checkedPath(run, join(dir, "transcripts.json")));
      if (transcripts.mismatchedMedia.length || !loaded.file.dialogueMedia.every(id => {
        const before = transcripts.before.find(item => item.mediaId === id), words = loaded.evidence.get(id)?.words;
        return before && words?.length && before.frozenSha256 === before.sha256 && wordDigest(words) === before.sha256;
      })) throw new Error("Frozen transcript mismatch");
      const changes = saved.task.changeIds.map(id => {
        const json = changeById.get(old.projectId, id)?.json;
        if (typeof json !== "string") throw new Error("Missing change " + id);
        return JSON.parse(json) as Change;
      });
      const result = await evaluateCaseOrigin({ ...loaded, origin: () => ({ ...saved, task: { ...saved.task, usage: old.score.trace?.usage }, changes }),
        timeline: version => {
          const json = versionById.get(old.projectId, version)?.json;
          return typeof json === "string" ? JSON.parse(json) as Timeline : loaded.timeline(version);
        } }, { edgeOptions: old.edgeOptions });
      for (const key of ["versions", "left", "review", "applied"] as const) {
        if (!isDeepStrictEqual(JSON.parse(JSON.stringify(result.score[key])), old.score[key])) throw new Error(`Reconstructed ${key} differs from the saved trial ${row.taskId}.`);
      }
      if (!isDeepStrictEqual(result.score.reference?.published, old.score.reference?.published) ||
        !isDeepStrictEqual(result.score.reference?.operatingPoints.applied.cut, old.score.reference?.operatingPoints.applied.cut)) throw new Error("Reference does not reproduce the saved applied score.");
      writeJson(join(output, relative(run, file)), { ...result, originalEvaluationSha256: createHash("sha256").update(readFileSync(file)).digest("hex") }, output);
      rows.find(item => item.taskId === row.taskId)!.headline = result.score.headline;
    }
    writeJson(join(output, "trials.json"), rows, output);
  } finally { db.close(); }
}

if (isMain(import.meta.url)) void main(async () => {
  const args = process.argv.slice(2);
  if (args.length !== 3) throw new Error("Usage: rescore.ts ORIGINAL_RUN ORIGINAL_SCARLET_DB NEW_OUTPUT_DIR");
  await rescore(resolve(args[0]!), resolve(args[1]!), resolve(args[2]!));
});
