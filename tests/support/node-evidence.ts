import { spawnSync } from "node:child_process";
import { expect } from "vitest";
/** Node exercises actual ESM tools; synthetic observations are not registered as hardware evidence. */
export function nodeCheck(code: string): void {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import assert from 'node:assert/strict';${code}`], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
}
