// Rotor wakes (TASK-101): what one rotor's slipstream does to another rotor and to the airframe, one way and with no swirl.
// It generalizes the coaxial reference of native/bet/src/coaxial.rs to any pair, climb and transverse flow: a straight top-hat
// tube from the actuator disk's far wake, spreading by entrainment. A synthetic model, not measured. Numbers from a rotor's
// last step reach the others on this one, which is the one-step lag; nothing flows back upstream, so the pairs need no order.
//
// All of it is closed forms in a preallocated table: `step` allocates nothing.

/**
 * Growth of the tube's radius per metre along it. A turbulent round jet's half-width grows about 0.1 per metre (Pope, Turbulent
 * Flows, 2000); a top hat with a Gaussian jet's mass and momentum flux has a radius sqrt(2/ln 2) times the half-width.
 */
export const WAKE_SPREAD_SLOPE = 0.1 * Math.sqrt(2 / Math.LN2);
/** The arm across the wake: a subcritical circular cylinder (TASK-096's `STANDARD_HULL_DRAG`, an upper estimate). */
export const WASHED_ARM_DRAG_COEFFICIENT = 1.2;
/** The body end-on to the wake: a flat disk or blunt cylinder end (TASK-096's `STANDARD_HULL_DRAG`). */
export const WASHED_BODY_DRAG_COEFFICIENT = 1.17;

const CHORDS = 16;
const CHORD_SIN = new Float64Array(CHORDS);
const CHORD_WEIGHT = new Float64Array(CHORDS);
// Gauss-Legendre nodes on [-1, 1], mapped to an angle so a chord integral's square-root ends become smooth.
for (let i = 0; i < CHORDS; i++) {
  let x = Math.cos(Math.PI * (i + 0.75) / (CHORDS + 0.5)), slope = 1;
  for (let iteration = 0; iteration < 32; iteration++) {
    let previous = 1, value = x;
    for (let j = 2; j <= CHORDS; j++) { const next = ((2 * j - 1) * x * value - (j - 1) * previous) / j; previous = value; value = next; }
    slope = CHORDS * (x * value - previous) / (x * x - 1);
    const change = value / slope;
    x -= change;
    if (Math.abs(change) < 1e-15) break;
  }
  const angle = x * Math.PI / 2;
  CHORD_SIN[i] = Math.sin(angle);
  CHORD_WEIGHT[i] = Math.PI * Math.cos(angle) / ((1 - x * x) * slope * slope);
}

/** The speed e >= 0 with `e sqrt(across^2 + (axial + e)^2) = load`: Glauert's momentum balance. `axial` >= 0. Newton from above, on a convex function. */
export function wakeMomentumRoot(load: number, axial: number, across: number): number {
  if (!(load > 0)) return 0;
  let e = Math.sqrt(load);
  for (let i = 0; i < 24; i++) {
    const along = axial + e, total = Math.sqrt(across * across + along * along), next = e - (e * total - load) / (total + e * along / total);
    if (!(next < e)) break;
    e = next;
  }
  return e;
}

/**
 * The fraction of an ellipse inside a circle at the origin. `majorM` and `minorM` are its semi-axes, `offsetMajorM` and `offsetMinorM`
 * where its centre is along them. Chords across the major axis, integrated over the range where both shapes exist: a shape that holds
 * the other is integrated to rounding, and a partial overlap within about 0.5 % of the disk.
 */
export function wakeCoverage(circleM: number, majorM: number, minorM: number, offsetMajorM: number, offsetMinorM: number): number {
  const low = Math.max(-majorM, -circleM - offsetMajorM), high = Math.min(majorM, circleM - offsetMajorM);
  if (!(high > low)) return 0;
  const middle = (low + high) / 2, half = (high - low) / 2;
  let sum = 0;
  for (let k = 0; k < CHORDS; k++) {
    const y = middle + half * CHORD_SIN[k]!, u = y / majorM, across = offsetMajorM + y;
    const ellipse = minorM * Math.sqrt(Math.max(0, 1 - u * u)), circle = Math.sqrt(Math.max(0, circleM * circleM - across * across));
    const overlap = Math.min(offsetMinorM + ellipse, circle) - Math.max(offsetMinorM - ellipse, -circle);
    if (overlap > 0) sum += overlap * CHORD_WEIGHT[k]!;
  }
  return Math.min(1, sum * half / (Math.PI * majorM * minorM));
}

