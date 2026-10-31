import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BetRigidBodyBackend, newBodyTruth } from '@mirage/wasm-bet/backend';
import { BODY_V2, BetRigidBodyBackendV2, newBodyTruthV2 } from '@mirage/wasm-bet/body-v2';
import { GroundContact } from '../packages/physics/src/ground-contact';
import { prepareContact } from './contact-support';

// TASK-094 in WASM: the CG offset of rigid-body step interface v2 through its
// adapter, and Rapier-owned sessions with a full inertia tensor (contact
// configuration version 2) against the RK4 body integrator. Tolerances were set
// before the implementation (roadmap TASK-094) and match the native tests.

let module: WebAssembly.Module;
beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  await prepareContact();
}, 600000);
const instance = () => new WebAssembly.Instance(module, {});
const diagonal = [0.05, 0, 0, 0, 0.08, 0, 0, 0, 0.1];

/** Principal moments (0.02, 0.03, 0.045) kg m² turned 0.7 rad about (1, 2, 3): every product non-zero. */
function tensor(): number[] {
  const a = [1, 2, 3].map(v => v / Math.sqrt(14)), c = Math.cos(0.7), s = Math.sin(0.7);
  const r = [c + a[0]! * a[0]! * (1 - c), a[0]! * a[1]! * (1 - c) - a[2]! * s, a[0]! * a[2]! * (1 - c) + a[1]! * s,
    a[1]! * a[0]! * (1 - c) + a[2]! * s, c + a[1]! * a[1]! * (1 - c), a[1]! * a[2]! * (1 - c) - a[0]! * s,
    a[2]! * a[0]! * (1 - c) - a[1]! * s, a[2]! * a[1]! * (1 - c) + a[0]! * s, c + a[2]! * a[2]! * (1 - c)];
  const d = [0.02, 0.03, 0.045], m = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = i; j < 3; j++) {
    let sum = 0;
    for (let k = 0; k < 3; k++) sum += r[i * 3 + k]! * d[k]! * r[j * 3 + k]!;
    m[i * 3 + j] = sum; m[j * 3 + i] = sum;
  }
  return m;
}

