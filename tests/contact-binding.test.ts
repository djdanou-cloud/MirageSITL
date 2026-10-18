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
