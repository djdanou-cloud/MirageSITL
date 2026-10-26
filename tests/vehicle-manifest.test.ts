import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DemoDynamics, PhysicsSessionV2, type SessionModelPort } from '@mirage/physics';
import { validateModelManifest, type ModelDescriptor } from '@mirage/physics/model-manifest';
import {
  VehicleRegistry, deriveVehicle, migrateModelManifestV1, motorTorqueConstantNmPerA, projectVehicleToModelV1,
  registryModelPort, symmetricEigen3, validateVehicleManifest, type VehicleDataset, type VehicleManifest,
} from '@mirage/physics/vehicle-manifest';
import { StateReaderV2, createSharedMemoryV2, createSpscQueue, newFlightStateV2, newHeaderSnapshotV2,
  type CommandResultV2, type PhysicsHz } from '@mirage/protocol';
import { ardupilotParameterProfile } from '@mirage/physics/ardupilot-profile';
import v1Schema from '../packages/physics/src/model.schema.json';
import v2Schema from '../packages/physics/src/vehicle.schema.json';
import demoQuad from './fixtures/models/demo-quad.json';
import tiltedOcto from './fixtures/models/tilted-octo.json';
import { flightConfiguration } from './bet-runtime-fixture.ts';

const fixtureBytes = readFileSync(new URL('./fixtures/models/synthetic-quad-v2.json', import.meta.url));
const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
const quad = validateVehicleManifest(JSON.parse(fixtureBytes.toString('utf8')));
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const relative = (actual: number, expected: number) => Math.abs(actual - expected) / Math.abs(expected);
const synthetic: VehicleDataset = { id: 'v1-source', kind: 'synthetic', sourceSha256: null, derivation: 'Repository v1 fixture.' };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
/** A deep copy of the fixture with type-correct top-level replacements; invalid types use plain spreads. */
function edit(change: (copy: Mutable<VehicleManifest>) => void): unknown {
  const copy: Mutable<VehicleManifest> = structuredClone(quad);
  change(copy);
  return copy;
}

