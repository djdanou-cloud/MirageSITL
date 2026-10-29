import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { viteFileUrl } from "../support/vite-url";
import {
  FIXTURE_MODEL_ID, FIXTURE_NAMES, GEOMETRY_STRIPS, RECORDED_ENGINE_SENSITIVE_SHA256, RECORDED_MANIFEST_SHA256,
  RECORDED_PROPELLER_GEOMETRY_SHA256,
} from "../support/aircraft-derivation";

// TASK-138 and TASK-139: Chromium derives the same vehicle manifest and
// propeller geometry bytes as Node. Node 24 and Chromium disagree in the last
// bit of Math.sin, Math.cos, Math.tan and Math.atan for some arguments, so this
// holds only because the derivations compute their own trigonometry
// (packages/aircraft/src/trig.ts). The Node side of the comparison is
// tests/aircraft-profile.test.ts and tests/component-cards.test.ts, which check
// the same hashes.
type Derivation = typeof import("../../packages/aircraft/src/derive-manifest");
type Profiles = typeof import("../../packages/aircraft/src/profile");
type Support = typeof import("../support/aircraft-derivation");
type Geometry = typeof import("../../packages/aircraft/src/propeller-geometry");
type ProjectSchema = typeof import("../../packages/project/src/schema");
/** A blank page served by Vite, from which the modules are imported. */
const pageUrl = viteFileUrl(new URL("../support/project-store-harness.html", import.meta.url));
const urls = {
  derivation: viteFileUrl(new URL("../../packages/aircraft/src/derive-manifest.ts", import.meta.url)),
  profiles: viteFileUrl(new URL("../../packages/aircraft/src/profile.ts", import.meta.url)),
  support: viteFileUrl(new URL("../support/aircraft-derivation.ts", import.meta.url)),
  geometry: viteFileUrl(new URL("../../packages/aircraft/src/propeller-geometry.ts", import.meta.url)),
  schema: viteFileUrl(new URL("../../packages/project/src/schema.ts", import.meta.url)),
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

test("Chromium derives byte-identical propeller geometry from the example card", async ({ page }) => {
  const card = readFileSync(new URL("../fixtures/components/propeller-example.json", import.meta.url), "utf8");
  await page.goto(pageUrl);
  const derived = await page.evaluate(async ({ urls, card, strips }) => {
    const geometry = await import(urls.geometry) as Geometry;
    const schema = await import(urls.schema) as ProjectSchema;
    const hashes: Record<string, string> = {};
    for (const count of strips) {
      hashes[count] = await schema.sha256Hex(schema.canonicalBytes(geometry.derivePropellerGeometry(JSON.parse(card), { strips: count })));
    }
    return hashes;
  }, { urls, card, strips: [...GEOMETRY_STRIPS] });
  expect(derived).toEqual(RECORDED_PROPELLER_GEOMETRY_SHA256);
});