describe('rigid-body interface v2 with a CG offset (WASM adapter)', () => {
  it('turns a force through the reference point into the exact single-axis rotation', () => {
    // I = diag(0.05, 0.08, 0.1), F = (0, 0, −10) N through O, r_c = (0.01, 0, 0): α = −0.1 / 0.08 rad/s² about y.
    const body = new BetRigidBodyBackendV2(instance(), 2, diagonal, 0, [0.01, 0, 0]);
    const truth = newBodyTruthV2(), wrench = new Float64Array([0, 0, -10, 0, 0, 0]), alpha = -1.25;
    body.reset(truth);
    for (let k = 1; k <= 400; k++) {
      expect(body.stepInto(wrench, 1 / 400, truth)).toBe(true);
      const t = k / 400, theta = 0.5 * alpha * t * t;
      expect(Math.abs(truth.angularVelocityBodyRadS[1]! - alpha * t)).toBeLessThan(1e-9);
      expect(Math.abs(truth.quaternionBodyToNed[0]! - Math.cos(theta / 2))).toBeLessThan(1e-9);
      expect(Math.abs(truth.quaternionBodyToNed[2]! - Math.sin(theta / 2))).toBeLessThan(1e-9);
      expect(Math.abs(truth.angularAccelerationBodyRadS2[1]! - alpha)).toBeLessThan(1e-12);
      const p = truth.positionNedM, o = truth.referencePositionNedM;
      expect(Math.abs(o[0]! - (p[0]! - 0.01 * Math.cos(theta)))).toBeLessThan(1e-12);
      expect(Math.abs(o[2]! - (p[2]! + 0.01 * Math.sin(theta)))).toBeLessThan(1e-12);
    }
    expect(truth.validity).toBe(BODY_V2.validSpecificForce | BODY_V2.validAngularAcceleration | BODY_V2.validReferencePosition);
  });
  it('without an offset matches the v1 backend bit for bit and reports the CG as the reference point', () => {
    const inertia = tensor(), v1 = new BetRigidBodyBackend(instance(), 1.5, inertia), v2 = new BetRigidBodyBackendV2(instance(), 1.5, inertia);
    const t1 = newBodyTruth(), t2 = newBodyTruthV2(), wrench = new Float64Array([0.5, -0.2, -15, 0.01, -0.02, 0.005]);
    for (const t of [t1, t2]) { t.angularVelocityBodyRadS.set([0.4, -0.3, 0.2]); t.positionNedM.set([1, 2, -20]); }
    v1.reset(t1); v2.reset(t2);
    for (let k = 0; k < 2000; k++) {
      expect(v1.stepInto(wrench, 1 / 800, t1) && v2.stepInto(wrench, 1 / 800, t2)).toBe(true);
      for (const [a, b] of [[t1.positionNedM, t2.positionNedM], [t1.quaternionBodyToNed, t2.quaternionBodyToNed],
        [t1.angularVelocityBodyRadS, t2.angularVelocityBodyRadS], [t1.accelerationNedMps2, t2.accelerationNedMps2]] as const) {
        for (let i = 0; i < a.length; i++) expect(Object.is(a[i], b[i])).toBe(true);
      }
      expect(Array.from(t2.referencePositionNedM)).toEqual(Array.from(t2.positionNedM));
    }
  });
  it('runs a million offset steps in WASM, whose trapping allocator would abort on any allocation', () => {
    const body = new BetRigidBodyBackendV2(instance(), 1.5, tensor(), 9.80665, [0.03, -0.02, 0.05]);
    const truth = newBodyTruthV2(), wrench = new Float64Array([0.5, -0.2, -14.7, 0.01, -0.02, 0.005]);
    truth.positionNedM.set([0, 0, -50]);
    body.reset(truth);
    let ok = true;
    for (let k = 0; k < 1_000_000; k++) {
      ok = body.stepInto(wrench, 1 / 1200, truth) && ok;
      // Hold the state so the run stays bounded; the step itself is what is measured.
      if ((k & 1023) === 1023) body.reset(truth.positionNedM[2]! > -40 ? { ...truth, positionNedM: new Float64Array([0, 0, -50]),
        velocityNedMps: new Float64Array(3), angularVelocityBodyRadS: new Float64Array(3) } : truth);
    }
    expect(ok).toBe(true);
    expect(body.memoryStable).toBe(true);
  }, 120000);
  it('rejects an offset of the wrong shape', () => {
    expect(() => new BetRigidBodyBackendV2(instance(), 1, diagonal, 9.80665, [0, 0])).toThrow('Invalid body interface v2');
    expect(() => new BetRigidBodyBackendV2(instance(), 1, diagonal, 9.80665, [0, NaN, 0])).toThrow('Invalid body interface v2');
  });
});

