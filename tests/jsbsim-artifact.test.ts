import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
const lock = JSON.parse(
  readFileSync(
    new URL("../native/jsbsim/source.lock.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;
it("pins source, licensing and toolchain, and does not ship fake WASM artifacts", () => {
  expect(lock.commit).toBe("570e8115a102df8f877b11e0e59b964ea483e3c0");
  expect(lock.license).toBe("LGPL-2.1");
  expect(typeof lock.licenseSha256).toBe("string");
  const tool: unknown = JSON.parse(
    readFileSync(
      new URL("../native/jsbsim/toolchain.lock.json", import.meta.url),
      "utf8",
    ),
  );
  expect(tool).toMatchObject({
    version: "4.0.15",
    requiredDownloadHost: "storage.googleapis.com",
  });
});
it("rejects missing or mismatched source before invoking a compiler", () => {
  expect(() =>
    execFileSync(process.execPath, ["scripts/build-jsbsim.mjs"], {
      env: { ...process.env, JSBSIM_SOURCE_DIR: "/nonexistent-mirage-jsbsim" },
      stdio: "pipe",
    }),
  ).toThrow();
});
