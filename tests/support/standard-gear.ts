import type { VehicleManifest } from '@mirage/physics/vehicle-manifest';

// TASK-095: where a vehicle on the standard landing gear (decision D-07, F-07
// and F-08) stands, from rigid-plate statics on the manifest's supports rather
// than from the contact. Each support is a strut on a foot in series; the
// airframe's weight, less the unsprung feet, loads the struts, and each foot
// carries its strut's load plus its own weight. With the supports at (xᵢ, yᵢ)
// from the reference point and the CG at (x, y), the strut loads Fᵢ = a + b·xᵢ
// + c·yᵢ (equal strut stiffness: the compressions lie on a plane) balance the
// weight and its moments; the plane through the support compressions gives the
// body's tilt and the sink at the CG.

/** CG heights over level ground with the fully extended feet touching it and at rest on them, m, and the rest attitude, rad. */
export function standardGearHeights(manifest: VehicleManifest): { touchM: number; restM: number; pitchRad: number; rollRad: number } {
  const gear = manifest.landingGear, first = gear[0];
  if (!first || first.suspension.kind !== 'linear') throw new Error('The vehicle has no standard landing gear');
  const g = 9.80665, m = manifest.massProperties.massKg, cg = manifest.massProperties.cgOffsetBodyM;
  const strut = first.suspension.stiffnessNpm, knot = first.tireLoadCurve[1]!, foot = knot[1]! / knot[0]!;
  const unsprung = gear.reduce((sum, leg) => sum + leg.unsprungMassKg, 0);
  const x = gear.map(leg => leg.anchorBodyM[0]!), y = gear.map(leg => leg.anchorBodyM[1]!);
  // Normal equations of Σ Fᵢ (1, xᵢ, yᵢ) = W (1, x, y) for Fᵢ = a + b·xᵢ + c·yᵢ, W the sprung weight.
  const sum = (f: (i: number) => number) => gear.reduce((s, _, i) => s + f(i), 0), w = (m - unsprung) * g;
  const [a, b, c] = solve3([[gear.length, sum(i => x[i]!), sum(i => y[i]!)], [sum(i => x[i]!), sum(i => x[i]! ** 2), sum(i => x[i]! * y[i]!)],
    [sum(i => y[i]!), sum(i => x[i]! * y[i]!), sum(i => y[i]! ** 2)]], [w, w * cg[0]!, w * cg[1]!]);
  // Compression of support i: its strut load over the strut stiffness, plus that load and its foot's weight over the foot stiffness.
  const at = (px: number, py: number, footWeight: number) => {
    const load = a + b * px + c * py;
    return load / strut + (load + footWeight) / foot;
  };
  const footWeight = (unsprung / gear.length) * g;
  const touchM = first.anchorBodyM[2]! - cg[2]! + first.tireRadiusM;
  // Nose down when the front compresses more; right wing down when the right side does.
  return { touchM, restM: touchM - at(cg[0]!, cg[1]!, footWeight), pitchRad: b * (1 / strut + 1 / foot), rollRad: c * (1 / strut + 1 / foot) };
}

function solve3(m: number[][], r: number[]): [number, number, number] {
  const det = (q: number[][]) => q[0]![0]! * (q[1]![1]! * q[2]![2]! - q[1]![2]! * q[2]![1]!) -
    q[0]![1]! * (q[1]![0]! * q[2]![2]! - q[1]![2]! * q[2]![0]!) + q[0]![2]! * (q[1]![0]! * q[2]![1]! - q[1]![1]! * q[2]![0]!);
  const d = det(m), column = (k: number) => det(m.map((row, i) => row.map((v, j) => (j === k ? r[i]! : v))));
  return [column(0) / d, column(1) / d, column(2) / d];
}
