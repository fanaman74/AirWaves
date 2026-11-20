/**
 * AirWaves: generate a music track (Google Lyria through the editor's OpenRouter key) and add it to the project's
 * media. Placing it is an ordinary edit: an audio clip on its own track with timeline_propose.
 */
import { z } from "zod/v3";
import type { ScarletClient, ScarletToolName } from "@scarlet/shared";
import { json, type ToolResult } from "./tool-result.js";

type ToolRegistrar = <Shape extends z.ZodRawShape>(name: ScarletToolName, description: string, shape: Shape,
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>) => void;

export const MUSIC_GENERATE_DESCRIPTION =
  "Compose a new music track from a description and add it to the project's media as audio. Uses the editor's OpenRouter key and the music model chosen in Settings → AI providers (Google Lyria by default), and costs the editor about $0.08 a track, so make one track per request unless the editor asks for alternatives. " +
  "Describe genre, mood, instruments, tempo in BPM and structure (e.g. \"calm ambient intro, builds to driving electronic drums at 0:30, 125 BPM, instrumental, no vocals\"); say \"instrumental\" unless the editor wants singing. " +
  "Length can't be set: Lyria Pro returns a whole song of about two minutes or more, so trim or fade the clip to the edit. " +
  "Returns the new mediaId and its duration. The track is NOT in the video until you place it: add a clip of that mediaId on an audio track of its own with timeline_propose (addClip), at the timeline position and length the edit needs, and lower it under any speech. " +
  "Never tell the editor music was made or added unless this tool returned a mediaId and the clip was saved.";

export function registerMusic(deps: { tool: ToolRegistrar; client: ScarletClient; projectId: string }) {
  deps.tool(
    "music_generate",
    MUSIC_GENERATE_DESCRIPTION,
    {
      prompt: z.string().min(3).max(2000).describe("What the music should sound like: genre, mood, instruments, BPM, structure, instrumental or vocals"),
      name: z.string().min(1).max(200).optional().describe("How the media list names the track"),
    },
    async ({ prompt, name }) => {
      const { media, model, text } = await deps.client.generateMusic(deps.projectId, { prompt, ...(name && { name }) });
      return json({
        mediaId: media.id,
        name: media.name,
        duration: media.duration,
        model,
        ...(text && { modelNote: text.slice(0, 500) }),
        next: "Place it with timeline_propose: addClip of this mediaId on its own audio track.",
      });
    },
  );
}