describe('vehicle manifest v2 schema and validation', () => {
  it('accepts the synthetic quad X fixture and freezes a verified snapshot', async () => {
    const registry = new VehicleRegistry();
    const record = await registry.register(fixtureBytes, fixtureSha256);
    expect(record.schemaVersion).toBe(2);
    expect(record.sha256).toBe(fixtureSha256);
    expect(record.manifest.modelId).toBe(87);
    if (record.schemaVersion !== 2) throw new Error('Expected a v2 record');
    expect(Object.isFrozen(record.manifest.massProperties.inertiaCgKgM2)).toBe(true);
    expect(Object.isFrozen(record.manifest.escs[3])).toBe(true);
    expect(await registry.register(fixtureBytes, fixtureSha256)).toBe(record);
    expect(registry.get(87)).toBe(record);
  });

  it('keeps the v2 rotor schema identical to the v1 rotor schema', () => {
    expect(v2Schema.properties.rotors).toEqual(v1Schema.properties.rotors);
    expect(v2Schema.properties.modelId).toEqual(v1Schema.properties.modelId);
  });

  it('admits hashed v1 and v2 payloads and rejects other versions, mismatches and collisions', async () => {
    const registry = new VehicleRegistry(), v1 = encode(demoQuad);
    const legacy = await registry.register(v1, digest(v1));
    expect(legacy.schemaVersion).toBe(1);
    await expect(registry.register(fixtureBytes, digest(v1))).rejects.toThrow('hash');
    const v3 = encode({ ...quad, schemaVersion: 3 });
    await expect(registry.register(v3, digest(v3))).rejects.toThrow('Unsupported');
    const array = encode([quad]);
    await expect(registry.register(array, digest(array))).rejects.toThrow('Unsupported');
    const original = await registry.register(fixtureBytes, fixtureSha256);
    const collision = encode({ ...quad, massProperties: { ...quad.massProperties, massKg: 1.6 } });
    await expect(registry.register(collision, digest(collision))).rejects.toThrow('collision');
    expect(registry.get(87)).toBe(original);
  });

  it('rejects unknown keys, units, frames and malformed provenance', () => {
    const measured: VehicleDataset = { id: 'synthetic-quad-v2-drag', kind: 'measured', sourceSha256: fixtureSha256,
      license: 'Owned test data', acquiredAt: '2026-10-26T00:00:00Z', reference: 'Bench log 1' };
    const withDrag = (dataset: unknown) => ({ ...quad, datasets: [...quad.datasets.slice(0, 2), dataset] });
    const invalid: [string, unknown][] = [
      ['unknown top-level key', { ...quad, unexpected: true }],
      ['unknown motor key', { ...quad, motors: quad.motors.map(m => ({ ...m, efficiency: 0.8 })) }],
      ['imperial units', { ...quad, units: 'imperial' }],
      ['ENU world frame', { ...quad, worldFrame: 'ENU' }],
      ['xyzw quaternion order', { ...quad, quaternionOrder: 'xyzw' }],
      ['version 1 body', { ...quad, schemaVersion: 1 }],
      ['missing section', Object.fromEntries(Object.entries(quad).filter(([key]) => key !== 'rotorWakePairs'))],
      ['data without provenance', edit(c => { c.provenance = { ...c.provenance, battery: null }; })],
      ['provenance without data', edit(c => { c.provenance = { ...c.provenance, landingGear: 'synthetic-quad-v2-airframe' }; })],
      ['unknown dataset', edit(c => { c.provenance = { ...c.provenance, motors: 'missing' }; })],
      ['orphan dataset', edit(c => { c.datasets = [...c.datasets, { ...synthetic, id: 'orphan' }]; })],
      ['duplicate dataset', edit(c => { c.datasets = [...c.datasets, c.datasets[0]!]; })],
      ['measured without hash', withDrag({ ...measured, sourceSha256: null })],
      ['measured with impossible date', withDrag({ ...measured, acquiredAt: '2026-13-45T99:99:99Z' })],
      ['measured without reference', withDrag({ ...measured, reference: '' })],
      ['synthetic with license', withDrag({ ...synthetic, id: 'synthetic-quad-v2-drag', license: 'x' })],
      ['unevidenced frame', edit(c => { c.ardupilot = { vehicle: 'copter', frameClass: 2, frameType: 1 }; })],
      ['plane vehicle', { ...quad, ardupilot: { ...quad.ardupilot, vehicle: 'plane' } }],
    ];
    for (const [label, input] of invalid) expect(() => validateVehicleManifest(input), label).toThrow();
    // A complete measured dataset is admitted.
    expect(validateVehicleManifest(withDrag(measured)).datasets[2]?.kind).toBe('measured');
  });

  it('rejects non-physical mass properties, duplicate IDs and channels and unnormalized quaternions', () => {
    const rotor = quad.rotors[0]!;
    const invalid: [string, unknown, string][] = [
      ['zero mass', edit(c => { c.massProperties = { ...c.massProperties, massKg: 0 }; }), 'schema'],
      ['NaN mass', edit(c => { c.massProperties = { ...c.massProperties, massKg: NaN }; }), 'schema'],
      ['indefinite inertia', edit(c => { c.massProperties = { ...c.massProperties, inertiaCgKgM2: [1, 0, 0, 0, -1, 0, 0, 0, 1] }; }), 'positive definite'],
      ['asymmetric inertia', edit(c => { c.massProperties = { ...c.massProperties, inertiaCgKgM2: [1, 0.5, 0, 0, 1, 0, 0, 0, 1] }; }), 'symmetric'],
      ['triangle violation', edit(c => { c.massProperties = { ...c.massProperties, inertiaCgKgM2: [0.01, 0, 0, 0, 0.01, 0, 0, 0, 0.05] }; }), 'triangle'],
      ['duplicate rotor ID', edit(c => { c.rotors = [rotor, { ...c.rotors[1]!, id: rotor.id }, ...c.rotors.slice(2)]; }), 'Duplicate'],
      ['duplicate rotor channel', edit(c => { c.rotors = [rotor, { ...c.rotors[1]!, motorChannel: 0 }, ...c.rotors.slice(2)]; }), 'Duplicate'],
      ['unnormalized rotor quaternion', edit(c => { c.rotors = [{ ...rotor, hubToBody: [0, 1.1, 0, 0] }, ...c.rotors.slice(1)]; }), 'normalized'],
      ['unnormalized sensor quaternion', edit(c => {
        c.sensorMounts = [{ ...c.sensorMounts[0]!, sensorToBody: [0.9, 0, 0, 0] }, ...c.sensorMounts.slice(1)];
      }), 'normalized'],
      ['duplicate sensor mount', edit(c => { c.sensorMounts = [...c.sensorMounts, c.sensorMounts[0]!]; }), 'Duplicate sensor'],
      ['duplicate motor ID', edit(c => { c.motors = [c.motors[0]!, { ...c.motors[1]!, id: 0 }, ...c.motors.slice(2)]; }), 'Duplicate motor'],
      ['two motors on one rotor', edit(c => { c.motors = [c.motors[0]!, { ...c.motors[1]!, rotorId: 0 }, ...c.motors.slice(2)]; }), 'Two motors'],
      ['motor on unknown rotor', edit(c => { c.motors = [{ ...c.motors[0]!, rotorId: 9 }, ...c.motors.slice(1)]; }), 'unknown rotor'],
      ['duplicate ESC ID', edit(c => { c.escs = [c.escs[0]!, { ...c.escs[1]!, id: 0 }, ...c.escs.slice(2)]; }), 'Duplicate ESC'],
      ['two ESCs on one motor', edit(c => { c.escs = [c.escs[0]!, { ...c.escs[1]!, motorId: 0 }, ...c.escs.slice(2)]; }), 'Two ESCs'],
      ['ESC on unknown motor', edit(c => { c.escs = [{ ...c.escs[0]!, motorId: 9 }, ...c.escs.slice(1)]; }), 'unknown motor'],
      ['battery inverted', edit(c => { c.battery = { ...c.battery!, openCircuitEmptyV: 17 }; }), 'Battery'],
      ['indefinite drag', edit(c => { c.airframe = { drag: { ...c.airframe.drag!, dragAreaBodyM2: [0.01, 0, 0, 0, 0, 0, 0, 0, 0.03] } }; }), 'Drag'],
      ['wake pair to unknown rotor', edit(c => { c.rotorWakePairs = [{ upstreamRotorId: 0, downstreamRotorId: 9 }]; c.provenance = { ...c.provenance, rotorWakePairs: 'synthetic-quad-v2-airframe' }; }), 'unknown rotor'],
      ['self wake pair', edit(c => { c.rotorWakePairs = [{ upstreamRotorId: 1, downstreamRotorId: 1 }]; c.provenance = { ...c.provenance, rotorWakePairs: 'synthetic-quad-v2-airframe' }; }), 'own wake'],
      ['duplicate wake pair', edit(c => {
        c.rotorWakePairs = [{ upstreamRotorId: 0, downstreamRotorId: 1 }, { upstreamRotorId: 0, downstreamRotorId: 1 }];
        c.provenance = { ...c.provenance, rotorWakePairs: 'synthetic-quad-v2-airframe' };
      }), 'Duplicate rotor wake'],
      ['cyclic wake pairs', edit(c => {
        c.rotorWakePairs = [{ upstreamRotorId: 0, downstreamRotorId: 1 }, { upstreamRotorId: 1, downstreamRotorId: 2 }, { upstreamRotorId: 2, downstreamRotorId: 0 }];
        c.provenance = { ...c.provenance, rotorWakePairs: 'synthetic-quad-v2-airframe' };
      }), 'acyclic'],
    ];
    for (const [label, input, message] of invalid) expect(() => validateVehicleManifest(input), label).toThrow(message);
    // A planar body sits exactly on the triangle inequality and remains admissible.
    expect(() => validateVehicleManifest(edit(c => {
      c.massProperties = { ...c.massProperties, inertiaCgKgM2: [0.02, 0, 0, 0, 0.03, 0, 0, 0, 0.05] };
    }))).not.toThrow();
  });

  it('rejects values outside the declared capacity and boundary envelopes', () => {
    const rotor = quad.rotors[0]!;
    const surface = { id: 0, function: 'aileron', actuatorChannel: 8, deflectionMinRad: -0.4, deflectionMaxRad: 0.4, rateLimitRadS: 6 } as const;
    const gear = { id: 0, anchorBodyM: [0.1, 0.1, 0.1], unsprungMassKg: 0.005, tireRadiusM: 0.015, rimRadiusM: 0.01,
      strutTravelM: 0.01, suspension: { kind: 'linear', stiffnessNpm: 3000, preloadN: 0, compressionDamping: 30,
        reboundDamping: 30, dampingLaw: 'linear' }, tireLoadCurve: [[0, 0], [0.005, 40]], tireDampingNsPm: 5,
      rollingCoefficient: 0.05, lateralCoefficient: 0.8, brakingCoefficient: 0.8 } as const;
    const withSurfaces = (items: readonly unknown[]) => ({ ...quad, controlSurfaces: items,
      provenance: { ...quad.provenance, controlSurfaces: 'synthetic-quad-v2-airframe' } });
    const withGear = (items: readonly unknown[]) => ({ ...quad, landingGear: items,
      provenance: { ...quad.provenance, landingGear: 'synthetic-quad-v2-airframe' } });
    expect(() => validateVehicleManifest(withSurfaces([surface]))).not.toThrow();
    expect(() => validateVehicleManifest(withGear([gear]))).not.toThrow();
    const invalid: [string, unknown][] = [
      ['PWM below 800 us', edit(c => { c.escs = c.escs.map(e => ({ ...e, pwmMinUs: 700 })); })],
      ['PWM above 2200 us', edit(c => { c.escs = c.escs.map(e => ({ ...e, pwmMaxUs: 2300 })); })],
      ['fractional PWM', edit(c => { c.escs = c.escs.map(e => ({ ...e, pwmMinUs: 1000.5 })); })],
      ['PWM span below 100 us', edit(c => { c.escs = c.escs.map(e => ({ ...e, pwmMaxUs: 1050 })); })],
      ['zero ESC lag', edit(c => { c.escs = c.escs.map(e => ({ ...e, commandTauS: 0 })); })],
      ['negative resistance', edit(c => { c.motors = c.motors.map(m => ({ ...m, resistanceOhm: -0.1 })); })],
      ['zero KV', edit(c => { c.motors = c.motors.map(m => ({ ...m, kvRpmPerV: 0 })); })],
      ['zero capacity', edit(c => { c.battery = { ...c.battery!, capacityAh: 0 }; })],
      ['33 rotors', edit(c => { c.rotorCount = 33; c.rotors = Array.from({ length: 33 }, (_, i) => ({ ...rotor, id: i % 32, motorChannel: i % 32 })); })],
      ['65 azimuth samples', edit(c => { c.rotors = [{ ...rotor, azimuthSamples: 65 }, ...c.rotors.slice(1)]; })],
      ['rotor count mismatch', edit(c => { c.rotorCount = 3; })],
      ['nine wheels', withGear(Array.from({ length: 9 }, (_, i) => ({ ...gear, id: i % 8 })))],
      ['wheel ID 8', withGear([{ ...gear, id: 8 }])],
      ['rim not inside tire', withGear([{ ...gear, rimRadiusM: 0.015 }])],
      ['tire curve short of the rim', withGear([{ ...gear, tireLoadCurve: [[0, 0], [0.004, 40]] }])],
      ['single tire knot', withGear([{ ...gear, tireLoadCurve: [[0, 0]] }])],
      ['duplicate wheel ID', withGear([gear, gear])],
      ['deflection beyond 90 degrees', withSurfaces([{ ...surface, deflectionMaxRad: 2 }])],
      ['empty deflection range', withSurfaces([{ ...surface, deflectionMinRad: 0.4 }])],
      ['surface on a rotor channel', withSurfaces([{ ...surface, actuatorChannel: 2 }])],
      ['duplicate surface channel', withSurfaces([surface, { ...surface, id: 1 }])],
      ['17 surfaces', withSurfaces(Array.from({ length: 17 }, (_, i) => ({ ...surface, id: i % 16, actuatorChannel: 8 + i })))],
      ['sensor instance 8', edit(c => { c.sensorMounts = [{ ...c.sensorMounts[0]!, instance: 8 }, ...c.sensorMounts.slice(1)]; })],
    ];
    for (const [label, input] of invalid) expect(() => validateVehicleManifest(input), label).toThrow();
  });

  it('checks the declared quad X frame against geometry and spin direction', () => {
    const rotors = quad.rotors;
    const invalid: [string, unknown][] = [
      ['swapped FR/FL position', edit(c => {
        c.rotors = c.rotors.map(r => r.motorChannel === 0 ? { ...r, hubPositionBodyM: rotors[2]!.hubPositionBodyM }
          : r.motorChannel === 2 ? { ...r, hubPositionBodyM: rotors[0]!.hubPositionBodyM } : r);
      })],
      ['reversed spin on FR', edit(c => { c.rotors = c.rotors.map(r => r.motorChannel === 0 ? { ...r, spinSign: -1 } : r); })],
      ['all spins reversed', edit(c => { c.rotors = c.rotors.map(r => ({ ...r, spinSign: r.spinSign === 1 ? -1 : 1 })); })],
      // A 60° tilt about body X still thrusts partly upward but exceeds the 45° matrix-frame envelope.
      ['thrust axis tilted 60 degrees', edit(c => {
        c.rotors = c.rotors.map(r => r.motorChannel === 1 ? { ...r, hubToBody: [Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 0, 0] } : r);
      })],
      ['thrust axis downward', edit(c => { c.rotors = c.rotors.map(r => ({ ...r, hubToBody: [1, 0, 0, 0], spinSign: r.spinSign === 1 ? -1 : 1 })); })],
      ['rotor on the CG plane', edit(c => {
        c.rotors = c.rotors.map(r => r.motorChannel === 3 ? { ...r, hubPositionBodyM: [0.01, 0.15, -0.02] } : r);
      })],
    ];
    for (const [label, input] of invalid) expect(() => validateVehicleManifest(input), label).toThrow('quad X');
    // Without a frame declaration the same geometry is admissible.
    expect(() => validateVehicleManifest(edit(c => {
      c.ardupilot = null;
      c.rotors = c.rotors.map(r => ({ ...r, spinSign: r.spinSign === 1 ? -1 : 1 }));
    }))).not.toThrow();
  });
});

