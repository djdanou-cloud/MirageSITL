import { beforeAll, expect, it } from "vitest";
import { GroundContact } from "../packages/physics/src/ground-contact";
import { newBodyTruth } from "@mirage/wasm-bet/backend";
import { prepareContact, syntheticGearOptions } from "./contact-support";
beforeAll(prepareContact, 300000);
// One million steps for each rate and gear count, 9,000,000 in all. Each configuration has its
// own budget: shared CI runners took 212-343 s for all nine, too close to one 300 s limit.
const configurations = [400, 800, 1200].flatMap(hz => [0, 3, 8].map(wheels => ({ hz, wheels, name: `${hz} Hz with ${wheels} wheels` })));
it.each(configurations)("counts actual WASM allocator calls through repeated impacts at $name", async ({ hz, wheels }) => {
    const t = newBodyTruth();
    t.positionNedM[2] = -1;
    const c = await GroundContact.create(t, wheels ? 10 : 1, 0.1, 0, 0.5, wheels ? syntheticGearOptions(wheels) : {});
    const force = new Float64Array(6);
    try {
        for (let i = 0; i < 1000000; i++) {
            force[2] = i % (2 * hz) < hz / 4 ? -(wheels ? 10 + 0.2 * wheels : 1) * 19.6133 : 0;
            if (!c.stepInto(force, 1 / hz, t))
                throw new Error(`Contact G1 failed at ${hz} Hz, ${wheels} wheels, tick ${i}, code ${c.lastStatus}, calls ${c.allocationCalls}, bytes ${c.allocationBytes}`);
        }
        expect(c.allocationCalls).toBe(0);
        expect(c.allocationBytes).toBe(0);
        expect(c.highRateCertified).toBe(true);
    }
    finally {
        c.dispose();
    }
}, 180000);
