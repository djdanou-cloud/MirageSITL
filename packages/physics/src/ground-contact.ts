import type { BodyTruth } from "@mirage/wasm-bet/backend";
import type { ContactBackend, ContactImpulse } from "./contact-backend";
interface Exports {
    memory: WebAssembly.Memory;
    contact_abi_version(): number;
    contact_config_ptr(): number;
    contact_input_ptr(): number;
    contact_output_ptr(): number;
    contact_initialize(): number;
    contact_step(): number;
    contact_dispose(): void;
    contact_allocation_calls(): number;
    contact_allocation_bytes(): number;
}
function exportsValid(v: WebAssembly.Exports): v is WebAssembly.Exports & Exports {
    return v.memory instanceof WebAssembly.Memory && ["contact_abi_version", "contact_config_ptr", "contact_input_ptr",
        "contact_output_ptr", "contact_initialize", "contact_step", "contact_dispose", "contact_allocation_calls",
        "contact_allocation_bytes"].every(name => typeof v[name] === "function");
}
function record(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
/** Contact ABI v2 input: v1's 16 values plus [nN, nE, nD, offsetM] for the airframe and 8 wheel slots. */
const PLANE_BASE = 16, PLANE_SLOTS = 9, INPUT_COUNT = PLANE_BASE + 4 * PLANE_SLOTS;
export interface LinearSuspension {
    readonly kind: "linear";
    readonly stiffnessNpm: number;
    readonly preloadN: number;
    readonly compressionDamping: number;
    readonly reboundDamping: number;
    readonly dampingLaw: "linear" | "square";
}
export interface GasSuspension {
    readonly kind: "gas";
    readonly gasAreaM2: number;
    readonly volumeM3: number;
    readonly chargeAbsolutePa: number;
    readonly ambientAbsolutePa: number;
    readonly exponent: number;
    readonly hydraulicAreaM2: number;
    readonly fluidDensityKgM3: number;
    readonly dischargeCoefficient: number;
    readonly compressionOrificeM2: number;
    readonly reboundOrificeM2: number;
}
export interface ContactWheel {
    /** Fully extended wheel center relative to CG, body FRD metres. */
    readonly anchorBodyM: readonly [
        number,
        number,
        number
    ];
    readonly unsprungMassKg: number;
    readonly tireRadiusM: number;
    readonly rimRadiusM: number;
    readonly strutTravelM: number;
    readonly suspension: LinearSuspension | GasSuspension;
    readonly tireLoadCurve: readonly (readonly [
        number,
        number
    ])[];
    readonly tireDampingNsPm: number;
    readonly rollingCoefficient: number;
    readonly lateralCoefficient: number;
    readonly brakingCoefficient: number;
}
export interface ContactOptions {
    readonly inertiaDiagonalKgM2?: readonly [
        number,
        number,
        number
    ];
    /**
     * Full symmetric inertia tensor about the CG, body FRD, row-major (TASK-094). With non-zero
     * products the contact uses configuration version 2; it replaces `inertiaDiagonalKgM2`.
     */
    readonly inertiaKgM2?: readonly number[];
    readonly groundNormalNed?: readonly [
        number,
        number,
        number
    ];
    readonly groundOffsetM?: number;
    readonly wheels?: readonly ContactWheel[];
}
/** Isolated fixed-topology f64 Rapier world. Prismatic strut stops, separate tire
 * compliance, one integration owner. Rolling is kinematic; no wheel-spin model.
 * Allocation during step faults the instance rather than granting admission.
 */
export class GroundContact implements ContactBackend {
    private static artifact: WebAssembly.Module | undefined;
    readonly integrationOwner = "rapier" as const;
    readonly highRateCertified = true;
    private readonly buffer: ArrayBuffer;
    private readonly heap: Float64Array;
    private readonly input: number;
    private readonly output: number;
    private disposed = false;
    private lastDt = 0;
    private status = 0;
    readonly wheelCount: number;
    /** Cold host setup from build manifest plus actual bytes; no step-time I/O. */
    static async initialize(bytes: Uint8Array<ArrayBuffer>, manifest: unknown): Promise<void> {
        if (!record(manifest) || manifest.schemaVersion !== 1 || manifest.abiVersion !== 2 || manifest.precision !== "f64" ||
            manifest.sourceCommit !== "b716d375efc0201003f0cd9ef7168eee0b62c177" || manifest.engineVersion !== "0.36.0" ||
            manifest.memoryBytes !== 16777216 || manifest.bytes !== bytes.byteLength || typeof manifest.sha256 !== "string")
            throw new Error("Invalid contact artifact manifest");
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        if (Array.from(digest, b => b.toString(16).padStart(2, "0")).join("") !== manifest.sha256)
            throw new Error("Contact artifact checksum mismatch");
        const compiled = await WebAssembly.compile(bytes);
        if (WebAssembly.Module.imports(compiled).length !== 0)
            throw new Error("Contact artifact has host imports");
        this.artifact = compiled;
    }
    static async create(state: BodyTruth, mass = 1, radius = 0.1, restitution = 0, friction = 0.7, options: ContactOptions = {}): Promise<GroundContact> {
        if (!this.artifact)
            throw new Error("Initialize the verified contact artifact before creating a session");
        const instance = await WebAssembly.instantiate(this.artifact, {});
        if (!exportsValid(instance.exports) || instance.exports.contact_abi_version() !== 2)
            throw new Error("Invalid contact ABI exports");
        return new GroundContact(instance.exports, state, mass, radius, restitution, friction, options);
    }
    private constructor(private readonly module: Exports, state: BodyTruth, mass: number, radius: number, restitution: number, friction: number, options: ContactOptions) {
        const memory = module.memory.buffer;
        if (!(memory instanceof ArrayBuffer) || memory.byteLength !== 16777216)
            throw new Error("Invalid contact memory");
        this.buffer = memory;
        this.heap = new Float64Array(memory);
        const config = module.contact_config_ptr(), input = module.contact_input_ptr(), output = module.contact_output_ptr();
        const regions: readonly (readonly [
            number,
            number
        ])[] = [[config, 1312 * 8], [input, INPUT_COUNT * 8], [output, 96 * 8]];
        for (let i = 0; i < regions.length; i++) {
            const a = regions[i];
            if (!a)
                throw new Error("Missing contact region");
            if (!Number.isSafeInteger(a[0]) || a[0] <= 0 || a[0] % 8 !== 0 || a[0] + a[1] > memory.byteLength)
                throw new Error("Invalid contact region");
            for (let j = 0; j < i; j++) {
                const b = regions[j];
                if (b && a[0] < b[0] + b[1] && b[0] < a[0] + a[1])
                    throw new Error("Overlapping contact regions");
            }
        }
        this.input = input / 8;
        this.output = output / 8;
        this.wheelCount = options.wheels?.length ?? 0;
        if (this.wheelCount > 8 || state.positionNedM.length !== 3 || state.velocityNedMps.length !== 3 ||
            state.quaternionBodyToNed.length !== 4 || state.angularVelocityBodyRadS.length !== 3)
            throw new Error("Invalid contact configuration");
        const c = new Float64Array(memory, config, 1312);
        c.fill(0);
        c[0] = 1;
        c[2] = mass;
        c[3] = radius;
        c[4] = restitution;
        c[5] = friction;
        c.set(state.positionNedM, 6);
        c.set(state.velocityNedMps, 9);
        c.set(state.quaternionBodyToNed, 12);
        c.set(state.angularVelocityBodyRadS, 16);
        const inertia = 0.4 * mass * radius * radius;
        const tensor = options.inertiaKgM2;
        if (tensor) {
            if (options.inertiaDiagonalKgM2 || tensor.length !== 9 || !tensor.every(Number.isFinite) ||
                tensor[1] !== tensor[3] || tensor[2] !== tensor[6] || tensor[5] !== tensor[7])
                throw new Error("Invalid contact inertia tensor");
            c.set([tensor[0]!, tensor[4]!, tensor[8]!], 19);
            // Version 2 only when a product of inertia is non-zero; a diagonal tensor stays version 1 bit for bit.
            if (tensor[1] !== 0 || tensor[2] !== 0 || tensor[5] !== 0) {
                c[0] = 2;
                c[28] = tensor[1]!;
                c[29] = tensor[2]!;
                c[30] = tensor[5]!;
            }
        }
        else
            c.set(options.inertiaDiagonalKgM2 ?? [inertia, inertia, inertia], 19);
        c.set(options.groundNormalNed ?? [0, 0, -1], 22);
        c[25] = options.groundOffsetM ?? 0;
        c[26] = 9.80665;
        c[27] = this.wheelCount;
        for (let i = 0; i < this.wheelCount; i++) {
            const w = options.wheels?.[i];
            if (!w || w.tireLoadCurve.length < 2 || w.tireLoadCurve.length > 64)
                throw new Error("Invalid tire curve");
            const b = 32 + i * 160;
            c.set(w.anchorBodyM, b);
            c[b + 3] = w.unsprungMassKg;
            c[b + 4] = w.tireRadiusM;
            c[b + 5] = w.rimRadiusM;
            c[b + 6] = w.strutTravelM;
            const s = w.suspension;
            if (s.kind === "linear") {
                c[b + 8] = s.stiffnessNpm;
                c[b + 9] = s.preloadN;
                c[b + 10] = s.compressionDamping;
                c[b + 11] = s.reboundDamping;
                c[b + 12] = s.dampingLaw === "square" ? 1 : 0;
            }
            else {
                c[b + 7] = 1;
                c.set([s.gasAreaM2, s.volumeM3, s.chargeAbsolutePa, s.ambientAbsolutePa, s.exponent, s.hydraulicAreaM2,
                    s.fluidDensityKgM3, s.dischargeCoefficient, s.compressionOrificeM2, s.reboundOrificeM2], b + 18);
            }
            c[b + 13] = w.rollingCoefficient;
            c[b + 14] = w.lateralCoefficient;
            c[b + 15] = w.brakingCoefficient;
            c[b + 16] = w.tireDampingNsPm;
            c[b + 17] = w.tireLoadCurve.length;
            for (let j = 0; j < w.tireLoadCurve.length; j++) {
                const p = w.tireLoadCurve[j];
                if (!p)
                    throw new Error("Missing tire knot");
                c[b + 32 + j] = p[0];
                c[b + 96 + j] = p[1];
            }
        }
        const result = module.contact_initialize();
        if (result !== 0)
            throw new Error("Contact initialization failed (" + result + ")");
    }
    get lastStatus(): number { return this.status; }
    get allocationCalls(): number { return this.module.contact_allocation_calls(); }
    get allocationBytes(): number { return this.module.contact_allocation_bytes(); }
    /** groundPlanes (ABI v2): 4 * (1 + wheelCount) values [nN, nE, nD, offsetM] for the airframe
     * sphere then each wheel, unit normals facing up (nD < 0), height above plane = n.x - offset.
     * Omitted: every contact uses the configured plane. */
    stepInto(w: Float64Array, dt: number, out: BodyTruth, brakes?: Float64Array, groundPlanes?: Float64Array): boolean {
        if (this.disposed || this.module.memory.buffer !== this.buffer || w.length !== 6 ||
            (dt !== 1 / 400 && dt !== 1 / 800 && dt !== 1 / 1200) || out.positionNedM.length !== 3 || out.velocityNedMps.length !== 3 ||
            out.quaternionBodyToNed.length !== 4 || out.angularVelocityBodyRadS.length !== 3 || out.accelerationNedMps2.length !== 3 ||
            out.positionNedM.buffer === this.buffer || out.velocityNedMps.buffer === this.buffer || out.quaternionBodyToNed.buffer === this.buffer ||
            out.angularVelocityBodyRadS.buffer === this.buffer || out.accelerationNedMps2.buffer === this.buffer || (brakes && brakes.length !== this.wheelCount) ||
            (groundPlanes && (groundPlanes.length !== 4 * (1 + this.wheelCount) || groundPlanes.buffer === this.buffer)))
            return false;
        for (let i = 0; i < 6; i++)
            if (!Number.isFinite(w[i]))
                return false;
        for (let i = 0; i < this.wheelCount; i++)
            if (brakes && (!Number.isFinite(brakes[i]) || brakes[i]! < 0 || brakes[i]! > 1))
                return false;
        const h = this.heap, input = this.input, o = this.output;
        for (let i = 0; i < 6; i++)
            h[input + i] = w[i]!;
        for (let i = 0; i < 8; i++)
            h[input + 6 + i] = brakes?.[i] ?? 0;
        h[input + 14] = dt;
        h[input + 15] = groundPlanes ? 1 : 0;
        // The native step validates plane values; unused slots stay zero.
        for (let i = 0; i < 4 * PLANE_SLOTS; i++)
            h[input + PLANE_BASE + i] = groundPlanes && i < groundPlanes.length ? groundPlanes[i]! : 0;
        this.status = this.module.contact_step();
        if (this.status !== 0 || this.module.memory.buffer !== this.buffer)
            return false;
        for (let i = 0; i < 3; i++) {
            out.positionNedM[i] = h[o + i]!;
            out.velocityNedMps[i] = h[o + 3 + i]!;
            out.angularVelocityBodyRadS[i] = h[o + 10 + i]!;
            out.accelerationNedMps2[i] = h[o + 13 + i]!;
        }
        for (let i = 0; i < 4; i++)
            out.quaternionBodyToNed[i] = h[o + 6 + i]!;
        this.lastDt = dt;
        return true;
    }
    impulseInto(out: ContactImpulse): void {
        for (let i = 0; i < 3; i++) {
            out.impulseNed[i] = this.heap[this.output + 16 + i]!;
            out.pointBody[i] = this.heap[this.output + 22 + i]!;
            if (out.momentBodyNms)
                out.momentBodyNms[i] = this.heap[this.output + 19 + i]!;
        }
        out.dt = this.lastDt;
    }
    /** compression m, tire deflection m, tire force N, strut force N, rim-overlap
     * diagnostic m, raw strut compression m, wheel-plane distance m, reserved.
     * Raw values expose solver overlap instead of hiding it behind force limits. */
    wheelStateInto(index: number, out: Float64Array): boolean {
        if (this.disposed || !Number.isInteger(index) || index < 0 || index >= this.wheelCount || out.length !== 8 || out.buffer === this.buffer)
            return false;
        for (let i = 0; i < 8; i++)
            out[i] = this.heap[this.output + 32 + index * 8 + i]!;
        return true;
    }
    dispose(): void { if (!this.disposed) {
        this.disposed = true;
        this.module.contact_dispose();
    } }
}