export interface RotorWakeGeometry {
  /** Hub positions from one point, body axes, 3 per rotor, m. */
  readonly hubPositionsBodyM: Float64Array;
  /** Hub to body rotations, row-major, 9 per rotor. Hub z is the thrust axis. */
  readonly hubToBody: Float64Array;
  readonly radiiM: Float64Array;
}
export interface RotorWakeConfiguration {
  /** Ordered [source, receiver] rotor indices, or every ordered pair. They run sorted, so the order given changes nothing. */
  readonly pairs: 'all' | readonly (readonly [number, number])[];
  /** Default `WAKE_SPREAD_SLOPE`. */
  readonly spreadSlope?: number;
  /** C_D A of the airframe in each rotor's wake, m². Without it there is no download. */
  readonly washedDragAreaM2?: readonly number[];
}

/** Descent over the induced velocity where the vortex ring state begins (Johnson, NASA TP-2005-213477, table 4: his D). */
const WAKE_DESCENT_LIMIT = 0.2;
/** Below this cosine a receiver is edge-on to the tube. */
const MIN_FACING = 1e-6;

/** The wakes of `n` rotors. The caller fills the inputs, calls `step`, and reads the outputs. */
export class RotorWakeCoupler {
  readonly rotorCount: number;
  /** Inputs: each rotor's air minus hub velocity with what it receives, hub axes, m/s; air density; the thrust it last gave. */
  readonly airHubMps: Float64Array;
  readonly densityKgM3: Float64Array;
  readonly thrustN: Float64Array;
  /** Outputs: the area-averaged velocity each rotor receives, hub axes, m/s, and the download its own wake puts on the airframe, N. */
  readonly wakeHubMps: Float64Array;
  readonly downloadN: Float64Array;
  /** A rotor gives thrust while descending through its disk beyond Johnson's boundary D, where this momentum balance does not hold. */
  outsideValidity = false;
  readonly pairCount: number;
  private readonly radii: Float64Array;
  private readonly spread: number;
  private readonly washed: Float64Array;
  private readonly sources: Uint8Array;
  private readonly receivers: Uint8Array;
  /** Per pair, 3 each: the receiver's hub from the source's, its axis, both in source hub axes; the source's axis in receiver hub axes. */
  private readonly offsets: Float64Array;
  private readonly normals: Float64Array;
  private readonly axes: Float64Array;
  /** Per source, this step: the tube's direction, its radius at the far wake, the flow it runs in, what it carries. */
  private readonly active: Uint8Array;
  private readonly directions: Float64Array;
  private readonly launchRadii: Float64Array;
  private readonly axial: Float64Array;
  private readonly across: Float64Array;
  private readonly carried: Float64Array;
  /** The induced velocity at the disk, m/s, from the actuator-disk balance: half the far wake's excess speed. */
  readonly inducedMps: Float64Array;

