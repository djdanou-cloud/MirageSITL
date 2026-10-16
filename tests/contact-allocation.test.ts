import { expect, it, vi } from "vitest";
import RAPIER from "../packages/physics/src/contact-engine";
import { GroundContact } from "../packages/physics/src/ground-contact";
import { newBodyTruth } from "@mirage/wasm-bet/backend";
it("reuses Rapier targets and raw vectors while retaining native allocator certification gate", async () => {
  await RAPIER.init();
  expect(RAPIER.version()).toBe("0.21.0");
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
    expect(body.translation()).not.toBe(body.translation());
    expect(body.rotation()).not.toBe(body.rotation());
    const target = { x: 0, y: 0, z: 0 },
      q = { w: 1, x: 0, y: 0, z: 0 };
    expect(body.translation(target)).toBe(target);
    expect(body.linvel(target)).toBe(target);
    expect(body.angvel(target)).toBe(target);
    expect(body.rotation(q)).toBe(q);
  } finally {
    world.free();
  }
  const t = newBodyTruth();
  t.positionNedM[2] = -1;
  const c = await GroundContact.create(t);
  try {
    expect(c.highRateCertified).toBe(false);
    const conversion = vi.spyOn(RAPIER.VectorOps, "intoRaw"),
      wrench = new Float64Array(6);
    try {
      for (let i = 0; i < 2000; i++)
        expect(c.stepInto(wrench, 1 / 400, t)).toBe(true);
      expect(conversion).not.toHaveBeenCalled();
    } finally {
      conversion.mockRestore();
    }
  } finally {
    c.dispose();
  }
});
