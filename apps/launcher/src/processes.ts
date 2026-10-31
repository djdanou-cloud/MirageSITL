import { spawn, type ChildProcess } from "node:child_process";
import { openSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Owned SITL processes (TASK-151). The launcher starts every SITL process in
// its own POSIX process group and keeps the ChildProcess handle; it signals
// only groups it started and has not yet seen exit. No request ever names a
// process ID, so a process the launcher did not start cannot be signalled
// through it. Each run records its owner in owner.json beside its logs.

export type RunState = "running" | "stopping" | "stopped" | "exited" | "crashed";
export interface RunInfo {
  readonly run: number;
  readonly pid: number;
  readonly startedAt: string;
  state: RunState;
  exitCode: number | null;
  signal: string | null;
  endedAt: string | null;
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

  private constructor(child: ChildProcess, info: RunInfo, onEnd: (info: RunInfo) => void) {
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
        onEnd(info);
        done();
      });
    });
  }

  /** Spawns the command in a new process group with its output in run files. */
  static start(spec: OwnedSpec, onEnd: (info: RunInfo) => void = () => undefined): Promise<OwnedProcess> {
    const stdout = openSync(join(spec.cwd, `stdout-${spec.run}.log`), "a", 0o600);
    const stderr = openSync(join(spec.cwd, `stderr-${spec.run}.log`), "a", 0o600);
    return new Promise((done, reject) => {
      const child = spawn(spec.command, spec.args, { cwd: spec.cwd, shell: false, detached: true, stdio: ["ignore", stdout, stderr], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
      const closeFiles = () => { closeSync(stdout); closeSync(stderr); };
      child.once("error", error => { closeFiles(); reject(error); });
      child.once("spawn", () => {
        closeFiles();
        // spawn succeeded, so the child has a PID.
        const info: RunInfo = { run: spec.run, pid: child.pid!, startedAt: new Date().toISOString(), state: "running", exitCode: null, signal: null, endedAt: null };
        writeFileSync(join(spec.cwd, `owner-${spec.run}.json`), `${JSON.stringify({ launcherPid: process.pid, pid: info.pid, processGroup: info.pid, startedAt: info.startedAt, command: spec.command, args: spec.args }, null, 2)}\n`, { mode: 0o600 });
        done(new OwnedProcess(child, info, onEnd));
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
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
}