  constructor(geometry: RotorWakeGeometry, configuration: RotorWakeConfiguration) {
    const n = geometry.radiiM.length;
    if (n < 1 || n > 32 || geometry.hubPositionsBodyM.length !== 3 * n || geometry.hubToBody.length !== 9 * n) throw new Error('Rotor wake geometry does not match its rotor count');
    for (let i = 0; i < n; i++) if (!(geometry.radiiM[i]! > 0)) throw new Error('Rotor wake radius must be positive');
    const spread = configuration.spreadSlope ?? WAKE_SPREAD_SLOPE, washed = configuration.washedDragAreaM2;
    if (!(spread >= 0) || !Number.isFinite(spread)) throw new Error('Rotor wake spread must be finite and not negative');
    if (washed && (washed.length !== n || washed.some((area, i) => !(area >= 0) || !(area < Math.PI * geometry.radiiM[i]! * geometry.radiiM[i]!)))) {
      throw new Error('A washed drag area must be below its rotor disk, one per rotor');
    }
    const listed: [number, number][] = [];
    if (configuration.pairs === 'all') {
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) listed.push([i, j]);
    } else {
      const seen = new Set<number>();
      for (const [i, j] of configuration.pairs) {
        if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= n || j >= n || i === j) throw new Error('A rotor wake pair names no two rotors');
        if (seen.has(i * 32 + j)) throw new Error('Duplicate rotor wake pair');
        seen.add(i * 32 + j);
        listed.push([i, j]);
      }
      listed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    }
    const count = listed.length, r = geometry.hubToBody, p = geometry.hubPositionsBodyM;
    this.rotorCount = n; this.pairCount = count; this.radii = Float64Array.from(geometry.radiiM); this.spread = spread;
    this.washed = washed ? Float64Array.from(washed) : new Float64Array(n);
    this.airHubMps = new Float64Array(3 * n); this.densityKgM3 = new Float64Array(n); this.thrustN = new Float64Array(n);
    this.wakeHubMps = new Float64Array(3 * n); this.downloadN = new Float64Array(n);
    this.sources = new Uint8Array(count); this.receivers = new Uint8Array(count);
    this.offsets = new Float64Array(3 * count); this.normals = new Float64Array(3 * count); this.axes = new Float64Array(3 * count);
    this.active = new Uint8Array(n); this.directions = new Float64Array(3 * n); this.launchRadii = new Float64Array(n);
    this.axial = new Float64Array(n); this.across = new Float64Array(n); this.carried = new Float64Array(n); this.inducedMps = new Float64Array(n);
    listed.forEach(([i, j], k) => {
      const a = i * 9, b = j * 9, dx = p[j * 3]! - p[i * 3]!, dy = p[j * 3 + 1]! - p[i * 3 + 1]!, dz = p[j * 3 + 2]! - p[i * 3 + 2]!;
      this.sources[k] = i; this.receivers[k] = j;
      this.offsets[3 * k] = r[a]! * dx + r[a + 3]! * dy + r[a + 6]! * dz;
      this.offsets[3 * k + 1] = r[a + 1]! * dx + r[a + 4]! * dy + r[a + 7]! * dz;
      this.offsets[3 * k + 2] = r[a + 2]! * dx + r[a + 5]! * dy + r[a + 8]! * dz;
      const nx = r[b + 2]!, ny = r[b + 5]!, nz = r[b + 8]!;
      this.normals[3 * k] = r[a]! * nx + r[a + 3]! * ny + r[a + 6]! * nz;
      this.normals[3 * k + 1] = r[a + 1]! * nx + r[a + 4]! * ny + r[a + 7]! * nz;
      this.normals[3 * k + 2] = r[a + 2]! * nx + r[a + 5]! * ny + r[a + 8]! * nz;
      const sx = r[a + 2]!, sy = r[a + 5]!, sz = r[a + 8]!;
      this.axes[3 * k] = r[b]! * sx + r[b + 3]! * sy + r[b + 6]! * sz;
      this.axes[3 * k + 1] = r[b + 1]! * sx + r[b + 4]! * sy + r[b + 7]! * sz;
      this.axes[3 * k + 2] = r[b + 2]! * sx + r[b + 5]! * sy + r[b + 8]! * sz;
    });
  }

  /** The excess speed of rotor `i`'s wake `distanceM` along its tube, from the last `step`, m/s, and the tube's radius there. */
  wakeRadiusM(i: number, distanceM: number): number { return this.launchRadii[i]! + distanceM * this.spread; }
  wakeSpeedMps(i: number, distanceM: number): number {
    const radius = this.wakeRadiusM(i, distanceM);
    return wakeMomentumRoot(this.carried[i]! / (this.densityKgM3[i]! * Math.PI * radius * radius), this.axial[i]!, this.across[i]!);
  }

  /** One step. Allocation-free. */
  step(): void {
    const air = this.airHubMps, thrust = this.thrustN, density = this.densityKgM3, wake = this.wakeHubMps, directions = this.directions;
    wake.fill(0);
    let outside = false;
    for (let i = 0; i < this.rotorCount; i++) {
      const t = thrust[i]!;
      this.active[i] = 0; this.downloadN[i] = 0; this.inducedMps[i] = 0;
      if (!(t > 0)) continue;
      const ax = air[3 * i]!, ay = air[3 * i + 1]!, az = air[3 * i + 2]!, rho = density[i]!, radius = this.radii[i]!;
      // Hub z is the thrust axis, so air running down through the disk has az < 0.
      const axial = az < 0 ? -az : 0, across = Math.sqrt(ax * ax + ay * ay);
      const v = wakeMomentumRoot(t / (2 * rho * Math.PI * radius * radius), axial, across);
      if (az > WAKE_DESCENT_LIMIT * v) outside = true;
      this.inducedMps[i] = v;
      // ½ρ((V + 2v)² − V²) C_D A: the wake's excess over the free stream, whose own drag the airframe model already has.
      const download = 2 * rho * v * (axial + v) * this.washed[i]!;
      this.downloadN[i] = download;
      const through = 2 * v - az;
      if (!(through > 0)) continue; // Fast enough in descent that no wake leaves below the rotor.
      const nearSpeed = Math.sqrt(across * across + (axial + v) * (axial + v)), farSpeed = Math.sqrt(across * across + (axial + 2 * v) * (axial + 2 * v));
      const tube = Math.sqrt(across * across + through * through);
      directions[3 * i] = ax / tube; directions[3 * i + 1] = ay / tube; directions[3 * i + 2] = -through / tube;
      this.launchRadii[i] = radius * Math.sqrt(nearSpeed / farSpeed);
      this.axial[i] = axial; this.across[i] = across; this.carried[i] = t - download;
      this.active[i] = 1;
    }
    this.outsideValidity = outside;
    const offsets = this.offsets, normals = this.normals, axes = this.axes;
    for (let k = 0; k < this.pairCount; k++) {
      const i = this.sources[k]!;
      if (this.active[i] === 0) continue;
      const a = 3 * k, wx = directions[3 * i]!, wy = directions[3 * i + 1]!, wz = directions[3 * i + 2]!;
      const rx = offsets[a]!, ry = offsets[a + 1]!, rz = offsets[a + 2]!, along = rx * wx + ry * wy + rz * wz;
      if (!(along > 0)) continue;
      const j = this.receivers[k]!, tube = this.launchRadii[i]! + along * this.spread, receiver = this.radii[j]!;
      const ox = rx - along * wx, oy = ry - along * wy, oz = rz - along * wz, offset2 = ox * ox + oy * oy + oz * oz;
      if (offset2 >= (tube + receiver) * (tube + receiver)) continue;
      const nx = normals[a]!, ny = normals[a + 1]!, nz = normals[a + 2]!, dot = nx * wx + ny * wy + nz * wz, facing = dot < 0 ? -dot : dot;
      if (facing < MIN_FACING) continue;
      // Seen along the tube the disk is an ellipse: its minor axis along the receiver's axis there, the full radius across it.
      const mx = nx - dot * wx, my = ny - dot * wy, mz = nz - dot * wz, minor2 = mx * mx + my * my + mz * mz;
      let offsetMinor = Math.sqrt(offset2), offsetMajor = 0;
      if (minor2 > 1e-18) {
        const projected = (ox * mx + oy * my + oz * mz) / Math.sqrt(minor2);
        offsetMinor = projected < 0 ? -projected : projected;
        offsetMajor = Math.sqrt(Math.max(0, offset2 - offsetMinor * offsetMinor));
      }
      const coverage = wakeCoverage(tube, receiver, receiver * facing, offsetMajor, offsetMinor);
      if (!(coverage > 0)) continue;
      const speed = wakeMomentumRoot(this.carried[i]! / (density[i]! * Math.PI * tube * tube), this.axial[i]!, this.across[i]!) * coverage;
      // The excess runs against the source's thrust axis.
      wake[3 * j] = wake[3 * j]! - speed * axes[a]!;
      wake[3 * j + 1] = wake[3 * j + 1]! - speed * axes[a + 1]!;
      wake[3 * j + 2] = wake[3 * j + 2]! - speed * axes[a + 2]!;
    }
  }

  reset(): void {
    this.airHubMps.fill(0); this.densityKgM3.fill(0); this.thrustN.fill(0); this.wakeHubMps.fill(0); this.downloadN.fill(0); this.inducedMps.fill(0);
    this.active.fill(0); this.outsideValidity = false;
  }
}

