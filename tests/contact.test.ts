import fixture from "./fixtures/contact/drop.json";
import registry from "./fixtures/registry.json";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { verifyFixture } from "@mirage/test-support/fixtures";
import { GroundContact } from "../packages/physics/src/ground-contact";
import { evaluateNasaDrop, parseNasaDropFixture } from "../packages/physics/src/nasa-drop";
import { newBodyTruth } from "@mirage/wasm-bet/backend";
it("uses one Rapier integration owner and settles a dropped sphere without tunneling", async () => {
  const t = newBodyTruth();
  t.positionNedM[2] = fixture.initialDownM;
  t.velocityNedMps[0] = fixture.horizontalMps;
  const contact = await GroundContact.create(
      t,
      fixture.massKg,
      fixture.radiusM,
      fixture.restitution,
      fixture.friction,
    ),
    w = new Float64Array(6);
  try {
    expect(contact.integrationOwner).toBe("rapier");
    for (let i = 0; i < fixture.steps; i++) {
      expect(contact.stepInto(w, 1 / 400, t)).toBe(true);
      expect(t.positionNedM[2]).toBeLessThan(0.001);
    }
    expect(t.positionNedM[2]).toBeCloseTo(-0.1, 2);
    expect(t.velocityNedMps[0]).toBeGreaterThan(0);
    expect(t.velocityNedMps[0]).toBeLessThan(2);
    expect(Math.abs(t.velocityNedMps[2]!)).toBeLessThan(0.1);
    const impulse = {
      pointBody: new Float64Array(3),
      impulseNed: new Float64Array(3),
      dt: 0,
    };
    contact.impulseInto(impulse);
    expect(impulse.dt).toBe(1 / 400);
  } finally {
    contact.dispose();
  }
});
it("restitution does not increase initial drop energy", async () => {
  const t = newBodyTruth();
  t.positionNedM[2] = -1;
  const c = await GroundContact.create(t, 1, 0.1, 0.5, 0),
    w = new Float64Array(6);
  try {
    let touched = false,
      maxRebound = 0;
    for (let i = 0; i < 1200; i++) {
      c.stepInto(w, 1 / 400, t);
      if (t.positionNedM[2] > -0.11) touched = true;
      if (touched)
        maxRebound = Math.max(
          maxRebound,
          0.5 * t.velocityNedMps[2]! ** 2 +
            9.80665 * (-t.positionNedM[2] - 0.1),
        );
    }
    expect(maxRebound).toBeLessThan(9.80665 * 0.9 + 0.05);
  } finally {
    c.dispose();
  }
});
it("replays the NASA TM X-3561 level drops: solver consistency passes, measured envelopes fail", async () => {
  const entry = registry.fixtures.find((item) => item.path === "contact/nasa-drop.json");
  if (!entry) throw new Error("NASA drop fixture is not registered");
  const bytes = readFileSync(new URL("./fixtures/contact/nasa-drop.json", import.meta.url));
  const manifest = await verifyFixture(entry.manifest, bytes);
  expect(manifest.provenance.kind).toBe("measured");
  const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const fixture = parseNasaDropFixture(payload);
  // Registry tolerance and envelope describe exactly this payload.
  expect(manifest.tolerance).toEqual({
    absolute: fixture.acceptance.penetrationToleranceM,
    relative: fixture.acceptance.relativeTolerance,
  });
  const envelope = manifest.validityEnvelope;
  expect(envelope.dropMassKg).toEqual({ min: fixture.massKg, max: fixture.massKg });
  expect(envelope.sinkRateMps).toEqual({
    min: Math.min(...fixture.cases.map((c) => c.sinkRateMps)),
    max: Math.max(...fixture.cases.map((c) => c.sinkRateMps)),
  });
  // Independent oracle: 3280 lbm, 4/5/6 ft/s and 3600 lbf converted with exact factors.
  expect(fixture.massKg).toBeCloseTo(3280 * 0.45359237, 6);
  for (const [i, fps] of [4, 5, 6].entries()) expect(fixture.cases[i]?.sinkRateMps).toBeCloseTo(fps * 0.3048, 9);
  expect(fixture.liftForceN).toBeCloseTo(3600 * 4.4482216152605, 6);
  const report = await evaluateNasaDrop(fixture);
  expect(report.runs).toHaveLength(9);
  for (const run of report.runs) {
    expect(run.checks.impulse).toBe("pass");
    expect(run.checks.nonpenetration).toBe("pass");
    expect(run.checks.energy).toBe("pass");
    expect(Math.abs(run.arrestImpulseNs - run.sinkMomentumNs)).toBeLessThan(0.01 * run.sinkMomentumNs);
    // A rigid sphere arrests the sink in a few steps: far outside the -1.6 g measurement.
    expect(run.windowedPeakAccelerationDownMps2).toBeLessThan(run.measuredMinAccelerationDownMps2 * 5);
    expect(run.maxPenetrationM).toBeLessThan(0.1 * run.measuredMaxStrutStrokeM);
    expect(run.checks.decelerationEnvelope).toBe("failed");
    expect(run.checks.strokeEnvelope).toBe("failed");
  }
  expect(report.consistencyStatus).toBe("pass");
  expect(report.measuredStatus).toBe("failed");
}, 60000);
it("rejects malformed NASA drop payloads", () => {
  const payload: unknown = JSON.parse(readFileSync(new URL("./fixtures/contact/nasa-drop.json", import.meta.url), "utf8"));
  expect(() => parseNasaDropFixture({})).toThrow("Invalid NASA drop fixture");
  const text = JSON.stringify(payload);
  expect(() => parseNasaDropFixture(JSON.parse(text.replace('"unit":"kg"', '"unit":"lbm"')))).toThrow("unit");
  expect(() => parseNasaDropFixture(JSON.parse(text.replace("https://ntrs.nasa.gov/citations/19780003109", "http://example.com")))).toThrow("referenceUrl");
  expect(() => parseNasaDropFixture(JSON.parse(text.replaceAll('"surfaceInclinationRad":0', '"surfaceInclinationRad":0.1')))).toThrow("level-surface");
});