describe('Rapier-owned sessions keep the full inertia tensor', () => {
  /** Rate (relative) and attitude (rad) errors after 1 s against the 4800 Hz RK4 body. */
  async function againstRk4(inertia: number[], products: boolean, hz: 400 | 1200): Promise<{ rate: number; angle: number; calls: number }> {
    const start = newBodyTruth();
    start.positionNedM.set([0, 0, -100]); start.angularVelocityBodyRadS.set([3, 7, 2]);
    const options = products ? { inertiaKgM2: inertia } : { inertiaDiagonalKgM2: [inertia[0]!, inertia[4]!, inertia[8]!] as const };
    const contact = await GroundContact.create(start, 1.5, 0.1, 0, 0.7, options);
    const out = newBodyTruth(), zero = new Float64Array(6);
    try {
      for (let k = 0; k < hz; k++) expect(contact.stepInto(zero, 1 / hz, out)).toBe(true);
      const calls = contact.allocationCalls;
      const reference = new BetRigidBodyBackendV2(instance(), 1.5, inertia), truth = newBodyTruthV2();
      truth.positionNedM.set([0, 0, -100]); truth.angularVelocityBodyRadS.set([3, 7, 2]);
      reference.reset(truth);
      for (let k = 0; k < 4800; k++) expect(reference.stepInto(zero, 1 / 4800, truth)).toBe(true);
      const w = out.angularVelocityBodyRadS, r = truth.angularVelocityBodyRadS;
      const rate = Math.hypot(w[0]! - r[0]!, w[1]! - r[1]!, w[2]! - r[2]!) / Math.hypot(r[0]!, r[1]!, r[2]!);
      let dot = 0;
      for (let i = 0; i < 4; i++) dot += out.quaternionBodyToNed[i]! * truth.quaternionBodyToNed[i]!;
      return { rate, angle: 2 * Math.acos(Math.min(1, Math.abs(dot))), calls };
    } finally { contact.dispose(); }
  }
  it('matches RK4 within budget, converges at first order, and the products act', async () => {
    const inertia = tensor();
    const at400 = await againstRk4(inertia, true, 400), at1200 = await againstRk4(inertia, true, 1200);
    const withoutProducts = await againstRk4(inertia, false, 400);
    expect(at400.rate).toBeLessThan(0.02);
    expect(at400.angle).toBeLessThan(0.02);
    expect(at1200.rate).toBeLessThanOrEqual(0.6 * at400.rate);
    expect(withoutProducts.rate).toBeGreaterThanOrEqual(5 * at400.rate);
    // The contact's in-step allocator counter stays at zero.
    expect(at400.calls).toBe(0);
    expect(at1200.calls).toBe(0);
  }, 120000);
  it('steps a full-tensor contact session 200,000 times without an allocation', async () => {
    const start = newBodyTruth();
    start.positionNedM.set([0, 0, -1e6]); start.angularVelocityBodyRadS.set([3, 7, 2]);
    const contact = await GroundContact.create(start, 1.5, 0.1, 0, 0.7, { inertiaKgM2: tensor() });
    const out = newBodyTruth(), w = new Float64Array(6);
    out.quaternionBodyToNed.set(start.quaternionBodyToNed);
    try {
      for (let k = 0; k < 200_000; k++) {
        // Cancel gravity in body axes, R(q)ᵀ·(0, 0, −m g), so the tumbling body stays in place: a session
        // that travels tens of metres allocates in Rapier's broad phase, with or without products (TASK-095).
        const [qw, qx, qy, qz] = out.quaternionBodyToNed, mg = -1.5 * 9.80665;
        w[0] = 2 * (qx! * qz! - qw! * qy!) * mg; w[1] = 2 * (qy! * qz! + qw! * qx!) * mg; w[2] = (1 - 2 * (qx! * qx! + qy! * qy!)) * mg;
        if (!contact.stepInto(w, 1 / 1200, out)) throw new Error(`step ${k}: ${contact.lastStatus}`);
      }
      expect(contact.allocationCalls).toBe(0);
      expect(contact.allocationBytes).toBe(0);
    } finally { contact.dispose(); }
  }, 300000);
  it('writes version 2 only for a tensor with products, and rejects an asymmetric one', async () => {
    const start = newBodyTruth();
    start.positionNedM.set([0, 0, -10]);
    const asymmetric = tensor();
    asymmetric[3] = asymmetric[1]! + 1e-6;
    await expect(GroundContact.create(start, 1.5, 0.1, 0, 0.7, { inertiaKgM2: asymmetric })).rejects.toThrow('Invalid contact inertia tensor');
    // A diagonal tensor runs the version 1 path: the same motion as the diagonal option.
    const a = await GroundContact.create(start, 1.5, 0.1, 0, 0.7, { inertiaKgM2: diagonal });
    const b = await GroundContact.create(start, 1.5, 0.1, 0, 0.7, { inertiaDiagonalKgM2: [0.05, 0.08, 0.1] });
    const ta = newBodyTruth(), tb = newBodyTruth(), w = new Float64Array([0, 0, 0, 0.01, -0.02, 0.03]);
    try {
      for (let k = 0; k < 100; k++) expect(a.stepInto(w, 1 / 400, ta) && b.stepInto(w, 1 / 400, tb)).toBe(true);
      expect(Array.from(ta.quaternionBodyToNed)).toEqual(Array.from(tb.quaternionBodyToNed));
    } finally { a.dispose(); b.dispose(); }
  }, 120000);
});