describe('v1 migration and runtime projection', () => {
  const v1Inputs: [string, unknown][] = [['demo quad', demoQuad], ['tilted octo', tiltedOcto],
    ['parity base quad', flightConfiguration(0, 4).manifest]];
  for (const [label, input] of v1Inputs) {
    it(`migrates the ${label} losslessly and projects it back exactly`, () => {
      const v1 = validateModelManifest(input), v2 = migrateModelManifestV1(input, synthetic);
      expect(v2.schemaVersion).toBe(2);
      expect(v2.modelId).toBe(v1.modelId);
      expect(v2.kind).toBe(v1.kind);
      expect(v2.massProperties.massKg).toBe(v1.massKg);
      expect(v2.massProperties.inertiaCgKgM2).toEqual(v1.inertiaBodyKgM2);
      expect(v2.massProperties.cgOffsetBodyM).toEqual([0, 0, 0]);
      expect(v2.rotors).toEqual(v1.rotors);
      expect(v2.provenance.rotors).toBe('v1-source');
      expect(projectVehicleToModelV1(v2)).toEqual(v1);
    });
  }

  it('rejects a v1 input that is invalid or not physically realizable', () => {
    expect(() => migrateModelManifestV1({ ...demoQuad, massKg: -1 }, synthetic)).toThrow();
    expect(() => migrateModelManifestV1({ ...demoQuad, inertiaBodyKgM2: [0.01, 0, 0, 0, 0.01, 0, 0, 0, 0.05] }, synthetic))
      .toThrow('triangle');
    expect(() => migrateModelManifestV1(demoQuad, { ...synthetic, id: 'Upper Case' })).toThrow('schema');
  });

  it('fails closed for sections the v1 runtime cannot consume and shifts hubs to the CG', () => {
    expect(() => projectVehicleToModelV1(quad)).toThrow(/motors \(TASK-092\).*airframeDrag \(TASK-096\).*sensorMounts \(TASK-114\)/);
    const bodyOnly = validateVehicleManifest(edit(c => {
      c.motors = []; c.escs = []; c.battery = null; c.airframe = { drag: null }; c.sensorMounts = []; c.ardupilot = null;
      c.datasets = [c.datasets[0]!];
      c.provenance = { ...c.provenance, motors: null, escs: null, battery: null, airframeDrag: null, sensorMounts: null };
    }));
    const runtime = projectVehicleToModelV1(bodyOnly), cg = quad.massProperties.cgOffsetBodyM;
    expect(runtime.massKg).toBe(1.5);
    expect(runtime.inertiaBodyKgM2).toEqual(quad.massProperties.inertiaCgKgM2);
    for (let i = 0; i < 4; i++) {
      const hub = quad.rotors[i]!.hubPositionBodyM;
      expect(runtime.rotors[i]!.hubPositionBodyM).toEqual([hub[0]! - cg[0]!, hub[1]! - cg[1]!, hub[2]! - cg[2]!]);
    }
    expect(() => projectVehicleToModelV1(validateVehicleManifest(edit(c => {
      c.motors = []; c.escs = []; c.battery = null; c.airframe = { drag: null }; c.sensorMounts = [];
      c.datasets = [c.datasets[0]!];
      c.provenance = { ...c.provenance, motors: null, escs: null, battery: null, airframeDrag: null, sensorMounts: null };
    })))).toThrow('ArduPilot');
  });
});

