import { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * dialogue_apply_cuts asks for a summary on every cut and review. Tests about other things send cuts without one; this
 * fills one in where a cut leaves the key out entirely, so a test can still send a cut with no summary on purpose by
 * giving the key as undefined.
 */
const callTool = Client.prototype.callTool;
Client.prototype.callTool = function (params, ...rest) {
  const cuts = params.name === "dialogue_apply_cuts" && params.arguments?.cuts;
  if (Array.isArray(cuts)) {
    params = { ...params, arguments: { ...params.arguments, cuts: cuts.map((cut: Record<string, unknown>) =>
      cut && typeof cut === "object" && !("summary" in cut) && cut.decision !== "keep" ? { ...cut, summary: `Cut the ${String(cut.kind ?? "passage")}.` } : cut) } };
  }
  return callTool.call(this, params, ...rest);
};
