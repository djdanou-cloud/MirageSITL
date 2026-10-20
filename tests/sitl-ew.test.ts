import { expect, it } from 'vitest';
import { EwObservations, PLAN } from '../scripts/sitl/ew-observations.ts';
import { nodeCheck } from './support/node-evidence';

it('injects a 30 m north GPS step without changing source truth or velocity', () => {
  const ew = new EwObservations('position-step'), p = new Float64Array([0, 0, -10]), v = new Float64Array(3);
  ew.sample(1, p, v); const before = [ew.gps.latitudeRad, ew.gps.longitudeRad, ew.gps.altitudeMslM];
  ew.setActive(true, 800); ew.advance(1); ew.sample(1, p, v);
  // Independent local meridional radius at the home latitude (WGS84).
  const lat = -35.362938 * Math.PI / 180, e2 = 6.6943799901413165e-3;
  const radius = 6378137 * (1 - e2) / (1 - e2 * Math.sin(lat) ** 2) ** 1.5 + 594;
  expect((ew.distorted.latitudeRad - before[0]!) * radius).toBeCloseTo(30, 3);
  expect(ew.distorted.vnMps).toBe(0); expect([...p]).toEqual([0, 0, -10]); expect([...v]).toEqual([0, 0, 0]);
  ew.setActive(false, 801); ew.sample(2, p, v); expect(ew.distorted).toEqual(ew.gps);
});
it('maps magnetic bias sign/units, jamming denial/recovery, coherent drift, and actuator loss independently', () => {
  const mag = new EwObservations('magnetic'); mag.setActive(true, 0);
  expect(mag.compassOffsetsMilliGauss()).toEqual([-300, -200, -0]);
  const p = new Float64Array([0, 0, -10]), v = new Float64Array(3);
  const jam = new EwObservations('jamming'); jam.setActive(true, 0);
  for (let i = 1; i <= 1600; i++) jam.advance(i / 800);
  jam.sample(2, p, v); expect(jam.distorted.fixType).toBe(0); expect(jam.distorted.hdop).toBeGreaterThan(90);
  jam.setActive(false, 1600); for (let i = 1601; i <= 4800; i++) jam.advance(i / 800);
  jam.sample(6, p, v); expect(jam.distorted.fixType).toBe(3);
  const drift = new EwObservations('velocity-drift'); drift.setActive(true, 0);
  for (let i = 1; i <= 1600; i++) drift.advance(i / 800);
  drift.sample(2, p, v); expect(drift.distorted.vnMps).toBeCloseTo(1, 8);
  const motor = new EwObservations('motor-loss'); motor.setActive(true, 0);
  expect([...motor.thrustFractions]).toEqual([0, 1, 1, 1]);
  expect(PLAN.effects['motor-loss'].remainingThrustFraction).toBe(0);
  expect(() => new EwObservations('unknown')).toThrow();
});
it('removes the failed rotor force and yaw wrench after lag', () => nodeCheck(`
import {quadWrench} from './scripts/sitl/quad.mjs';
const u=new Float64Array([1,1,1,1]),base=quadWrench(u),failed=quadWrench(u,new Float64Array(6),new Float64Array([0,1,1,1]));
assert.equal(base[2],-40);assert.equal(failed[2],-30);
assert(Math.abs(failed[3]-10*0.2/Math.sqrt(2))<1e-12);assert(Math.abs(failed[5]+0.17)<1e-12);
assert.throws(()=>quadWrench(u,new Float64Array(6),new Float64Array([2,1,1,1])));
`));
