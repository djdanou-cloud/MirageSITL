// ArduPilot parameter files (TASK-161, S11). A file the user loads by hand
// into a ground station or SITL: `#` comment lines with the export's context,
// then one `NAME,VALUE` line per parameter, sorted by name. Each value is the
// shortest decimal that reads back to exactly its float32
// (formatParameterValue), so ArduPilot's own loader (AP_Param.cpp
// parse_param_line, at 8ab6afde: `#` comments, separators ", =\t") gets the
// same float32. MirageSITL writes these files for download only; it never
// writes one to a flight controller. Cold path.
import { formatParameterValue, parseParameterValue } from "./param-service.ts";

/** An ArduPilot parameter name: 1 to 16 printable ASCII characters without a space or separator (AP_MAX_NAME_SIZE). */
const PARAMETER_NAME = /^[\x21-\x7e]{1,16}$/;
const SEPARATORS = /[, =\t]+/;

export interface ParameterEntry { readonly name: string; readonly value: number }
/** Where an exported value comes from. */
export type ValueSource =
  /** The running SITL's read-back (TASK-159): only values ArduPilot reported. */
  | "sitl"
  /** An experiment record's parameters, which MirageSITL generated from the saved profile at its start. */
  | "experiment"
  /** A stored parameter set (TASK-160), itself the read-back of the run it names. */
  | "set";
export interface ExportCandidate extends ParameterEntry {
  readonly source: ValueSource;
  /** What else the preview says about this value, or null. */
  readonly note: string | null;
}
export type ExportSelection =
  | { readonly kind: "all" }
  /** Parameters whose value differs from the baseline's, or that the baseline does not hold. */
  | { readonly kind: "changes"; readonly baseline: readonly ParameterEntry[] }
  /** The named parameters and every parameter of the named groups (groupOf). */
  | { readonly kind: "chosen"; readonly names: readonly string[]; readonly groups: readonly string[] };

/** A parameter's group: its name up to the first underscore, as ArduPilot prefixes a library's parameters (RTL_ALT_M is in RTL). */
export function groupOf(name: string): string {
  const cut = name.indexOf("_");
  return cut <= 0 ? name : name.slice(0, cut);
}

/** The candidates a selection exports, sorted by name. */
export function selectParameters(candidates: readonly ExportCandidate[], selection: ExportSelection): ExportCandidate[] {
  const sorted = [...candidates].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  switch (selection.kind) {
    case "all": return sorted;
    case "changes": {
      const baseline = new Map(selection.baseline.map(entry => [entry.name, entry.value]));
      return sorted.filter(entry => baseline.get(entry.name) !== entry.value);
    }
    case "chosen": {
      const names = new Set(selection.names), groups = new Set(selection.groups);
      return sorted.filter(entry => names.has(entry.name) || groups.has(groupOf(entry.name)));
    }
    default: { const never: never = selection; return never; }
  }
}

/** The context written as comment lines at the top of a file. */
export interface ParamFileContext {
  readonly exportedAt: string;
  /** What the values are, for example "the running SITL's read-back". */
  readonly source: string;
  /** Which parameters, for example "all 1410 parameters" or "changes against set X". */
  readonly selection: string;
  readonly aircraft: { readonly name: string; readonly version: number; readonly sha256: string } | null;
  readonly firmware: { readonly version: string | null; readonly commit: string } | null;
  readonly experiment: { readonly id: string; readonly sha256: string } | null;
}

/** One comment line; control characters, which would end a comment early, become spaces. */
function comment(text: string): string {
  return `# ${text.replace(/[\x00-\x1f\x7f]/g, " ")}`;
}

/** The file's text: the context as comments, then `NAME,VALUE` lines by name. Throws for an invalid name, a duplicate or a value that is not a finite float32. */
export function formatParamFile(context: ParamFileContext, entries: readonly ParameterEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const lines = [
    comment("ArduPilot parameter file exported by MirageSITL for loading by hand; MirageSITL never writes it to a flight controller."),
    comment(`Exported: ${context.exportedAt}`),
    comment(`Values: ${context.source}`),
    comment(`Selection: ${context.selection}`),
    comment(context.aircraft ? `Aircraft profile: ${context.aircraft.name}, version ${context.aircraft.version}, ${context.aircraft.sha256}` : "Aircraft profile: none"),
    comment(context.firmware ? `ArduPilot: ${context.firmware.version ?? "version not reported"}, commit ${context.firmware.commit}` : "ArduPilot: not known"),
    comment(context.experiment ? `Experiment: ${context.experiment.id}, record ${context.experiment.sha256}` : "Experiment: none"),
    comment(`Parameters: ${sorted.length}`),
  ];
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    if (!entry) continue;
    if (!PARAMETER_NAME.test(entry.name) || SEPARATORS.test(entry.name) || entry.name.startsWith("#")) throw new Error(`"${entry.name}" is not an ArduPilot parameter name`);
    if (i > 0 && sorted[i - 1]?.name === entry.name) throw new Error(`${entry.name} is listed twice`);
    lines.push(`${entry.name},${formatParameterValue(entry.value)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The entries of a parameter file, read as ArduPilot's loader reads them:
 * comment and blank lines are skipped, and a line is a name and a value
 * separated by commas, spaces, tabs or `=`. Unlike that loader, which skips
 * what it cannot read, this throws with the line number of the first line it
 * cannot read, a duplicate name or a value that is not a finite float32.
 */
export function parseParamFile(text: string): ParameterEntry[] {
  const entries: ParameterEntry[] = [], seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const fields = line.split(SEPARATORS);
    const [name, valueText] = fields;
    if (fields.length !== 2 || name === undefined || valueText === undefined || !PARAMETER_NAME.test(name)) throw new Error(`Line ${index + 1} is not NAME,VALUE`);
    const value = parseParameterValue(valueText);
    if (value === null) throw new Error(`Line ${index + 1}: "${valueText}" is not a finite number`);
    if (seen.has(name)) throw new Error(`Line ${index + 1}: ${name} is listed twice`);
    seen.add(name);
    entries.push({ name, value });
  });
  return entries;
}
