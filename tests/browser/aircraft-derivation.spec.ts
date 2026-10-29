import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { viteFileUrl } from "../support/vite-url";
import {
  FIXTURE_MODEL_ID, FIXTURE_NAMES, RECORDED_ENGINE_SENSITIVE_SHA256, RECORDED_MANIFEST_SHA256,
} from "../support/aircraft-derivation";

// TASK-138: Chromium derives the same vehicle manifest bytes as Node. Node 24
// and Chromium disagree in the last bit of Math.sin, Math.cos and Math.tan for
// some arguments, so this holds only because the derivation computes its own
// trigonometry (packages/aircraft/src/trig.ts). The Node side of the
// comparison is tests/aircraft-profile.test.ts, which checks the same hashes.
type Derivation = typeof import("../../packages/aircraft/src/derive-manifest");
type Profiles = typeof import("../../packages/aircraft/src/profile");
type Support = typeof import("../support/aircraft-derivation");
/** A blank page served by Vite, from which the modules are imported. */
const pageUrl = viteFileUrl(new URL("../support/project-store-harness.html", import.meta.url));
const urls = {
  derivation: viteFileUrl(new URL("../../packages/aircraft/src/derive-manifest.ts", import.meta.url)),
  profiles: viteFileUrl(new URL("../../packages/aircraft/src/profile.ts", import.meta.url)),
  support: viteFileUrl(new URL("../support/aircraft-derivation.ts", import.meta.url)),
};

test("Chromium derives byte-identical manifests for the five S19 configurations and engine-sensitive angles", async ({ page }) => {
  const fixtures = FIXTURE_NAMES.map(name =>
    [name, readFileSync(new URL(`../fixtures/aircraft/${name}.json`, import.meta.url), "utf8")] as const);
  await page.goto(pageUrl);
  const derived = await page.evaluate(async ({ urls, fixtures, modelId }) => {
    const derivation = await import(urls.derivation) as Derivation;
    const profiles = await import(urls.profiles) as Profiles;
    const support = await import(urls.support) as Support;
    const hashes: Record<string, string> = {};
    for (const [name, text] of fixtures) {
      const profile = profiles.validateAircraftProfile(JSON.parse(text));
      hashes[name] = (await derivation.deriveVehicleManifest(profile, support.syntheticComponents(profile), { modelId })).sha256;
      if (name === "octa-coaxial-16") {
        const variant = profiles.validateAircraftProfile(support.engineSensitiveVariant(profile));
        hashes["engine-sensitive"] = (await derivation.deriveVehicleManifest(variant, support.syntheticComponents(variant), { modelId })).sha256;
      }
    }
    return hashes;
  }, { urls, fixtures, modelId: FIXTURE_MODEL_ID });
  expect(derived).toEqual({ ...RECORDED_MANIFEST_SHA256, "engine-sensitive": RECORDED_ENGINE_SENSITIVE_SHA256 });
});
