import { describe, expect, it } from 'vitest';
import { BarometerEffect, BarometerErrors, BarometerInput, barometerGlitchM } from '@mirage/physics/barometer';
import { barometerAltitudePerPascal } from '@mirage/aircraft/sensor-parameters';

// TASK-116: the barometer v2 errors against their closed forms, worked by hand from the inputs below. Tolerance 1e-12
// relative: each value is a handful of floating-point operations, so anything larger is a wrong formula, not round-off.

const RHO = 1.2, T_K = 288.15;
/** A quad of four 10 in propellers (R = 0.127 m) at 1.5 kg in hover: T = m·g. */
const R = 0.127, AREA = 4 * Math.PI * R * R, THRUST = 1.5 * 9.80665;
const INDUCED = THRUST / (4 * AREA);

function model(height = 0.5 * R, air: readonly [number, number, number] = [10, -3, 2], timeS = 0, temperatureK = T_K): BarometerErrors {
  const b = new BarometerErrors();
  write(b, height, air, timeS, temperatureK);
  return b;
}
function write(b: BarometerErrors, height: number, air: readonly [number, number, number], timeS: number, temperatureK = T_K): void {
  const x = b.input;
  x[BarometerInput.DensityKgM3] = RHO; x[BarometerInput.TemperatureK] = temperatureK;
  x[BarometerInput.AirForwardMps] = air[0]; x[BarometerInput.AirRightMps] = air[1]; x[BarometerInput.AirDownMps] = air[2];
  x[BarometerInput.HeightM] = height; x[BarometerInput.ThrustN] = THRUST; x[BarometerInput.DiscAreaM2] = AREA;
  x[BarometerInput.MeanRadiusM] = R; x[BarometerInput.TimeS] = timeS;
}
/** One step, then its error. */
const stepped = (b: BarometerErrors): number => { b.step(); return b.errorPa; };
const close = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(expected)));

describe('barometer v2 errors (TASK-116)', () => {
  it('with every effect off computes nothing: the error is exactly 0', () => {
    const b = model();
    expect(b.active).toBe(false);
    expect(Object.is(stepped(b), 0)).toBe(true);
    expect([...b.components]).toEqual([0, 0, 0, 0, 0]);
  });

  it('position error: C·½ρu² per body axis, the coefficient of the direction the vehicle moves through the air', () => {
    const b = model();
    b.set(BarometerEffect.PositionError, true, [0.1, 0.2, 0.3, -0.1, -0.2, -0.3]);
    // Forward 10 m/s takes C+x, left 3 m/s C−y, down 2 m/s C+z.
    close(stepped(b), 0.1 * 0.5 * RHO * 100 + -0.2 * 0.5 * RHO * 9 + 0.3 * 0.5 * RHO * 4);
    close(stepped(b), 5.64);
    write(b, 0.5 * R, [-10, 3, -2], 0);
    close(stepped(b), -0.1 * 60 + 0.2 * 5.4 + -0.3 * 2.4);
  });

  it('ground cushion: k·T/(4A)·exp(−z/(λR)), the hover induced dynamic pressure of momentum theory', () => {
    const b = model(0.5 * R);
    b.set(BarometerEffect.GroundCushion, true, [1.5, 2]);
    close(stepped(b), 1.5 * INDUCED * Math.exp(-0.25));
    // ½ρv_i² with v_i = √(T/(2ρA)) is T/(4A): ρ cancels.
    close(INDUCED, 0.5 * RHO * (THRUST / (2 * RHO * AREA)));
    write(b, 0, [0, 0, 0], 0);
    close(stepped(b), 1.5 * INDUCED);
    write(b, -0.01, [0, 0, 0], 0);
    close(stepped(b), 1.5 * INDUCED);
    write(b, Infinity, [0, 0, 0], 0);
    expect(stepped(b)).toBe(0);
    // No thrust, no cushion.
    write(b, 0, [0, 0, 0], 0);
    b.input[BarometerInput.ThrustN] = -1;
    expect(stepped(b)).toBe(0);
  });

  it('prop wash c·T/(4A), drift r·t + κ·ΔT and the pressure trend τ·t/3600 from the step they go on', () => {
    const b = model(10, [0, 0, 0], 100, 290);
    b.set(BarometerEffect.PropWash, true, [-0.3]);
    b.set(BarometerEffect.Drift, true, [0.02, -5]);
    b.set(BarometerEffect.PressureTrend, true, [-120]);
    close(stepped(b), -0.3 * INDUCED);
    write(b, 10, [0, 0, 0], 160, 292);
    stepped(b);
    close(b.components[BarometerEffect.Drift]!, 0.02 * 60 + -5 * 2);
    close(b.components[BarometerEffect.PressureTrend]!, (-120 / 3600) * 60);
    close(b.errorPa, -0.3 * INDUCED + 1.2 - 10 - 2);
    // Off forgets the start: on again starts from zero.
    b.set(BarometerEffect.Drift, false, []);
    expect(b.components[BarometerEffect.Drift]).toBe(0);
    b.set(BarometerEffect.Drift, true, [0.02, -5]);
    stepped(b);
    expect(b.components[BarometerEffect.Drift]).toBe(0);
  });

  it('switching every effect off, or reset, leaves no trace', () => {
    const b = model();
    b.set(BarometerEffect.GroundCushion, true, [1, 1]);
    b.set(BarometerEffect.PositionError, true, [1, 1, 1, 1, 1, 1]);
    expect(stepped(b)).not.toBe(0);
    b.set(BarometerEffect.GroundCushion, false, []);
    b.set(BarometerEffect.PositionError, false, []);
    expect(b.active).toBe(false);
    expect(Object.is(b.errorPa, 0)).toBe(true);
    expect(stepped(b)).toBe(0);
    b.set(BarometerEffect.PropWash, true, [1]);
    b.reset();
    expect([b.active, b.errorPa, stepped(b)]).toEqual([false, 0, 0]);
    expect(() => b.set(BarometerEffect.Drift, true, [1])).toThrow('takes 2 values');
  });

  it('turns a pressure error into ArduPilot\'s barometer offset at the home altitude, as TASK-147 turns the bias', () => {
    const dhdp = barometerAltitudePerPascal(584);
    expect(dhdp).toBeLessThan(0);
    // A pressure 10 Pa higher reads about 0.86 m lower at 584 m (ISA, ρ ≈ 1.157 kg/m³).
    expect(barometerGlitchM(0, 10, dhdp)).toBeCloseTo(-10 / (1.1567 * 9.80665), 2);
    expect(barometerGlitchM(0.5, 10, dhdp)).toBe(Math.fround(0.5 + 10 * dhdp));
    expect(barometerGlitchM(0.5, 0, dhdp)).toBe(Math.fround(0.5));
  });
});