/** The disk of a rotor and an airframe shape's plan view, for `rotorWashedDragAreasM2`. */
export type WashedShape =
  | { readonly kind: 'capsule'; readonly startBodyM: readonly number[]; readonly endBodyM: readonly number[]; readonly radiusM: number }
  | { readonly kind: 'cylinder'; readonly centerBodyM: readonly number[]; readonly axisBody: readonly number[]; readonly radiusM: number; readonly halfHeightM: number };

/** Area where two circles overlap, m². */
function lensAreaM2(a: number, b: number, d: number): number {
  if (d >= a + b) return 0;
  if (d <= Math.abs(a - b)) { const small = Math.min(a, b); return Math.PI * small * small; }
  const x = (d * d + a * a - b * b) / (2 * d * a), y = (d * d + b * b - a * a) / (2 * d * b);
  return a * a * Math.acos(x) + b * b * Math.acos(y) - 0.5 * Math.sqrt((-d + a + b) * (d + a - b) * (d - a + b) * (d + a + b));
}

/**
 * C_D A of the hull in each rotor's hover wake, the contracted R/sqrt(2) at the hub's plane, from the hull's shapes: a capsule's width times
 * the length of it inside the wake, and a body cylinder's plan circle where the wake crosses it, for shapes not above the disk.
 * An arm counts from the body's radius outward, as the hull's drag does. Configuration-time code.
 */
