import { z } from "zod/v3";

/**
 * The editor's setting for how much Scarlet checks with them. Scarlet orders the cuts of a pass that took words out
 * from the most likely to be wrong to the least; this says how far down that order the editor is asked to look. The
 * order is Scarlet's and the amount is the editor's: nothing here judges a cut.
 */
export const CheckIn = z.enum(["less", "balanced", "more"]);
export type CheckIn = z.infer<typeof CheckIn>;

/** How much of that order each step brings the editor, in the words the prompt and Settings both use. */
export const CHECK_IN_SHARE: Record<CheckIn, string> = { less: "about one in ten", balanced: "about one in four", more: "about half" };
