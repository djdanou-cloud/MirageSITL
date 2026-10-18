import type { BodyTruth } from "@mirage/wasm-bet/backend";
/** Adapter requires an already checksum-verified Emscripten module and reviewed
 * model assets. It cannot claim readiness from a manifest or timer alone.
 */
export interface JsbsimModule {
    HEAPU8: Uint8Array;
    HEAPF64: Float64Array;
    _malloc(bytes: number): number;
    _free(pointer: number): void;
    _jsb_abi_version(): number;
    _jsb_create(root: number, model: number, dt: number): number;
    _jsb_step(handle: number, input: number, inputCount: number, out: number, outCount: number): number;
    _jsb_dispose(handle: number): void;
    _jsb_trim?(handle: number, controls: number, count: number): number;
    _jsb_contact_abi_version?(): number;
    _jsb_apply_contact?(handle: number, impulse: number, count: number, out: number, outCount: number): number;
    _jsb_mass_properties?(handle: number, out: number, count: number): number;
    _jsb_set_initial_state?(handle: number, input: number, count: number): number;
    _jsb_allocator_probe?(): number;
    _jsb_allocation_track?(enabled: number): void;
    _jsb_allocation_calls?(): number;
    _jsb_allocation_bytes?(): number;
}
export interface JsbsimTruth extends BodyTruth {
    specificForceBodyMps2: Float64Array;
    timeS: number;
    altitudeAslM: number;
}
export const JSBSIM_ABI = {
    version: 1,
    inputCount: 4,
    outputCount: 22,
    feetToMetres: 0.3048,
} as const;
export interface JsbsimContactImpulse {
    readonly impulseNed: Float64Array;
    readonly momentBodyNms: Float64Array;
    readonly dt: number;
    /** Must be solved without advancing the JSBSim aircraft in another engine. */
    readonly integrationOwner: "jsbsim";
}
const ownedMemories = new WeakSet<ArrayBufferLike>();
/** Single integration owner; optional contact ABI v1 never advances pose/time. */
export class JsbsimBackend {
    readonly integrationOwner = "jsbsim" as const;
    private armed = false;
    private faulted = false;
    get highRateCertified(): boolean { return this.armed && !this.faulted && !this.disposed; }
    get allocationCalls(): number { return this.module._jsb_allocation_calls?.() ?? NaN; }
    get allocationBytes(): number { return this.module._jsb_allocation_bytes?.() ?? NaN; }
    private handle = 0;
    private input = 0;
    private output = 0;
    private contact = 0;
    private contactPending = false;
    private readonly buffer: ArrayBufferLike;
    private disposed = false;
    private stepped = false;
    constructor(private readonly module: JsbsimModule, root: string, model: string, readonly dt: number) {
        if (module.HEAPU8.byteOffset !== 0 ||
            module.HEAPF64.byteOffset !== 0 ||
            module.HEAPU8.buffer !== module.HEAPF64.buffer ||
            module.HEAPU8.byteLength !== module.HEAPF64.byteLength ||
            !(module.HEAPU8.buffer instanceof ArrayBuffer) ||
            ownedMemories.has(module.HEAPU8.buffer) ||
            module._jsb_abi_version() !== 1 ||
            !/^\/[A-Za-z0-9_/-]{1,200}$/.test(root) ||
            root.includes("..") ||
            !/^[A-Za-z0-9_-]{1,64}$/.test(model) ||
            ![1 / 400, 1 / 800, 1 / 1200].includes(dt))
            throw new Error("Invalid JSBSim configuration");
        const encoder = new TextEncoder(), rootBytes = encoder.encode(root + "\0"), modelBytes = encoder.encode(model + "\0");
        let rp = 0, mp = 0;
        try {
            rp = module._malloc(rootBytes.length);
            mp = module._malloc(modelBytes.length);
            if (!rp || !mp)
                throw new Error("JSBSim string allocation failed");
            module.HEAPU8.set(rootBytes, rp);
            module.HEAPU8.set(modelBytes, mp);
            this.handle = module._jsb_create(rp, mp, dt);
            if (!this.handle)
                throw new Error("JSBSim failed to load reviewed aircraft assets");
        }
        finally {
            if (rp)
                module._free(rp);
            if (mp)
                module._free(mp);
        }
        this.input = module._malloc(32);
        this.output = module._malloc(176);
        this.contact = module._malloc(104);
        const bytes = module.HEAPU8.byteLength;
        if (!Number.isSafeInteger(this.input) ||
            !Number.isSafeInteger(this.output) ||
            this.input <= 0 ||
            this.output <= 0 ||
            this.input % 8 !== 0 ||
            this.output % 8 !== 0 ||
            this.input + 32 > bytes ||
            this.output + 176 > bytes ||
            (this.input < this.output + 176 && this.output < this.input + 32)
            || !Number.isSafeInteger(this.contact) || this.contact <= 0 || this.contact % 8 !== 0
            || this.contact + 104 > bytes || (this.contact < this.output + 176 && this.output < this.contact + 104)
            || (this.contact < this.input + 32 && this.input < this.contact + 104)) {
            this.dispose();
            throw new Error("JSBSim frame allocation failed");
        }
        this.buffer = module.HEAPU8.buffer;
        ownedMemories.add(this.buffer);
        if (module._jsb_allocator_probe && module._jsb_allocator_probe() !== 1) {
            this.dispose();
            throw new Error("JSBSim allocator instrumentation failed");
        }
    }
    /** Arm after cold setup/warmup. Any subsequent module allocation faults the
     * backend. Actual native/WASM and JS GC gates remain required evidence. */
    armHighRate(): boolean {
        const m = this.module;
        if (this.disposed || this.faulted || !this.stepped || m._jsb_contact_abi_version?.() !== 1 || !m._jsb_allocation_track || !m._jsb_allocation_calls || !m._jsb_allocation_bytes ||
            m._jsb_allocation_calls() !== 0 || m._jsb_allocation_bytes() !== 0)
            return false;
        m._jsb_allocation_track(1);
        this.armed = true;
        return true;
    }
    /** Cold explicit SI initial state: lat/lon rad, ASL m, Euler rad, body
     * velocity m/s, body rates rad/s, terrain ASL m. Forbidden after stepping. */
    initializeState(initial: Float64Array): boolean {
        if (this.disposed || this.faulted || this.stepped || !this.heapValid() || initial.length !== 13 || !(initial.buffer instanceof ArrayBuffer) || initial.buffer === this.buffer || !this.module._jsb_set_initial_state)
            return false;
        for (let i = 0; i < 13; i++)
            if (!Number.isFinite(initial[i]))
                return false;
        for (let i = 0; i < 13; i++)
            this.module.HEAPF64[this.contact / 8 + i] = initial[i]!;
        return this.module._jsb_set_initial_state(this.handle, this.contact, 13) === 0 && this.heapValid();
    }
    private heapValid(): boolean {
        const m = this.module;
        return m.HEAPU8.buffer === this.buffer && m.HEAPF64.buffer === this.buffer &&
            m.HEAPU8.byteOffset === 0 && m.HEAPF64.byteOffset === 0 && m.HEAPU8.byteLength === this.buffer.byteLength && m.HEAPF64.byteLength === this.buffer.byteLength;
    }
    private outputValid(out: JsbsimTruth): boolean {
        return out.positionNedM.length === 3 && out.velocityNedMps.length === 3 && out.quaternionBodyToNed.length === 4 &&
            out.angularVelocityBodyRadS.length === 3 && out.accelerationNedMps2.length === 3 && out.specificForceBodyMps2.length === 3 &&
            out.positionNedM.buffer instanceof ArrayBuffer && out.velocityNedMps.buffer instanceof ArrayBuffer && out.quaternionBodyToNed.buffer instanceof ArrayBuffer &&
            out.angularVelocityBodyRadS.buffer instanceof ArrayBuffer && out.accelerationNedMps2.buffer instanceof ArrayBuffer && out.specificForceBodyMps2.buffer instanceof ArrayBuffer &&
            out.positionNedM.buffer !== this.buffer && out.velocityNedMps.buffer !== this.buffer && out.quaternionBodyToNed.buffer !== this.buffer &&
            out.angularVelocityBodyRadS.buffer !== this.buffer && out.accelerationNedMps2.buffer !== this.buffer && out.specificForceBodyMps2.buffer !== this.buffer;
    }
    private allocationValid(): boolean {
        if (this.armed && (this.allocationCalls !== 0 || this.allocationBytes !== 0)) {
            this.faulted = true;
            return false;
        }
        return true;
    }
    /** Cold setup only: upstream trimming may allocate. The body origin resets on success. */
    trimInto(controls: Float64Array): boolean {
        if (this.disposed ||
            this.stepped ||
            this.armed ||
            controls.length !== 4 ||
            !(controls.buffer instanceof ArrayBuffer) || controls.buffer === this.buffer ||
            this.module.HEAPU8.buffer !== this.buffer ||
            !this.module._jsb_trim)
            return false;
        if (this.module._jsb_trim(this.handle, this.input, 4) !== 0 ||
            this.module.HEAPU8.buffer !== this.buffer)
            return false;
        const start = this.input / 8, heap = this.module.HEAPF64;
        for (let i = 0; i < 4; i++)
            if (!Number.isFinite(heap[start + i]) ||
                heap[start + i]! < (i === 0 ? 0 : -1) ||
                heap[start + i]! > 1)
                return false;
        for (let i = 0; i < 4; i++)
            controls[i] = heap[start + i]!;
        return true;
    }
    stepInto(controls: Float64Array, out: JsbsimTruth): boolean {
        if (out.positionNedM.length !== 3 ||
            out.velocityNedMps.length !== 3 ||
            out.quaternionBodyToNed.length !== 4 ||
            out.angularVelocityBodyRadS.length !== 3 ||
            out.accelerationNedMps2.length !== 3 ||
            out.specificForceBodyMps2.length !== 3 ||
            this.disposed ||
            this.faulted || !this.heapValid() || !this.outputValid(out) ||
            !this.handle ||
            this.module.HEAPU8.buffer !== this.buffer ||
            controls.length !== 4
            || !(controls.buffer instanceof ArrayBuffer) || controls.buffer === this.buffer)
            return false;
        for (let i = 0; i < 4; i++)
            if (!Number.isFinite(controls[i]) ||
                controls[i]! < (i === 0 ? 0 : -1) ||
                controls[i]! > 1)
                return false;
        this.stepped = true;
        const heap = this.module.HEAPF64, start = this.input / 8;
        for (let i = 0; i < 4; i++)
            heap[start + i] = controls[i]!;
        const status = this.module._jsb_step(this.handle, this.input, 4, this.output, 22);
        if (status !== 0) {
            if (status !== -1 && status !== -2 && status !== -5)
                this.faulted = true;
            return false;
        }
        if (!this.heapValid() || !this.allocationValid())
            return false;
        this.contactPending = true;
        return this.copyOutput(out);
    }
    private copyOutput(out: JsbsimTruth): boolean {
        const heap = this.module.HEAPF64, offset = this.output / 8;
        for (let i = 0; i < 22; i++)
            if (!Number.isFinite(heap[offset + i]))
                return false;
        for (let i = 0; i < 3; i++) {
            out.positionNedM[i] = heap[offset + i]!;
            out.velocityNedMps[i] = heap[offset + 3 + i]!;
            out.angularVelocityBodyRadS[i] = heap[offset + 10 + i]!;
            out.specificForceBodyMps2[i] = heap[offset + 13 + i]!;
            out.accelerationNedMps2[i] = heap[offset + 19 + i]!;
        }
        for (let i = 0; i < 4; i++)
            out.quaternionBodyToNed[i] = heap[offset + 6 + i]!;
        out.timeS = heap[offset + 16]!;
        out.altitudeAslM = heap[offset + 17]!;
        return true;
    }
    massPropertiesInto(out: Float64Array): boolean {
        if (this.disposed || this.faulted || !this.heapValid() || out.length !== 10 || !(out.buffer instanceof ArrayBuffer) || out.buffer === this.buffer || !this.module._jsb_mass_properties)
            return false;
        if (this.module._jsb_mass_properties(this.handle, this.contact, 10) !== 0 || !this.heapValid() || !this.allocationValid())
            return false;
        for (let i = 0; i < 10; i++)
            if (!Number.isFinite(this.module.HEAPF64[this.contact / 8 + i]))
                return false;
        for (let i = 0; i < 10; i++)
            out[i] = this.module.HEAPF64[this.contact / 8 + i]!;
        return true;
    }
    applyContactImpulseInto(impulse: JsbsimContactImpulse, out: JsbsimTruth): boolean {
        const m = this.module;
        if (this.disposed || this.faulted || !this.contactPending || !this.heapValid() || !this.outputValid(out) ||
            impulse.integrationOwner !== "jsbsim" || impulse.dt !== this.dt || impulse.impulseNed.length !== 3 || impulse.momentBodyNms.length !== 3 ||
            impulse.impulseNed.buffer === this.buffer || impulse.momentBodyNms.buffer === this.buffer ||
            !(impulse.impulseNed.buffer instanceof ArrayBuffer) || !(impulse.momentBodyNms.buffer instanceof ArrayBuffer) ||
            !m._jsb_apply_contact || m._jsb_contact_abi_version?.() !== 1)
            return false;
        for (let i = 0; i < 3; i++)
            if (!Number.isFinite(impulse.impulseNed[i]) || !Number.isFinite(impulse.momentBodyNms[i]))
                return false;
        for (let i = 0; i < 3; i++) {
            m.HEAPF64[this.contact / 8 + i] = impulse.impulseNed[i]!;
            m.HEAPF64[this.contact / 8 + 3 + i] = impulse.momentBodyNms[i]!;
        }
        const status = m._jsb_apply_contact(this.handle, this.contact, 6, this.output, 22);
        if (status !== 0) {
            if (status !== -1 && status !== -2 && status !== -5)
                this.faulted = true;
            return false;
        }
        this.contactPending = false;
        return this.heapValid() && this.allocationValid() && this.copyOutput(out);
    }
    dispose(): void {
        if (this.disposed)
            return;
        this.disposed = true;
        this.module._jsb_allocation_track?.(0);
        ownedMemories.delete(this.buffer);
        if (this.handle) {
            this.module._jsb_dispose(this.handle);
            this.handle = 0;
        }
        if (this.input)
            this.module._free(this.input);
        if (this.output)
            this.module._free(this.output);
        if (this.contact)
            this.module._free(this.contact);
    }
}
