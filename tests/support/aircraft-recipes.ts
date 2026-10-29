import type { FixtureName } from './aircraft-derivation.ts';

// TASK-141: how a user builds each of the five S19 fixtures in the aircraft
// editor: an even layout from the layout helper, then the edits it does not
// make, all as the text typed into the form. tests/aircraft-editor.test.ts
// applies them to the form logic and tests/browser/aircraft-editor.spec.ts
// types them into the Aircraft tab; both compare the result with the fixture.

export interface MassText {
  readonly massKg: string;
  readonly cg: readonly [string, string, string];
  /** Tensor entries xx, yy, zz, xy, xz, yz in kg·m². */
  readonly inertia: readonly [string, string, string, string, string, string];
}
export interface ArmEdit {
  readonly arm: number;
  readonly heightM?: string;
  readonly outwardTiltDeg?: string;
  readonly sideTiltDeg?: string;
}
export interface MotorEdit {
  readonly arm: number;
  /** `single` or `upper` edits the arm's first motor, `lower` its second. */
  readonly position: 'upper' | 'lower';
  readonly id: string;
  readonly output: string;
}
export interface Recipe {
  readonly fixture: FixtureName;
  readonly name: string;
  readonly layout: { readonly count: string; readonly lengthM: string; readonly firstAzimuthDeg: string; readonly coaxial: boolean; readonly pairSeparationM: string };
  readonly arms: readonly ArmEdit[];
  readonly motors: readonly MotorEdit[];
  readonly mass: MassText;
  readonly payload: MassText | null;
  readonly groundClearanceM: string;
}

/** 0.05, 0.035 and 0.02 rad in degrees, typed with 12 significant digits. */
const TILT_005 = '2.86478897565', TILT_0035 = '2.00535228296', TILT_002 = '1.14591559026';
const all = (count: number, edit: Omit<ArmEdit, 'arm'>): ArmEdit[] => Array.from({ length: count }, (_, i) => ({ arm: i + 1, ...edit }));

export const RECIPES: readonly Recipe[] = [
  {
    fixture: 'quad-x', name: 'Quad X',
    layout: { count: '4', lengthM: '0.225', firstAzimuthDeg: '45', coaxial: false, pairSeparationM: '' },
    arms: [],
    // ArduCopter quad X numbering: front right 1, rear left 2, front left 3, rear right 4.
    motors: [
      { arm: 2, position: 'upper', id: '4', output: '4' }, { arm: 3, position: 'upper', id: '2', output: '2' },
      { arm: 4, position: 'upper', id: '3', output: '3' },
    ],
    mass: { massKg: '1.5', cg: ['0.005', '0', '0.02'], inertia: ['0.016', '0.017', '0.03', '0', '0', '0'] },
    payload: null, groundClearanceM: '0.12',
  },
  {
    fixture: 'hexa-x', name: 'Hexa X',
    layout: { count: '6', lengthM: '0.3', firstAzimuthDeg: '30', coaxial: false, pairSeparationM: '' },
    arms: Array.from({ length: 6 }, (_, i) => ({ arm: i + 1, heightM: '0.015', sideTiltDeg: i % 2 === 0 ? TILT_005 : `-${TILT_005}` })),
    motors: [],
    mass: { massKg: '2.4', cg: ['0.01', '0', '0.03'], inertia: ['0.045', '0.047', '0.085', '0', '0.0012', '0'] },
    payload: { massKg: '0.35', cg: ['0.08', '0', '0.07'], inertia: ['0.0004', '0.0003', '0.0005', '0', '0', '0'] },
    groundClearanceM: '0.15',
  },
  {
    fixture: 'octa-x', name: 'Octa X',
    layout: { count: '8', lengthM: '0.35', firstAzimuthDeg: '22.5', coaxial: false, pairSeparationM: '' },
    arms: all(8, { heightM: '-0.01', outwardTiltDeg: TILT_0035 }),
    motors: [],
    mass: { massKg: '4.2', cg: ['0', '0.004', '0.035'], inertia: ['0.11', '0.11', '0.2', '0', '0', '0'] },
    payload: null, groundClearanceM: '',
  },
  {
    fixture: 'coaxial-x8', name: 'Coaxial X8',
    layout: { count: '4', lengthM: '0.3', firstAzimuthDeg: '45', coaxial: true, pairSeparationM: '0.09' },
    arms: [], motors: [],
    mass: { massKg: '3.6', cg: ['0', '0', '0.025'], inertia: ['0.06', '0.062', '0.11', '0', '0', '0'] },
    payload: null, groundClearanceM: '0.2',
  },
  {
    fixture: 'octa-coaxial-16', name: 'Octa coaxial 16',
    layout: { count: '8', lengthM: '0.42', firstAzimuthDeg: '22.5', coaxial: true, pairSeparationM: '0.1' },
    arms: all(8, { outwardTiltDeg: TILT_002 }),
    motors: [],
    mass: { massKg: '7.5', cg: ['0.006', '-0.002', '0.04'], inertia: ['0.32', '0.33', '0.6', '0', '0.004', '0'] },
    payload: { massKg: '1', cg: ['0', '0', '0.15'], inertia: ['0.002', '0.002', '0.003', '0', '0', '0'] },
    groundClearanceM: '0.25',
  },
];

