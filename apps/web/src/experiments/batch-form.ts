// A batch's sets as the user types them (TASK-176): the lines of an ArduPilot parameter file. A set may not name what the aircraft
// profile itself sets, such as its frame and its motor outputs, because then the runs would not fly one aircraft. Cold path.
import { parseParamFile } from "@mirage/autopilot/param-file";
import type { BatchSet } from "@mirage/project/batch";

export function batchSetOfText(name: string, text: string, profileOwned: ReadonlySet<string>): { readonly set: BatchSet | null; readonly problem: string | null } {
  const trimmed = name.trim();
  if (trimmed === "") return { set: null, problem: "Each set needs a name" };
  try {
    const parameters = parseParamFile(text).map(({ name: parameter, value }) => ({ name: parameter, value })).sort((a, b) => (a.name < b.name ? -1 : 1));
    const owned = parameters.map(parameter => parameter.name).filter(parameter => profileOwned.has(parameter));
    if (owned.length > 0) return { set: null, problem: `${trimmed}: ${owned.join(", ")} ${owned.length === 1 ? "is" : "are"} set by the aircraft profile or the run, not by a parameter set` };
    return { set: { name: trimmed, parameters }, problem: null };
  } catch (cause) {
    return { set: null, problem: `${trimmed}: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}