export function rotorWashedDragAreasM2(hubs: readonly { readonly hubBodyM: readonly number[]; readonly axisBody: readonly number[]; readonly radiusM: number }[], hull: readonly WashedShape[]): number[] {
  const body = hull.find(shape => shape.kind === 'cylinder');
  const bodyRadius = body?.radiusM ?? 0;
  return hubs.map(hub => {
    const wakeRadius = hub.radiusM / Math.SQRT2, [ax = 0, ay = 0, az = 0] = hub.axisBody, [hx = 0, hy = 0, hz = 0] = hub.hubBodyM;
    const inPlane = (point: readonly number[]) => {
      const dx = point[0]! - hx, dy = point[1]! - hy, dz = point[2]! - hz, height = dx * ax + dy * ay + dz * az;
      return { x: dx - height * ax, y: dy - height * ay, z: dz - height * az, height };
    };
    let area = 0;
    for (const shape of hull) {
      if (shape.kind === 'cylinder') {
        const centre = inPlane(shape.centerBodyM);
        if (centre.height <= 1e-9) area += WASHED_BODY_DRAG_COEFFICIENT * lensAreaM2(wakeRadius, shape.radiusM, Math.hypot(centre.x, centre.y, centre.z));
        continue;
      }
      const length = Math.hypot(shape.endBodyM[0]! - shape.startBodyM[0]!, shape.endBodyM[1]! - shape.startBodyM[1]!, shape.endBodyM[2]! - shape.startBodyM[2]!);
      if (!(length > bodyRadius)) continue;
      const out = bodyRadius / length, start = shape.startBodyM.map((value, i) => value + out * (shape.endBodyM[i]! - value));
      const a = inPlane(start), b = inPlane(shape.endBodyM), ex = b.x - a.x, ey = b.y - a.y, ez = b.z - a.z;
      const p = ex * ex + ey * ey + ez * ez, q = a.x * ex + a.y * ey + a.z * ez, c = a.x * a.x + a.y * a.y + a.z * a.z - wakeRadius * wakeRadius;
      if (!(p > 0)) continue;
      const root = q * q - p * c;
      if (!(root > 0)) continue;
      const low = Math.max(0, (-q - Math.sqrt(root)) / p), high = Math.min(1, (-q + Math.sqrt(root)) / p);
      if (!(high > low)) continue;
      const middle = (low + high) / 2;
      if (a.height + middle * (b.height - a.height) > 1e-9) continue; // Above the disk: its wake runs away from this.
      area += WASHED_ARM_DRAG_COEFFICIENT * 2 * shape.radiusM * (high - low) * Math.sqrt(p);
    }
    return area;
  });
}
