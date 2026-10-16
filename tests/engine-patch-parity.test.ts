import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
const code =
  "import {compareEvidence} from './scripts/check-engine-patch-parity.mjs';let input='';for await(const chunk of process.stdin)input+=chunk;const [a,b]=JSON.parse(input);compareEvidence(a,b);";
const baseline = {
  steps: 1000000,
  trajectoryHash: "0123456789abcdef",
  sourceCommit: "a".repeat(40),
  allocationCalls: 10,
  allocationBytes: 20,
};
const patched = { ...baseline, allocationCalls: 0, allocationBytes: 0 };
function check(a: unknown, b: unknown) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    input: JSON.stringify([a, b]),
  });
}
it("requires original allocations, a zero-allocation patch and matching native trajectories", () => {
  expect(check(baseline, patched).status).toBe(0);
  for (const change of [
    { steps: 0 },
    { trajectoryHash: "fedcba9876543210" },
    { trajectoryHash: null },
    { sourceCommit: "b".repeat(40) },
    { allocationCalls: 1 },
    { allocationBytes: 1 },
  ])
    expect(check(baseline, { ...patched, ...change }).status).not.toBe(0);
  expect(check(patched, patched).status).not.toBe(0);
  expect(check({}, {}).status).not.toBe(0);
});
