import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { OwnedProcess } from "../apps/launcher/src/processes.ts";

// What signalling a run's process group answers when there is nothing left alive in it. macOS answers
// kill(-group) with EPERM, not ESRCH, while the group holds only zombies: 20 of 20 when forced, and 2 of
// 400 with no repository code involved when a leader and its child die together under load. In the exit
// listener and the SIGKILL timer a throw is uncaught, and it ended the launcher.

let home = "";
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "mirage-owned-")); });
afterAll(() => { rmSync(home, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });

const realKill = process.kill.bind(process);
/** process.kill, answering this code for a signal to a process group that `when` picks. */
function groupAnswers(code: string, when: (signal: string | number | undefined) => boolean): void {
  vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
    if (pid < 0 && when(signal)) throw Object.assign(new Error(`kill ${code}`), { code, syscall: "kill" });
    return realKill(pid, signal);
  });
}
let run = 0;
const start = (script: string, onEnd?: () => void) => OwnedProcess.start({ command: "/bin/sh", args: ["-c", script], cwd: home, run: ++run }, onEnd);

describe("signalling a run's process group", () => {
  test("stopping a run that has just died, before anything has reaped it, ends it as stopped", async () => {
    // It lives long enough that this code gets past the start, and dies while the event loop is blocked,
    // when Node cannot reap it: the real thing, on the platform that answers EPERM for it.
    const owned = await start("sleep 0.05");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    await owned.stop();
    // Stopped and not exited: the stop came before Node saw the exit, so this did test that moment.
    expect(owned.info.state).toBe("stopped");
    expect(owned.running).toBe(false);
  });

  test("a run whose group answers EPERM after its leader exits still ends, once", async () => {
    groupAnswers("EPERM", signal => signal === "SIGKILL");
    const ended = vi.fn();
    const owned = await start("exit 3", ended);
    await owned.waitForExit();
    expect(owned.info).toMatchObject({ state: "crashed", exitCode: 3, signal: null });
    expect(owned.info.endedAt).not.toBeNull();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  test("the SIGKILL after the grace period survives the same answer, and the stop still completes", async () => {
    // A process that ignores SIGTERM, so the timer fires and is told EPERM. It says when it has started ignoring it.
    const ready = join(home, "ignoring-term");
    const owned = await start(`trap '' TERM; : > "${ready}"; while :; do sleep 0.02; done`);
    await vi.waitFor(() => { expect(existsSync(ready)).toBe(true); }, { timeout: 5000, interval: 10 });
    groupAnswers("EPERM", signal => signal === "SIGKILL");
    const stopping = owned.stop(30);
    await new Promise(done => setTimeout(done, 120));
    expect(owned.info.state).toBe("stopping");
    vi.restoreAllMocks();
    realKill(-owned.info.pid, "SIGKILL");
    await stopping;
    expect(owned.info.state).toBe("stopped");
  });

  test("any other answer is still an error", async () => {
    const owned = await start("while :; do sleep 0.02; done");
    groupAnswers("EINVAL", signal => signal === "SIGTERM");
    await expect(owned.stop()).rejects.toThrow("kill EINVAL");
    vi.restoreAllMocks();
    await owned.stop();
    expect(owned.info.state).toBe("stopped");
  });

  test("the owned-process harness survives the same answer", () => {
    // In a process of its own, as the other tests of this script run it: an uncaught throw there is an exit code here.
    const code = `import {runOwned} from './scripts/run-sitl.mjs';
const real = process.kill.bind(process);
process.kill = (pid, signal) => { if (pid < 0) throw Object.assign(new Error('kill EPERM'), {code: 'EPERM'}); return real(pid, signal); };
process.stdout.write((await runOwned('/bin/sh', ['-c', 'echo done'], {timeoutMs: 5000})).toString());`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 20000 });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("done");
  });
});
