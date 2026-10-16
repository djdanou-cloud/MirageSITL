import { expect, it } from "vitest";
import { providerPolicy } from "../packages/terrain/src/provider-policy";
it("denies Google persistent caching/prefetch/offline by default and fails closed on unknown policy", () => {
  const p = {
    provider: "google-live",
    attribution: "Google Maps",
    allowedCache: "memory",
    ttlS: 0,
    offline: false,
    prefetch: false,
    datasetLicense: "Google Map Tiles API terms",
    evidenceSha256: null,
  };
  expect(providerPolicy(p).provider).toBe("google-live");
  for (const change of [
    { allowedCache: "persistent" },
    { offline: true },
    { prefetch: true },
    { ttlS: 1 },
    { provider: "unknown" },
    { attribution: "" },
  ])
    expect(() => providerPolicy({ ...p, ...change })).toThrow();
  expect(() => providerPolicy({})).toThrow();
  expect(() =>
    providerPolicy({ ...p, provider: "licensed", allowedCache: "persistent" }),
  ).toThrow();
  expect(
    providerPolicy({
      ...p,
      provider: "licensed",
      allowedCache: "persistent",
      evidenceSha256: "a".repeat(64),
    }).allowedCache,
  ).toBe("persistent");
});