/** Angles typed in degrees with 12 significant digits differ from the fixture's radians by less than this. */
export const ANGLE_TOLERANCE_RAD = 1e-12;

interface ComparableProfile {
  readonly arms: readonly { readonly id: number; readonly azimuthRad: number; readonly outwardTiltRad: number; readonly sideTiltRad: number }[];
}
/**
 * The differences between a built profile and its fixture: angles may differ
 * by ANGLE_TOLERANCE_RAD, every other value must be equal, and the schema
 * version and calculation, which the editor sets, are not compared.
 */
export function profileDifferences(actual: ComparableProfile, expected: ComparableProfile): string[] {
  // Keys are sorted, because a stored payload is canonical JSON while a fixture keeps its own key order.
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, sorted(item)]))
      : value;
  const strip = (profile: ComparableProfile): unknown => sorted(JSON.parse(JSON.stringify({
    ...profile, schemaVersion: undefined, calculation: undefined,
    arms: profile.arms.map(arm => ({ ...arm, azimuthRad: 0, outwardTiltRad: 0, sideTiltRad: 0 })),
  })));
  const differences: string[] = [];
  if (JSON.stringify(strip(actual)) !== JSON.stringify(strip(expected))) {
    differences.push(`fields other than angles differ: ${JSON.stringify(strip(actual))} != ${JSON.stringify(strip(expected))}`);
  }
  actual.arms.forEach((arm, i) => {
    const target = expected.arms[i];
    for (const key of ['azimuthRad', 'outwardTiltRad', 'sideTiltRad'] as const) {
      if (!target || !(Math.abs(arm[key] - target[key]) <= ANGLE_TOLERANCE_RAD)) differences.push(`arm ${arm.id} ${key} ${arm[key]} != ${target?.[key]}`);
    }
  });
  return differences;
}

/** Rotates v by the unit quaternion q = (w, x, y, z): v + 2w(u×v) + 2u×(u×v). */
export function rotate(q: readonly number[], v: readonly number[]): number[] {
  const [w = 0, x = 0, y = 0, z = 0] = q, [a = 0, b = 0, c = 0] = v;
  const t = [2 * (y * c - z * b), 2 * (z * a - x * c), 2 * (x * b - y * a)] as const;
  return [a + w * t[0] + (y * t[2] - z * t[1]), b + w * t[1] + (z * t[0] - x * t[2]), c + w * t[2] + (x * t[1] - y * t[0])];
}
/** FRD (forward, right, down) to the render basis (right, up, back), as in apps/web/src/coordinates.ts. */
export function toRender(v: readonly number[]): number[] {
  return [v[1] ?? 0, -(v[2] ?? 0), -(v[0] ?? 0)];
}
