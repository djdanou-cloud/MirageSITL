import { expect, it } from "vitest";
import { JsbsimBackend, type JsbsimModule } from "@mirage/wasm-jsbsim/backend";
import { newBodyTruth } from "@mirage/wasm-bet/backend";
import propertyMap from "../native/jsbsim/property-map.json";
// Boundary doubles exercise admission/sequencing only. Momentum/physics are
// checked separately by the actual native/WASM backend runner.
function setup() {
    const memory = new ArrayBuffer(8192);
    let next = 64, calls = 0, allocations = 0;
    const module: JsbsimModule = { HEAPU8: new Uint8Array(memory), HEAPF64: new Float64Array(memory),
        _malloc: n => { const p = next; next += Math.ceil(n / 8) * 8; return p; }, _free: () => { }, _jsb_abi_version: () => 1, _jsb_create: () => 16, _jsb_dispose: () => { },
        _jsb_step: (_id, _c, _n, o) => { module.HEAPF64.fill(0, o / 8, o / 8 + 22); module.HEAPF64[o / 8 + 6] = 1; return 0; },
        _jsb_contact_abi_version: () => 1, _jsb_apply_contact: () => { calls++; return 0; },
        _jsb_allocator_probe: () => 1, _jsb_allocation_track: () => { }, _jsb_allocation_calls: () => allocations, _jsb_allocation_bytes: () => allocations * 64 };
    return { module, count: () => calls, allocate: () => { allocations++; } };
}
function truth() { return { ...newBodyTruth(), specificForceBodyMps2: new Float64Array(3), timeS: 0, altitudeAslM: 0 }; }
it("freezes the additive contact byte frame without reusing legacy control fields", () => {
    expect(propertyMap.abiVersion).toBe(1);
    expect(propertyMap.inputCount).toBe(4);
    expect(propertyMap.extensions.contact).toMatchObject({ version: 1, inputCount: 6, linearImpulseOffset: 0, angularImpulseOffset: 3 });
    const frame = new ArrayBuffer(48), view = new DataView(frame), values = [1, -2, -3, .1, -.2, .3];
    for (let i = 0; i < 6; i++)
        view.setFloat64(i * 8, values[i]!, true);
    expect(Buffer.from(frame).toString("hex")).toBe("000000000000f03f00000000000000c000000000000008c09a9999999999b93f9a9999999999c9bf333333333333d33f");
});
it("applies at most one correctly framed impulse after each successful JSBSim step", () => {
    const { module, count } = setup(), b = new JsbsimBackend(module, "/models", "c172x", 1 / 400), out = truth(), controls = new Float64Array(4);
    const impulse = { impulseNed: new Float64Array(3), momentBodyNms: new Float64Array(3), dt: 1 / 400, integrationOwner: "jsbsim" as const };
    expect(b.applyContactImpulseInto(impulse, out)).toBe(false);
    expect(b.stepInto(controls, out)).toBe(true);
    expect(b.applyContactImpulseInto({ ...impulse, dt: 1 / 800 }, out)).toBe(false);
    impulse.impulseNed[0] = NaN;
    expect(b.applyContactImpulseInto(impulse, out)).toBe(false);
    impulse.impulseNed[0] = 0;
    expect(count()).toBe(0);
    expect(b.applyContactImpulseInto(impulse, out)).toBe(true);
    expect(b.applyContactImpulseInto(impulse, out)).toBe(false);
    expect(count()).toBe(1);
    b.dispose();
});
it("requires dedicated memory and faults on a measured allocation without publishing truth", () => {
    const { module, allocate } = setup(), b = new JsbsimBackend(module, "/models", "c172x", 1 / 400), out = truth(), controls = new Float64Array(4);
    expect(() => new JsbsimBackend(module, "/models", "c172x", 1 / 400)).toThrow("Invalid");
    expect(b.armHighRate()).toBe(false);
    expect(b.stepInto(controls, out)).toBe(true);
    module._jsb_contact_abi_version=()=>0;
    expect(b.armHighRate()).toBe(false);
    module._jsb_contact_abi_version=()=>1;
    expect(b.armHighRate()).toBe(true);
    expect(b.highRateCertified).toBe(true);
    out.positionNedM[0] = 123;
    allocate();
    expect(b.stepInto(controls, out)).toBe(false);
    expect(out.positionNedM[0]).toBe(123);
    expect(b.highRateCertified).toBe(false);
    b.dispose();
});
it("rejects output and input aliases into module-owned memory", () => {
    const { module } = setup(), b = new JsbsimBackend(module, "/models", "c172x", 1 / 400), out = truth();
    expect(b.stepInto(new Float64Array(module.HEAPU8.buffer, 0, 4), out)).toBe(false);
    expect(b.stepInto(new Float64Array(new SharedArrayBuffer(32)), out)).toBe(false);
    out.positionNedM = new Float64Array(module.HEAPU8.buffer, 0, 3);
    expect(b.stepInto(new Float64Array(4), out)).toBe(false);
    b.dispose();
});
