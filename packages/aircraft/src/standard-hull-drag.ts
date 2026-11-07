import type { AirframeDrag, HullShape } from '@mirage/physics/vehicle-manifest';

// Preliminary airframe drag of the standard hull (TASK-096 increment 2): the
// drag-area tensor of the synthetic body cylinder and arm capsules, until
// profiles give drag areas or body sizes (TASK-196). Decision F-01 admits "an
// estimate from geometry labeled preliminary"; its dataset says so. The rotors
// are not in it: the BET rotors produce their own momentum drag. Only +, −, ×,
// ÷ and √ are used, so Node and Chromium give the same bytes. Configuration-time
// code only. Positions are body FRD metres from the reference point.

/** Version of the rules; a change of any rule is a new version. */
export const STANDARD_HULL_DRAG_VERSION = 1;

/** The coefficients, the end of their Reynolds-number range, and the air that range is taken in. */
export const STANDARD_HULL_DRAG = Object.freeze({
  /**
   * A circular cylinder across the flow below the drag crisis, infinite span: the generally accepted subcritical value
   * (NACA, ntrs.nasa.gov 19930083675, which measured about 1.0 itself). A finite span has less, so this is an upper estimate.
   */
  crossFlowDragCoefficient: 1.2,
  /** A flat disk or a blunt cylinder end facing the flow (Hoerner, Fluid-Dynamic Drag, 1965, as aerospaceweb.org q0231 quotes it). */
  endOnDragCoefficient: 1.17,
  /** The end of a smooth circular cylinder's subcritical range; above it the drag crisis lowers the coefficient. */
  criticalReynoldsNumber: 2e5,
  /** ISA sea-level kinematic viscosity μ/ρ = 1.7894e-5 Pa s / 1.2250 kg/m³, m²/s. */
  kinematicViscosityM2PerS: 1.4607e-5,
});

/**
 * The drag of a validated standard hull: the body cylinder (ID 0) and arm capsules. Each shape of unit axis a adds
 * C_D,across·A_side·(I − a·aᵀ) + C_D,along·A_end·(a·aᵀ). A cylinder's side area is its diameter times its height and its end
 * area πr²; an arm counts from the body cylinder's radius outward, its side area its diameter times that length and its end
 * area πr². The center of pressure is the shapes' centers (an arm's at the middle of its counted length) weighted by the
 * traces of their tensors. The airspeed range ends where the widest shape reaches the critical Reynolds number. TASK-196: a
 * capsule whose ID is above `armCount` is a body part, not an arm, and counts its whole length about its middle.
 */
export function standardHullDrag(hull: readonly HullShape[], armCount = Number.POSITIVE_INFINITY): Required<AirframeDrag> {
  const h = STANDARD_HULL_DRAG, body = hull.find(shape => shape.kind === 'cylinder');
  if (!body || body.kind !== 'cylinder') throw new Error('The standard hull has no body cylinder');
  const tensor = new Array<number>(9).fill(0), center = [0, 0, 0];
  let weight = 0, widestM = 0;
  for (const shape of hull) {
    let axis: readonly number[], sideM2: number, endM2: number, middle: readonly number[];
    if (shape.kind === 'cylinder') {
      axis = shape.axisBody; sideM2 = 2 * shape.radiusM * 2 * shape.halfHeightM; endM2 = Math.PI * shape.radiusM * shape.radiusM;
      middle = shape.centerBodyM;
    } else {
      const d = [0, 1, 2].map(i => shape.endBodyM[i]! - shape.startBodyM[i]!), length = Math.sqrt(d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]!);
      const arm = shape.id <= armCount, counted = arm ? length - body.radiusM : length;
      if (!(counted > 0)) throw new Error(arm ? `Arm shape ${shape.id} ends inside the body` : `Hull shape ${shape.id} has no length`);
      axis = d.map(value => value / length); sideM2 = 2 * shape.radiusM * counted; endM2 = Math.PI * shape.radiusM * shape.radiusM;
      const along = arm ? length - counted / 2 : length / 2;
      middle = [0, 1, 2].map(i => shape.startBodyM[i]! + axis[i]! * along);
    }
    const across = h.crossFlowDragCoefficient * sideM2, end = h.endOnDragCoefficient * endM2;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const projection = axis[i]! * axis[j]!;
      tensor[3 * i + j] = tensor[3 * i + j]! + across * ((i === j ? 1 : 0) - projection) + end * projection;
    }
    const trace = 2 * across + end;
    for (let i = 0; i < 3; i++) center[i] = center[i]! + trace * middle[i]!;
    weight += trace;
    widestM = Math.max(widestM, 2 * shape.radiusM);
  }
  return {
    dragAreaBodyM2: tensor.map(clean), centerOfPressureBodyM: center.map(value => clean(value / weight)),
    maxAirspeedMps: h.criticalReynoldsNumber * h.kinematicViscosityM2PerS / widestM,
  };
}

/** Turns -0 into 0, so values and their canonical JSON agree. */
function clean(value: number): number {
  return value === 0 ? 0 : value;
}

/** The manifest dataset text of the standard hull drag. */
export function standardHullDragDerivation(hull: 'standard' | 'profile' = 'standard'): string {
  const h = STANDARD_HULL_DRAG;
  // TASK-196: the same rules over the hull the aircraft profile describes, whose own dataset names its source.
  const from = hull === 'standard' ? 'the synthetic standard hull' : 'the hull the aircraft profile describes';
  return `Standard hull drag ${STANDARD_HULL_DRAG_VERSION} of @mirage/aircraft, a preliminary estimate from ${from}, not measured: each cylinder or capsule adds C_D times its area across its axis (C_D ${h.crossFlowDragCoefficient}, a ` +
    `subcritical circular cylinder of infinite span, an upper estimate) and along it (C_D ${h.endOnDragCoefficient}, a flat disk or ` +
    `blunt end, Hoerner 1965); arms count from the body radius outward; the center of pressure weights the shapes' centers by their ` +
    `drag areas; the airspeed range ends where the widest shape reaches Reynolds number ${h.criticalReynoldsNumber} in ISA sea-level ` +
    `air. The rotors' own drag is the BET's, not in this tensor.`;
}
