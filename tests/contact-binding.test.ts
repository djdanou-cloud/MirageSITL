import { beforeAll, expect, test } from "vitest";
import { GroundContact } from "../packages/physics/src/ground-contact";
import { newBodyTruth } from "../packages/wasm-bet/src/backend";
import { prepareContact, syntheticGearOptions } from "./contact-support";
beforeAll(prepareContact, 300000);
test.each([400, 800, 1200])("separate strut and tire support static weight at %i Hz", async (hz) => {
    const truth = newBodyTruth();
    truth.positionNedM[2] = -1;
    const contact = await GroundContact.create(truth, 10, 0.1, 0, 0, syntheticGearOptions());
    const wrench = new Float64Array(6), wheel = new Float64Array(8);
    try {
        for (let i = 0; i < 8 * hz; i++)
            expect(contact.stepInto(wrench, 1 / hz, truth)).toBe(true);
        let tire = 0, strut = 0;
        for (let i = 0; i < 3; i++) {
            expect(contact.wheelStateInto(i, wheel)).toBe(true);
            expect(wheel[0]).toBeGreaterThan(0);
            expect(wheel[0]).toBeLessThan(0.15);
            expect(wheel[1]).toBeGreaterThan(0);
            expect(wheel[1]).toBeLessThan(0.05);
            expect(wheel[4]).toBeLessThan(0.001);
            tire += wheel[2]!;
            strut += wheel[3]!;
        }
        expect(Math.abs(strut - 10 * 9.80665)).toBeLessThan(0.2);
        expect(Math.abs(tire - 10.6 * 9.80665)).toBeLessThan(0.2);
        expect(Math.abs(truth.velocityNedMps[2]!)).toBeLessThan(0.001);
    }
    finally {
        contact.dispose();
    }
});
test("rejects malformed input without changing truth and disposes idempotently", async () => {
    const truth = newBodyTruth();
    truth.positionNedM[2] = -1;
    const contact = await GroundContact.create(truth);
    const wrench = new Float64Array(6);
    wrench[0] = NaN;
    expect(contact.stepInto(wrench, 1 / 400, truth)).toBe(false);
    expect(truth.positionNedM[2]).toBe(-1);
    wrench[0] = 0;
    expect(contact.stepInto(wrench, 1 / 400, truth)).toBe(true);
    contact.dispose();
    contact.dispose();
    expect(contact.stepInto(wrench, 1 / 400, truth)).toBe(false);
});
test("free fall has one integration owner and angular contact impulse is available", async () => {
    const truth = newBodyTruth();
    truth.positionNedM[2] = -10;
    const contact = await GroundContact.create(truth);
    const wrench = new Float64Array(6);
    for (let i = 0; i < 40; i++)
        expect(contact.stepInto(wrench, 1 / 400, truth)).toBe(true);
    expect(Math.abs(truth.velocityNedMps[2]! - 0.980665)).toBeLessThan(1e-8);
    expect(Math.abs(truth.positionNedM[2] + 10 - 0.04903325)).toBeLessThan(0.002);
    const impulse = { pointBody: new Float64Array(3), impulseNed: new Float64Array(3), momentBodyNms: new Float64Array(3), dt: 0 };
    contact.impulseInto(impulse);
    expect(Math.hypot(...impulse.impulseNed)).toBeLessThan(1e-10);
    expect(Math.hypot(...impulse.momentBodyNms)).toBeLessThan(1e-10);
    contact.dispose();
});
test("wheel braking dissipates motion while travel and rim constraints hold", async () => {
    const speeds: number[] = [];
    for (const brake of [0, 1]) {
        const truth = newBodyTruth();
        truth.positionNedM[2] = -0.46;
        const contact = await GroundContact.create(truth, 10, .1, 0, 0, syntheticGearOptions());
        const force = new Float64Array(6), brakes = new Float64Array(3), wheel = new Float64Array(8);
        try {
            for (let i = 0; i < 2400; i++)
                expect(contact.stepInto(force, 1 / 1200, truth)).toBe(true);
            force[0] = 20;
            for (let i = 0; i < 600; i++)
                expect(contact.stepInto(force, 1 / 1200, truth)).toBe(true);
            force[0] = 0;
            brakes.fill(brake);
            for (let i = 0; i < 1200; i++)
                expect(contact.stepInto(force, 1 / 1200, truth, brakes)).toBe(true);
            speeds.push(Math.abs(truth.velocityNedMps[0]!));
            for (let i = 0; i < 3; i++) {
                contact.wheelStateInto(i, wheel);
                expect(wheel[5]).toBeGreaterThan(-.002);
                expect(wheel[5]).toBeLessThan(.152);
                expect(wheel[6]).toBeGreaterThan(.048);
            }
        }
        finally {
            contact.dispose();
        }
    }
    expect(speeds[1]!).toBeLessThan(speeds[0]!);
});
// TASK-095: a cornering stiffness reaches the native brush law. Rolling at 5 m/s with a
// 0.05 m/s side velocity, the closed form v_y = v_y0 ((v0 - b t)/v0)^(k/b) (k = sum C_a / m,
// b = rolling mu g) holds within 5 %. Without it the side force sticks: the airframe then only
// rocks on its struts, and its sideways drift over 1 s stays below a fifth of the brush drift.
test.each([400, 800, 1200])("the brush tire decays a side velocity at %i Hz", async (hz) => {
    const lateral: number[] = [], drift: number[] = [];
    for (const cornering of [20, 0]) {
        const truth = newBodyTruth();
        truth.positionNedM[2] = -0.501;
        truth.velocityNedMps[0] = 5;
        truth.velocityNedMps[1] = 0.05;
        const base = syntheticGearOptions(4);
        const options = { ...base, wheels: (base.wheels ?? []).map(w => ({ ...w, anchorBodyM: [w.anchorBodyM[0], w.anchorBodyM[1], 0.4] as const,
            corneringStiffnessNpRad: cornering })) };
        const contact = await GroundContact.create(truth, 1.5, 0.1, 0, 0, options);
        const wrench = new Float64Array(6);
        try {
            for (let i = 0; i < hz; i++) {
                expect(contact.stepInto(wrench, 1 / hz, truth)).toBe(true);
                if (i + 1 === 0.3 * hz)
                    lateral.push(truth.velocityNedMps[1]);
            }
            drift.push(Math.abs(truth.positionNedM[1]!));
        }
        finally {
            contact.dispose();
        }
    }
    const k = 4 * 20 / 2.3, b = 0.02 * 9.80665;
    const expected = 0.05 * ((5 - b * 0.3) / 5) ** (k / b);
    expect(Math.abs(lateral[0]! - expected)).toBeLessThan(0.05 * expected);
    expect(drift[1]!).toBeLessThan(0.2 * drift[0]!);
});
test("rejects a negative cornering stiffness", async () => {
    const base = syntheticGearOptions(1);
    const options = { ...base, wheels: (base.wheels ?? []).map(w => ({ ...w, corneringStiffnessNpRad: -1 })) };
    await expect(GroundContact.create(newBodyTruth(), 1, 0.1, 0, 0, options)).rejects.toThrow("Invalid cornering stiffness");
});
// TASK-095 (decision F-08): a kinetic friction ratio reaches the native law. Sliding sideways at
// 2 m/s on the lateral mu_s of 0.5, the aircraft stops after v²/(2 mu_k g) within 5 %: with the
// ratio 0.8 at mu_k = 0.4, and without it at mu_s.
test.each([400, 800, 1200])("a kinetic friction ratio lengthens the slide to its own Coulomb distance at %i Hz", async (hz) => {
    const travelled: number[] = [];
    for (const ratio of [0.8, 1]) {
        const truth = newBodyTruth();
        truth.positionNedM[2] = -0.501;
        truth.velocityNedMps[1] = 2;
        const base = syntheticGearOptions(4);
        const options = { ...base, wheels: (base.wheels ?? []).map(w => ({ ...w, kineticFrictionRatio: ratio })) };
        const contact = await GroundContact.create(truth, 1.5, 0.1, 0, 0, options);
        const wrench = new Float64Array(6);
        try {
            for (let i = 0; i < 4 * hz; i++)
                expect(contact.stepInto(wrench, 1 / hz, truth)).toBe(true);
            travelled.push(Math.hypot(truth.positionNedM[0]!, truth.positionNedM[1]!));
        }
        finally {
            contact.dispose();
        }
    }
    for (const [i, mu] of [[0, 0.4], [1, 0.5]] as const) {
        const expected = 4 / (2 * mu * 9.80665);
        expect(Math.abs(travelled[i]! - expected), `mu_k ${mu}`).toBeLessThan(0.05 * expected);
    }
});
test("rejects a kinetic friction ratio outside (0, 1]", async () => {
    const base = syntheticGearOptions(1);
    for (const ratio of [0, -0.5, 1.5, Number.NaN]) {
        const options = { ...base, wheels: (base.wheels ?? []).map(w => ({ ...w, kineticFrictionRatio: ratio })) };
        await expect(GroundContact.create(newBodyTruth(), 1, 0.1, 0, 0, options)).rejects.toThrow("Invalid kinetic friction ratio");
    }
});
// TASK-095 increment 4: hull and propeller shapes cross the WASM contact (configuration version 5).
test.each([400, 800, 1200])("hull shapes carry the airframe and report their contact at %i Hz", async (hz) => {
    // Oracle: a horizontal capsule 0.05 m below the CG with radius 0.03 rests with the CG 0.08 m
    // over the ground and carries m g; a cylinder above it never touches.
    const truth = newBodyTruth();
    truth.positionNedM[2] = -0.1;
    const contact = await GroundContact.create(truth, 1, 0.1, 0, 0.6, {
        inertiaDiagonalKgM2: [0.01, 0.01, 0.01],
        shapes: [
            { kind: "capsule", startBodyM: [-0.2, 0, 0.05], endBodyM: [0.2, 0, 0.05], radiusM: 0.03 },
            { kind: "cylinder", centerBodyM: [0, 0, -0.1], axisBody: [0, 0, 1], radiusM: 0.1, halfHeightM: 0.02 },
        ],
    });
    const wrench = new Float64Array(6), low = new Float64Array(8), high = new Float64Array(8);
    try {
        expect(contact.shapeCount).toBe(2);
        for (let i = 0; i < 1.5 * hz; i++)
            expect(contact.stepInto(wrench, 1 / hz, truth)).toBe(true);
        expect(contact.shapeStateInto(0, low)).toBe(true);
        expect(contact.shapeStateInto(1, high)).toBe(true);
        expect(contact.shapeStateInto(2, high)).toBe(false);
        expect(Math.abs(-truth.positionNedM[2] - 0.08)).toBeLessThan(2e-3);
        expect(Math.abs(low[2]! - 9.80665)).toBeLessThan(0.02 * 9.80665);
        expect(low[1]).toBeCloseTo(low[2]! / hz, 12);
        expect(low[6]).toBe(1);
        expect(Math.abs(low[5]! - 0.08)).toBeLessThan(2e-3);
        expect(Array.from(high)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
        expect(contact.allocationCalls).toBe(0);
    }
    finally {
        contact.dispose();
    }
});
test("an invalid shape is rejected before the native session starts", async () => {
    const truth = newBodyTruth();
    const cylinder = { kind: "cylinder" as const, centerBodyM: [0, 0, 0] as const, axisBody: [0, 0, 0.5] as const, radiusM: 0.1, halfHeightM: 0.01 };
    await expect(GroundContact.create(truth, 1, 0.1, 0, 0.6, { shapes: [cylinder] })).rejects.toThrow("Invalid contact shape");
    await expect(GroundContact.create(truth, 1, 0.1, 0, 0.6, { shapes: [{ ...cylinder, axisBody: [0, 0, 1], radiusM: 0 }] }))
        .rejects.toThrow("Invalid contact shape");
});