describe('derived vehicle values', () => {
  it('matches analytic principal moments of the fixture within 1e-12 relative', () => {
    // inertia = [[0.03,0,-0.001],[0,0.032,0],[-0.001,0,0.05]]: the x-z block has
    // eigenvalues (a+c)/2 ± sqrt(((a-c)/2)^2 + b^2); y is already principal.
    const a = 0.03, b = -0.001, c = 0.05, half = Math.sqrt(((a - c) / 2) ** 2 + b * b);
    const expected = [(a + c) / 2 - half, 0.032, (a + c) / 2 + half];
    const derived = deriveVehicle(quad);
    for (let i = 0; i < 3; i++) expect(relative(derived.principalMomentsKgM2[i]!, expected[i]!)).toBeLessThan(1e-12);
    const axes = derived.principalAxesBody;
    // The y principal axis is exactly body Y.
    expect(Math.abs(axes[1 * 3 + 1]!)).toBeCloseTo(1, 15);
  });

  it('recovers moments of a rotated diagonal tensor with orthonormal right-handed axes', () => {
    const moments = [0.02, 0.03, 0.045], n = Math.hypot(0.9, 0.1, -0.3, 0.2);
    const w = 0.9 / n, x = 0.1 / n, y = -0.3 / n, z = 0.2 / n;
    const r = [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z),
      1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
    const tensor = new Array<number>(9).fill(0);
    // Upper triangle mirrored so the input is exactly symmetric.
    for (let i = 0; i < 3; i++) {
      for (let j = i; j < 3; j++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += r[i * 3 + k]! * moments[k]! * r[j * 3 + k]!;
        tensor[i * 3 + j] = sum; tensor[j * 3 + i] = sum;
      }
    }
    const { values, vectors } = symmetricEigen3(tensor);
    for (let i = 0; i < 3; i++) expect(relative(values[i]!, moments[i]!)).toBeLessThan(1e-12);
    for (let col = 0; col < 3; col++) {
      for (let row = 0; row < 3; row++) {
        let product = 0;
        for (let k = 0; k < 3; k++) product += tensor[row * 3 + k]! * vectors[k * 3 + col]!;
        expect(Math.abs(product - values[col]! * vectors[row * 3 + col]!)).toBeLessThan(1e-15);
      }
      for (let other = 0; other < 3; other++) {
        let dot = 0;
        for (let k = 0; k < 3; k++) dot += vectors[k * 3 + col]! * vectors[k * 3 + other]!;
        expect(Math.abs(dot - (col === other ? 1 : 0))).toBeLessThan(1e-14);
      }
    }
    const v = vectors;
    const det = v[0]! * (v[4]! * v[8]! - v[5]! * v[7]!) - v[1]! * (v[3]! * v[8]! - v[5]! * v[6]!) + v[2]! * (v[3]! * v[7]! - v[4]! * v[6]!);
    expect(det).toBeCloseTo(1, 14);
    expect(() => symmetricEigen3([1, 2, 0, 0, 1, 0, 0, 0, 1])).toThrow('symmetric');
    expect(() => symmetricEigen3([1, 0, 0, 0, NaN, 0, 0, 0, 1])).toThrow('finite');
  });

  it('derives k_t = 60/(2π·KV) and CG-relative positions', () => {
    // 60/(2π·1000) = 0.009549296585513720 N·m/A.
    expect(relative(motorTorqueConstantNmPerA(1000), 0.00954929658551372)).toBeLessThan(1e-15);
    expect(() => motorTorqueConstantNmPerA(0)).toThrow();
    const derived = deriveVehicle(quad), cg = quad.massProperties.cgOffsetBodyM;
    expect(derived.motorTorqueConstantNmPerA).toEqual(quad.motors.map(() => 60 / (2 * Math.PI * 920)));
    expect(derived.rotorHubPositionCgM).toEqual(quad.rotors.flatMap(r => r.hubPositionBodyM.map((p, i) => p - cg[i]!)));
    expect(derived.sensorPositionCgM.slice(0, 3)).toEqual([0, 0, 0]); // the IMU sits at the CG
    expect(derived.landingGearAnchorCgM).toEqual([]);
  });
});

