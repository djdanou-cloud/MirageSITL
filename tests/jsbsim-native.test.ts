import { execFileSync, spawnSync } from "node:child_process";
import { expect, it } from "vitest";
const parse =
  "import {parseNativeReport} from './scripts/check-jsbsim-native.mjs';let input='';for await(const chunk of process.stdin)input+=chunk;parseNativeReport(input);";
it("rejects missing, truncated and false numerical/allocator native evidence", () => {
  for (const input of [
    "",
    "{}",
    '{"schemaVersion":1,"nativeTrimPassed":true,"steps":0}',
  ]) {
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", parse],
      { input, encoding: "utf8" },
    );
    expect(r.status).not.toBe(0);
  }
});
it("does not turn a missing source checkout into a successful native validation", () => {
  expect(() =>
    execFileSync(process.execPath, ["scripts/check-jsbsim-native.mjs"], {
      env: {
        ...process.env,
        JSBSIM_SOURCE_DIR: "/missing-mirage-jsbsim-native",
      },
      stdio: "pipe",
    }),
  ).toThrow();
});
