import { spawn, type ChildProcess } from "node:child_process";
import { openSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lastLine } from "./logs.ts";

// Owned SITL processes (TASK-151). The launcher starts every SITL process in
// its own POSIX process group and keeps the ChildProcess handle; it signals
// only groups it started and has not yet seen exit. No request ever names a
// process ID, so a process the launcher did not start cannot be signalled
// through it. Each run records its owner in owner.json beside its logs.
// When a run ends by itself, its reason names the exit code or signal and
// the last line SITL wrote to stderr, such as ArduPilot's bind failure.

export type RunState = "running" | "stopping" | "stopped" | "exited" | "crashed";
export interface RunInfo {
  readonly run: number;
  readonly pid: number;
  readonly startedAt: string;
  state: RunState;
  exitCode: number | null;
  signal: string | null;
  endedAt: string | null;
  /** Why the run ended: null while running and after a requested stop; otherwise "exit code N" or "killed by SIGNAL", then ": " and the last stderr line when there is one and it can be read. */
  reason: string | null;
}
export interface OwnedSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Run number, which names this run's stdout/stderr files. */
  readonly run: number;
}
/** TERM, then KILL after this long, for the whole owned group. */
export const STOP_GRACE_MS = 3000;

export class OwnedProcess {
  readonly info: RunInfo;
  private readonly child: ChildProcess;
  private readonly exited: Promise<void>;
  private killTimer: NodeJS.Timeout | null = null;

  private constructor(child: ChildProcess, info: RunInfo, stderrPath: string, onEnd: (info: RunInfo) => void) {
    this.child = child;
    this.info = info;
    this.exited = new Promise(done => {
      child.once("exit", (code, signal) => {
        // The leader has exited; reap any descendant still in its group.
        this.signalGroup("SIGKILL");
        if (this.killTimer) clearTimeout(this.killTimer);
        info.exitCode = code;
        info.signal = signal;
        info.endedAt = new Date().toISOString();
        info.state = info.state === "stopping" ? "stopped" : code === 0 ? "exited" : "crashed";
        info.reason = info.state === "stopped" ? null : exitReason(code, signal, readLastLine(stderrPath));
        onEnd(info);
        done();
      });
    });
  }

  /** Spawns the command in a new process group with its output in run files. */
  static start(spec: OwnedSpec, onEnd: (info: RunInfo) => void = () => undefined): Promise<OwnedProcess> {
    const stderrPath = join(spec.cwd, `stderr-${spec.run}.log`);
    const stdout = openSync(join(spec.cwd, `stdout-${spec.run}.log`), "a", 0o600);
    const stderr = openSync(stderrPath, "a", 0o600);
    return new Promise((done, reject) => {
      const child = spawn(spec.command, spec.args, { cwd: spec.cwd, shell: false, detached: true, stdio: ["ignore", stdout, stderr], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
      const closeFiles = () => { closeSync(stdout); closeSync(stderr); };
      child.once("error", error => { closeFiles(); reject(error); });
      child.once("spawn", () => {
        closeFiles();
        // spawn succeeded, so the child has a PID.
        const info: RunInfo = { run: spec.run, pid: child.pid!, startedAt: new Date().toISOString(), state: "running", exitCode: null, signal: null, endedAt: null, reason: null };
        writeFileSync(join(spec.cwd, `owner-${spec.run}.json`), `${JSON.stringify({ launcherPid: process.pid, pid: info.pid, processGroup: info.pid, startedAt: info.startedAt, command: spec.command, args: spec.args }, null, 2)}\n`, { mode: 0o600 });
        done(new OwnedProcess(child, info, stderrPath, onEnd));
      });
    });
  }

  get running(): boolean {
    return this.info.state === "running" || this.info.state === "stopping";
  }

  /** SIGTERM to the owned group, SIGKILL after the grace period; resolves when the leader has exited. */
  async stop(graceMs = STOP_GRACE_MS): Promise<void> {
    if (!this.running) return;
    this.info.state = "stopping";
    this.signalGroup("SIGTERM");
    this.killTimer = setTimeout(() => this.signalGroup("SIGKILL"), graceMs);
    await this.exited;
  }

  waitForExit(): Promise<void> {
    return this.exited;
  }

  private signalGroup(signal: NodeJS.Signals): void {
    // Only this run's own group, created by detached spawn: -pid addresses exactly it.
    try {
      process.kill(-this.info.pid, signal);
    } catch (error) {
      // ESRCH: the group is gone. EPERM: on macOS the group still exists with nothing alive in it, its members exited and not yet
      // reaped. Either way there is nothing to signal, and this runs in the exit listener and a timer, where a throw is uncaught.
      if (!(error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM"))) throw error;
    }
  }
}

/**
 * The last stderr line for an exit reason, or null when the log cannot be
 * read (EACCES, EMFILE, a directory in its place). It runs inside the exit
 * listener, so a read error must not stop the run from being marked ended.
 */
function readLastLine(path: string): string | null {
  try {
    return lastLine(path);
  } catch {
    return null;
  }
}

/** "exit code N" or "killed by SIGNAL", joined with ": " to the last stderr line when there is one. */
function exitReason(code: number | null, signal: string | null, stderrLine: string | null): string {
  // Node reports exactly one of code and signal for an exited child.
  const ending = code !== null ? `exit code ${code}` : `killed by ${signal ?? "an unknown signal"}`;
  return stderrLine === null ? ending : `${ending}: ${stderrLine}`;
}
