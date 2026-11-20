import { useEffect, useRef, useState } from "react";
import type { Timeline } from "@scarlet/timeline";
import { errorMessage } from "../../lib/client";
import { readTimeline, readyTimeline } from "../../lib/timelineCache";

export function useReviewTimeline(projectId: string, version?: string, known?: Timeline | null) {
  const [saved, setSaved] = useState<Timeline>();
  // Why a version couldn't be read, with the version it is about: the next one asked for hasn't failed, and a caller
  // that waits until a version is in or has failed must go on waiting for it.
  const [failed, setFailed] = useState<{ projectId: string; version: string; error: string }>();
  const [attempt, setAttempt] = useState(0);
  // A version never changes, so one read once stays read. `known` is whatever the caller has to hand, and goes when the
  // working cut moves on or a cut prepared ahead is let go: asking again then left a moment with no timeline, in which
  // an open cut's card went back to the video and came up again, the timeline's scale jumping both ways.
  const had = useRef<{ projectId: string; timeline: Timeline }>(undefined);
  const kept = had.current?.projectId === projectId && had.current.timeline.version === version ? had.current.timeline : undefined;
  const timeline = version ? kept ?? [known, saved].find(t => t?.version === version) ?? readyTimeline(projectId, version) : undefined;
  if (timeline && timeline !== kept) had.current = { projectId, timeline };
  useEffect(() => {
    if (!version || timeline) return;
    let live = true;
    setFailed(undefined);
    readTimeline(projectId, version).then(
      timeline => { if (live) setSaved(timeline); },
      e => { if (live) setFailed({ projectId, version, error: errorMessage(e) }); },
    );
    return () => { live = false; };
  }, [projectId, version, timeline, attempt]);
  const error = failed && failed.projectId === projectId && failed.version === version ? failed.error : undefined;
  return { timeline, error: version && !timeline ? error : undefined, retry: () => setAttempt(n => n + 1) };
}
