import fixture from "./fixtures/contact/drop.json";
import { expect, it } from "vitest";
import { GroundContact } from "../packages/physics/src/ground-contact";
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
