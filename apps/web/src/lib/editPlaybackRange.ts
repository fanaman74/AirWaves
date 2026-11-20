import { CUT_LEAD_SECONDS, CUT_TAIL_SECONDS, type TimeRange } from "@scarlet/timeline";

/**
 * An edit plays with the same lead-in and tail as a cut's listen, so every edit, cut or not, is heard coming in and
 * going out the same way.
 */
export function editPlaybackRange(range: TimeRange, duration: number): TimeRange {
  if (duration <= 0) return range;
  return { start: Math.max(0, range.start - CUT_LEAD_SECONDS), end: Math.min(duration, range.end + CUT_TAIL_SECONDS) };
}
