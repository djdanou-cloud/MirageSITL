import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

function git(...args: string[]): string {
  // --no-optional-locks: a read-only probe must not refresh the index beside other git use.
  return execFileSync("git", ["--no-optional-locks", ...args, "--", "test-results/"], { cwd: root, encoding: "utf8" });
}

/** Porcelain status of tracked test-results/ files plus the SHA-256 of each unstaged change. */
export function trackedResults(): string {
  // Status alone misses a test rewriting a file that was already modified before the run.
  const digests = git("diff", "--name-only", "-z").split("\0").filter(path => path.length > 0).map(path => {
    const file = join(root, path);
    return `${path} ${existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "deleted"}`;
  });
  return [git("status", "--porcelain").trimEnd(), ...digests].join("\n");
}

/**
 * Committed evidence under test-results/ is authoritative, so tests write generated reports to
 * temporary or ignored directories. Fails the run if any tracked file there changed meanwhile.
 */
export default function setup(): () => void {
  const before = trackedResults();
  return () => {
    const after = trackedResults();
    if (after === before) return;
    // Vitest only logs a throwing global teardown; the exit code is what fails the run.
    process.exitCode = 1;
    throw new Error(`Tests changed tracked files under test-results/ (git status --porcelain -- test-results/).\nBefore:\n${before || "(clean)"}\nAfter:\n${after || "(clean)"}`);
  };
}