describe('ArduPilot parameter profile', () => {
  it('is byte-identical to the hand-derived golden profile', () => {
    // Golden text from the TASK-087 profile contract, not from implementation output.
    const golden = '# MirageSITL ArduPilot parameter profile v1\n' +
      `# modelId 87; manifest sha256 ${fixtureSha256}\n` +
      'FRAME_CLASS 1\nFRAME_TYPE 1\nMOT_BAT_VOLT_MAX 0\nMOT_BAT_VOLT_MIN 0\nMOT_PWM_MAX 2000\nMOT_PWM_MIN 1000\n';
    expect(ardupilotParameterProfile({ sha256: fixtureSha256, manifest: quad })).toBe(golden);
  });

  it('emits only parameter names with repository evidence', () => {
    const evidence = ['../scripts/sitl/driver.mjs', '../scripts/prepare-autopilot-parity.mjs', '../packages/autopilot/src/external-sitl.ts']
      .map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
    const names = ardupilotParameterProfile({ sha256: fixtureSha256, manifest: quad }).split('\n')
      .filter(line => line !== '' && !line.startsWith('#')).map(line => line.split(' ')[0]!);
    expect(names.length).toBe(6);
    for (const name of names) expect(new RegExp(`\\b${name}\\b`).test(evidence), name).toBe(true);
  });

  it('refuses vehicles without a frame, without every ESC range or with differing ranges', () => {
    const profile = (input: unknown) => ardupilotParameterProfile({ sha256: fixtureSha256, manifest: validateVehicleManifest(input) });
    expect(() => ardupilotParameterProfile({ sha256: 'ABC', manifest: quad })).toThrow('hash');
    expect(() => profile(edit(c => { c.ardupilot = null; }))).toThrow('frame');
    expect(() => profile(edit(c => { c.escs = c.escs.slice(0, 3); }))).toThrow('Rotor 3');
    expect(() => profile(edit(c => { c.escs = c.escs.map((e, i) => (i === 2 ? { ...e, pwmMaxUs: 1900 } : e)); }))).toThrow('differ');
    expect(() => profile(edit(c => { c.escs = c.escs.map(e => ({ ...e, pwmMinUs: 1100, pwmMaxUs: 1900 })); }))).not.toThrow();
  });
});

