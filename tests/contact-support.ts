import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { GroundContact, type ContactOptions, type ContactWheel } from "../packages/physics/src/ground-contact";
export async function prepareContact(): Promise<void> {
    execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
    const manifest: unknown = JSON.parse(readFileSync("packages/physics/dist/contact/manifest.json", "utf8"));
    await GroundContact.initialize(new Uint8Array(readFileSync("packages/physics/dist/contact/contact.wasm")), manifest);
}
/** Explicit synthetic configuration; not a measured aircraft or NASA rig. */
export function syntheticGearOptions(count = 3): ContactOptions {
    const wheels: ContactWheel[] = [];
    for (let i = 0; i < count; i++) {
        const angle = 2 * Math.PI * i / count;
        wheels.push({ anchorBodyM: [count === 1 ? 0 : 0.4 * Math.cos(angle), count === 1 ? 0 : 0.4 * Math.sin(angle), 0.4],
            unsprungMassKg: 0.2, tireRadiusM: 0.1, rimRadiusM: 0.05, strutTravelM: 0.15,
            suspension: { kind: "linear", stiffnessNpm: 1000, preloadN: 0, compressionDamping: 30, reboundDamping: 50, dampingLaw: "linear" },
            tireLoadCurve: [[0, 0], [0.05, 1000]], tireDampingNsPm: 10, rollingCoefficient: 0.02, lateralCoefficient: 0.5, brakingCoefficient: 0.7 });
    }
    return { inertiaDiagonalKgM2: [1, 1, 1], wheels };
}
