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
    /**
     * Brush-model cornering stiffness C_a, N/rad (TASK-095): while rolling, the side force is
     * C_a·tan(slip angle), capped at the lateral coefficient times the load. Omitted or 0: the
     * side force sticks up to that cap. A positive value writes contact configuration version 3.
     */
    readonly corneringStiffnessNpRad?: number;
    /**
     * Kinetic over static friction coefficient μ_k/μ_s in (0, 1] (TASK-095, decision F-08): a
     * sliding contact takes this fraction of its breakaway limit. Omitted or 1: one coefficient for
     * both. A value below 1 on any wheel writes contact configuration version 4.
     */
    readonly kineticFrictionRatio?: number;
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
    /** Gravity the native world applies, m/s² down; a flight model on this contact must use the same. */
    readonly gravityMps2 = 9.80665;
    /** Airframe plus unsprung wheel masses, kg (TASK-095). */
    readonly vehicleMassKg: number;
    /**
     * Airframe tensor plus each unsprung mass as a point at its wheel anchor, about the body
     * origin, body FRD, row-major (TASK-095); what a flight model on this contact must declare.
     */
    readonly vehicleInertiaKgM2 = new Float64Array(9);
    private readonly config: Float64Array;
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
    /**
     * A contact for a flight model's vehicle (TASK-095): `vehicle` gives the whole vehicle's
     * mass and inertia about its origin; the airframe gets them less each unsprung wheel mass,
     * taken as a point at its anchor. The unsprung masses then move the vehicle's centre of
     * mass by sum(m_w r_w)/M from the body origin; light gear keeps that small.
     */
    static async forVehicle(state: BodyTruth, vehicle: { readonly massKg: number; readonly inertiaBodyKgM2: readonly number[] },
        options: ContactOptions & { readonly hullRadiusM?: number; readonly restitution?: number; readonly friction?: number } = {}): Promise<GroundContact> {
        return Promise.resolve().then(() => this.forVehicleNow(state, vehicle, options));
    }
    /**
     * `forVehicle` without awaiting (TASK-095): a flight session builds its dynamics synchronously,
     * again at each physics-rate change, once `initialize` has compiled the artifact. Cold.
     */
    static forVehicleNow(state: BodyTruth, vehicle: { readonly massKg: number; readonly inertiaBodyKgM2: readonly number[] },
        options: ContactOptions & { readonly hullRadiusM?: number; readonly restitution?: number; readonly friction?: number } = {}): GroundContact {
        const wheels = options.wheels ?? [], inertia = vehicle.inertiaBodyKgM2;
        if (options.inertiaKgM2 || options.inertiaDiagonalKgM2 || inertia.length !== 9 || !inertia.every(Number.isFinite) ||
            !Number.isFinite(vehicle.massKg))
            throw new Error("Invalid vehicle mass properties");
        let mass = vehicle.massKg;
        const airframe = Array.from(inertia);
        for (const w of wheels) {
            const m = w.unsprungMassKg, r = w.anchorBodyM, r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
            mass -= m;
            for (let i = 0; i < 3; i++)
                for (let j = 0; j < 3; j++)
                    airframe[i * 3 + j] = airframe[i * 3 + j]! - m * ((i === j ? r2 : 0) - r[i]! * r[j]!);
        }
        // Symmetric by construction; keep it exactly symmetric for the native check.
        airframe[3] = airframe[1]!; airframe[6] = airframe[2]!; airframe[7] = airframe[5]!;
        if (!(mass > 0))
            throw new Error("Unsprung masses exceed the vehicle mass");
        return this.createNow(state, mass, options.hullRadiusM ?? 0.1, options.restitution ?? 0, options.friction ?? 0.7,
            { ...options, inertiaKgM2: airframe });
    }
    static async create(state: BodyTruth, mass = 1, radius = 0.1, restitution = 0, friction = 0.7, options: ContactOptions = {}): Promise<GroundContact> {
        return Promise.resolve().then(() => this.createNow(state, mass, radius, restitution, friction, options));
    }
    /** True once `initialize` has compiled the verified artifact, so contacts can be created. */
    static get ready(): boolean { return this.artifact !== undefined; }
    /** `create` without awaiting: instantiates the compiled artifact synchronously. Cold. */
    static createNow(state: BodyTruth, mass = 1, radius = 0.1, restitution = 0, friction = 0.7, options: ContactOptions = {}): GroundContact {
        if (!this.artifact)
            throw new Error("Initialize the verified contact artifact before creating a session");
        const instance = new WebAssembly.Instance(this.artifact, {});
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
        this.config = c;
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
            const cornering = w.corneringStiffnessNpRad ?? 0;
            if (!Number.isFinite(cornering) || cornering < 0)
                throw new Error("Invalid cornering stiffness");
            if (cornering > 0) {
                // Version 3 adds the wheel's cornering stiffness and keeps version 2's inertia slots.
                c[0] = 3;
                c[b + 28] = cornering;
            }
            for (let j = 0; j < w.tireLoadCurve.length; j++) {
                const p = w.tireLoadCurve[j];
                if (!p)
                    throw new Error("Missing tire knot");
                c[b + 32 + j] = p[0];
                c[b + 96 + j] = p[1];
            }
        }
        // Version 4 adds the kinetic friction ratio, which every wheel then states; with none below 1
        // the configuration keeps its earlier version bit for bit.
        const ratios = (options.wheels ?? []).map(w => w.kineticFrictionRatio ?? 1);
        if (ratios.some(r => !(r > 0 && r <= 1)))
            throw new Error("Invalid kinetic friction ratio");
        if (ratios.some(r => r < 1)) {
            c[0] = 4;
            ratios.forEach((r, i) => { c[32 + i * 160 + 29] = r; });
        }
        // The vehicle the contact integrates: airframe plus unsprung point masses at their anchors.
        const t = this.vehicleInertiaKgM2;
        t[0] = c[19]!; t[4] = c[20]!; t[8] = c[21]!;
        t[1] = t[3] = c[0] >= 2 ? c[28]! : 0; t[2] = t[6] = c[0] >= 2 ? c[29]! : 0; t[5] = t[7] = c[0] >= 2 ? c[30]! : 0;
        let vehicleMass = mass;
        for (let i = 0; i < this.wheelCount; i++) {
            const b = 32 + i * 160, m = c[b + 3]!, r0 = c[b]!, r1 = c[b + 1]!, r2 = c[b + 2]!, rr = r0 * r0 + r1 * r1 + r2 * r2, r = [r0, r1, r2];
            vehicleMass += m;
            for (let a = 0; a < 3; a++)
                for (let k = 0; k < 3; k++)
                    t[a * 3 + k] = t[a * 3 + k]! + m * ((a === k ? rr : 0) - r[a]! * r[k]!);
        }
        this.vehicleMassKg = vehicleMass;
        const result = module.contact_initialize();
        if (result !== 0)
            throw new Error("Contact initialization failed (" + result + ")");
    }
    /**
     * Restarts the session from `state` with the same configuration (TASK-095): cold, it
     * rebuilds the native world, so a flight model's reset never steps from a stale contact.
     */
    reset(state: BodyTruth): void {
        if (this.disposed || this.module.memory.buffer !== this.buffer || state.positionNedM.length !== 3 || state.velocityNedMps.length !== 3 ||
            state.quaternionBodyToNed.length !== 4 || state.angularVelocityBodyRadS.length !== 3)
            throw new Error("Invalid contact reset");
        const c = this.config;
        c.set(state.positionNedM, 6);
        c.set(state.velocityNedMps, 9);
        c.set(state.quaternionBodyToNed, 12);
        c.set(state.angularVelocityBodyRadS, 16);
        this.module.contact_dispose();
        const result = this.module.contact_initialize();
        this.status = result;
        this.lastDt = 0;
        if (result !== 0) {
            this.disposed = true;
            throw new Error("Contact initialization failed (" + result + ")");
        }
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