/** Session plumbing only: demo integration labelled with the loaded model's identity. */
class LoadedDemo extends DemoDynamics {
  readonly modelId: number; readonly rotorCount: number; disposed = false;
  constructor(hz: PhysicsHz, model: ModelDescriptor) { super(hz); this.modelId = model.modelId; this.rotorCount = model.rotorCount; }
  dispose(): void { this.disposed = true; }
}
function sessionHarness(models: SessionModelPort | null) {
  const stateBuffer = createSharedMemoryV2();
  const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'),
    actuatorBuffer: createSpscQueue('actuator') }, { monotonicMs: () => 0, wallMs: () => 1_790_000_000_000 }, undefined, null, models);
  const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2(), state = newFlightStateV2();
  const results: CommandResultV2[] = [];
  let requestId = 0;
  const command = async (type: string, extra: Record<string, unknown> = {}) => {
    reader.readHeader(header);
    session.handle({ protocolVersion: 2, requestId: ++requestId, expectedEpoch: header.sessionEpoch, type, ...extra });
    await session.settled();
    session.drain(result => results.push(result));
    return results.at(-1);
  };
  const modelId = () => { expect(reader.latest(state)).toBe(true); return state.modelId; };
  return { session, command, modelId };
}

describe('model.load admission through the session model port', () => {
  const bodyOnly = validateVehicleManifest(edit(c => {
    c.modelId = 88; c.motors = []; c.escs = []; c.battery = null; c.airframe = { drag: null }; c.sensorMounts = [];
    c.ardupilot = null; c.datasets = [c.datasets[0]!];
    c.provenance = { ...c.provenance, motors: null, escs: null, battery: null, airframeDrag: null, sensorMounts: null };
  }));
  async function setup() {
    const registry = new VehicleRegistry(), built: LoadedDemo[] = [];
    const v2 = encode(bodyOnly), v1 = encode(demoQuad);
    await registry.register(v2, digest(v2));
    await registry.register(v1, digest(v1));
    await registry.register(fixtureBytes, fixtureSha256);
    const port = registryModelPort(registry, (model, hz) => { const d = new LoadedDemo(hz, model); built.push(d); return d; });
    return { built, v2Sha: digest(v2), v1Sha: digest(v1), harness: sessionHarness(port) };
  }

  it('loads a hashed v2 vehicle, advances the epoch and rebuilds it on configure', async () => {
    const { built, v2Sha, harness: h } = await setup();
    expect(h.modelId()).toBe(1);
    // Control Protocol v2 accepts upper-case hex; the registry hash is lower case.
    expect(await h.command('model.load', { modelId: 88, manifestSha256: v2Sha.toUpperCase() }))
      .toMatchObject({ type: 'ack-v2', status: 'applied', epoch: 2 });
    expect(h.modelId()).toBe(88);
    expect(h.session.rotorCount()).toBe(4);
    expect(built.map(d => d.hz)).toEqual([400]);
    expect(await h.command('sim.configure', { hz: 800, clockMode: 'interactive' })).toMatchObject({ status: 'applied', epoch: 3 });
    expect(built.map(d => [d.hz, d.modelId])).toEqual([[400, 88], [800, 88]]);
    expect(built[0]!.disposed).toBe(true);
    expect(h.modelId()).toBe(88);
  });

  it('loads a hashed v1 model and keeps the active model on every rejection', async () => {
    const { v1Sha, v2Sha, harness: h } = await setup();
    expect(await h.command('model.load', { modelId: 1, manifestSha256: v1Sha })).toMatchObject({ status: 'applied', epoch: 2 });
    const rejected: [Record<string, unknown>, string][] = [
      [{ modelId: 99, manifestSha256: v2Sha }, 'not registered'],
      [{ modelId: 88, manifestSha256: v1Sha }, 'hash does not match'],
      [{ modelId: 87, manifestSha256: fixtureSha256 }, 'cannot consume motors (TASK-092)'],
    ];
    for (const [extra, message] of rejected) {
      const result = await h.command('model.load', extra);
      expect(result).toMatchObject({ type: 'reject-v2', code: 'ASSET_MISSING' });
      expect(result?.type === 'reject-v2' ? result.message : '').toContain(message);
      expect(h.session.currentEpoch).toBe(2);
      expect(h.modelId()).toBe(1);
    }
  });

  it('rejects dynamics that report another model and keeps the demo default without a port', async () => {
    const registry = new VehicleRegistry(), v2 = encode(bodyOnly);
    await registry.register(v2, digest(v2));
    const mislabelled = registryModelPort(registry, (model, hz) => new LoadedDemo(hz, { ...model, modelId: 5 }));
    const h = sessionHarness(mislabelled);
    expect(await h.command('model.load', { modelId: 88, manifestSha256: digest(v2) })).toMatchObject({ code: 'ASSET_MISSING' });
    expect(h.modelId()).toBe(1);
    const throwing = sessionHarness({ prepare: () => { throw new Error('port failed synchronously'); } });
    const thrown = await throwing.command('model.load', { modelId: 88, manifestSha256: digest(v2) });
    expect(thrown?.type === 'reject-v2' ? thrown.message : '').toContain('port failed synchronously');
    const plain = sessionHarness(null);
    const result = await plain.command('model.load', { modelId: 88, manifestSha256: digest(v2) });
    expect(result?.type === 'reject-v2' ? result.message : '').toContain('no model registry');
    expect(plain.modelId()).toBe(1);
  });
});

