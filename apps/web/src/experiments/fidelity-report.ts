import { readDataFlash } from "@mirage/dataflash/reader";
import { assessFidelity, logOrigin, type FidelityAssessment, type FidelityInterval } from "@mirage/analysis/fidelity";
import { validateFidelityComparison, type FidelityComparison } from "@mirage/aircraft/fidelity-comparison";

// The fidelity report's arithmetic (TASK-184): two DataFlash logs, the real one and the simulated run's, read, compared over the real
// log's interval and kept as a comparison record of the run's profile version. Nothing is judged. Cold path, on a user's request.

export interface ReportLog { readonly name: string; readonly bytes: Uint8Array }
export interface ReportInput {
  readonly profile: FidelityComparison["profile"];
  readonly experimentSha256: string;
  readonly real: ReportLog;
  readonly simulated: ReportLog;
  readonly interval: FidelityInterval;
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** The assessment of the two logs and the record that keeps it; throws for a log that cannot be read or a bad interval. */
export async function fidelityReport(input: ReportInput): Promise<{ readonly assessment: FidelityAssessment; readonly comparison: FidelityComparison }> {
  const real = readDataFlash(input.real.bytes), simulated = readDataFlash(input.simulated.bytes);
  const assessment = assessFidelity(real, simulated, input.interval);
  const file = async (log: ReportLog, origin: ReturnType<typeof logOrigin>) => ({ name: log.name.slice(0, 128), sha256: await sha256Of(log.bytes), bytes: log.bytes.byteLength,
    origin: origin.kind, originReason: origin.reason });
  const comparison = validateFidelityComparison({
    schemaVersion: 1, profile: input.profile, experimentSha256: input.experimentSha256,
    real: await file(input.real, logOrigin(real)), simulated: await file(input.simulated, logOrigin(simulated)),
    interval: assessment.interval, regimes: assessment.regimes, rows: assessment.rows, scalars: assessment.scalars,
    path: assessment.path, pathReason: assessment.pathReason,
  });
  return { assessment, comparison };
}

/** One number as the report shows it: the unit's precision, or the dash of a value that is not there. */
export function shown(value: number | null, digits = 3): string {
  return value === null ? "—" : value.toFixed(digits);
}
