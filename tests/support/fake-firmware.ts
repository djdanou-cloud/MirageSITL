// A fake SITL executable for launcher catalogs (TASK-151, TASK-154): a
// /bin/sh wrapper whose behaviour an absolute mode file selects at every
// start, so one catalog entry with one SHA-256 serves every fault. Mode
// "real" execs a real ArduCopter build with the launcher's arguments, so the
// run PID is ArduCopter's own; any other mode execs tests/support/fake-sitl.mjs
// (see its modes). OwnedProcess clears the environment, so the wrapper names
// every program by absolute path.
import { chmodSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FAKE_SITL_SCRIPT = fileURLToPath(new URL("./fake-sitl.mjs", import.meta.url));

export type FakeSitlMode = "idle" | "exit3" | "ignore-term" | "fork" | `bind-busy ${number}` | "real";
export interface FakeFirmwareOptions {
  /** Absolute path of the mode file; an absent file means "idle". */
  readonly modeFile: string;
  /** Absolute path of the executable that mode "real" runs. */
  readonly realBinary?: string;
}
export interface FakeFirmware {
  /** The wrapper, to be the catalog entry's binaryPath. */
  readonly binary: string;
  /** Selects the behaviour of the next start; existing runs are unaffected. */
  setMode(mode: FakeSitlMode): void;
}

/** A POSIX shell single-quoted word. */
function quoted(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Writes the wrapper as dir/fake-arducopter (mode 0755). */
export function writeFakeFirmware(dir: string, options: FakeFirmwareOptions): FakeFirmware {
  const { modeFile, realBinary } = options;
  if (!isAbsolute(dir) || !isAbsolute(modeFile) || (realBinary !== undefined && !isAbsolute(realBinary))) {
    throw new Error("The fake firmware needs absolute paths: OwnedProcess starts it without an environment");
  }
  const binary = join(dir, "fake-arducopter");
  const real = realBinary === undefined ? "" : `if [ "$mode" = real ]; then exec ${quoted(realBinary)} "$@"; fi\n`;
  writeFileSync(binary, `#!/bin/sh
mode=$(/bin/cat ${quoted(modeFile)} 2>/dev/null) || mode=idle
${real}exec ${quoted(process.execPath)} ${quoted(FAKE_SITL_SCRIPT)} --fake-mode "$mode" "$@"
`);
  chmodSync(binary, 0o755);
  return {
    binary,
    setMode: mode => {
      if (mode === "real" && realBinary === undefined) throw new Error("Mode real needs the realBinary option");
      writeFileSync(modeFile, `${mode}\n`);
    },
  };
}
