import { describe, expect, it } from 'vitest';
import { ACCIDENT_OUTBOX_CAPACITY, ACCIDENT_RULES, AccidentMonitor, accidentRows, describeAccident, type AccidentEvent, type AccidentSource, type ContactShapePart } from '../packages/physics/src/accident.ts';

// TASK-149: the F-09 accident criteria on scripted contact reports. Each
// report is [penetration m, impulse N·s, force N, point (3), touching, 0].

const MASS_KG = 2, WEIGHT_N = MASS_KG * 9.80665;
const PARTS: readonly ContactShapePart[] = [{ part: 'hull', hullId: 0 }, { part: 'hull', hullId: 1 }, { part: 'propeller', rotorId: 1 }, { part: 'propeller', rotorId: 2 }];

class Scripted implements AccidentSource {
  readonly reports = PARTS.map(() => new Float64Array(8));
  readonly speeds = [0, 0];
  contactShapeStateInto(index: number, out: Float64Array): boolean {
    const report = this.reports[index];
    if (!report) return false;
    out.set(report);
    return true;
  }
  rotorSpeedsInto(out: Float64Array): void { for (let i = 0; i < out.length; i++) out[i] = this.speeds[i] ?? 0; }
  touch(shape: number, penetrationM: number, forceN: number, point: readonly number[] = [0.1, -0.2, 0.05]): void {
    this.reports[shape]!.set([penetrationM, forceN / 400, forceN, point[0]!, point[1]!, point[2]!, 1, 0]);
  }
  lift(shape: number): void { this.reports[shape]!.fill(0); }
}

function setup() {
  const source = new Scripted(), monitor = new AccidentMonitor(source, PARTS, [1, 2], MASS_KG);
  const events: AccidentEvent[] = [];
  let tick = 0;
  const step = (): number => { tick++; monitor.at[0] = tick; monitor.at[1] = tick / 400; const raised = monitor.check(); monitor.drain(e => events.push(e)); return raised; };
  return { source, monitor, events, step };
}

describe('F-09 accident criteria', () => {
  it('a hull shape counts from 1 mm of penetration or 5 % of the weight, not below', () => {
    const { source, events, step } = setup();
    source.touch(0, 0.0009, 0.049 * WEIGHT_N);
    expect(step()).toBe(0);
    source.touch(0, ACCIDENT_RULES.penetrationM, 0.01 * WEIGHT_N);
    expect(step()).toBe(1);
    source.lift(0); step();
    source.touch(1, 0, ACCIDENT_RULES.forceOfWeight * WEIGHT_N);
    expect(step()).toBe(1);
    expect(events.map(e => [e.tick, e.part])).toEqual([[2, { part: 'hull', hullId: 0 }], [4, { part: 'hull', hullId: 1 }]]);
    expect(events[0]).toMatchObject({ simTimeS: 2 / 400, penetrationM: 0.001, forceN: 0.01 * WEIGHT_N, rotorSpeedRadS: null, pointBodyM: [0.1, -0.2, 0.05] });
  });

  it('a propeller counts on any contact while its rotor turns, and like the hull once it has stopped', () => {
    const { source, events, step } = setup();
    source.speeds[0] = 0.99 * ACCIDENT_RULES.turningRadS;
    source.touch(2, 1e-6, 0.001);
    expect(step()).toBe(0);
    source.speeds[0] = -ACCIDENT_RULES.turningRadS;
    expect(step()).toBe(1);
    source.lift(2); step();
    source.speeds[1] = 0;
    source.touch(3, 0.0012, 0.001);
    expect(step()).toBe(1);
    expect(events.map(e => [e.part, e.rotorSpeedRadS])).toEqual([[{ part: 'propeller', rotorId: 1 }, -1], [{ part: 'propeller', rotorId: 2 }, 0]]);
  });

  it('raises once per contact: a contact that goes on, a bounce or chatter is not raised again; a strike after 0.25 s clear is', () => {
    const { source, monitor, step } = setup();
    source.touch(0, 0.002, 0);
    expect([step(), step(), step()]).toEqual([1, 0, 0]);
    // Lifted for 10 ticks (25 ms at 400 Hz) and back: the same strike.
    source.lift(0);
    for (let i = 0; i < 10; i++) expect(step()).toBe(0);
    source.touch(0, 0.002, 0);
    expect(step()).toBe(0);
    // Clear for 100 ticks, 0.25 s: the next contact is a new accident.
    source.lift(0);
    for (let i = 0; i < 100; i++) expect(step()).toBe(0);
    source.touch(0, 0.002, 0);
    expect(step()).toBe(1);
    expect(monitor.total).toBe(2);
    // Contact on the support points alone is not a shape report: nothing is raised.
    source.lift(0);
    expect([step(), step()]).toEqual([0, 0]);
  });

  it('several shapes striking on one tick each raise an event, and a full outbox counts the rest', () => {
    const { source, monitor } = setup();
    source.speeds[0] = 100; source.speeds[1] = 100;
    source.touch(2, 0, 1); source.touch(3, 0, 1);
    monitor.at[0] = 7; monitor.at[1] = 7 / 400;
    expect(monitor.check()).toBe(2);
    expect(monitor.pending).toBe(2);
    for (let i = 0; i < ACCIDENT_OUTBOX_CAPACITY; i++) {
      // A second clear of the ground re-arms the disc.
      monitor.at[1] = 10 + 2 * i; source.lift(2); monitor.check();
      monitor.at[1] = 11 + 2 * i; source.touch(2, 0, 1); monitor.check();
    }
    expect(monitor.pending).toBe(ACCIDENT_OUTBOX_CAPACITY);
    expect(monitor.dropped).toBe(2);
    expect(monitor.total).toBe(ACCIDENT_OUTBOX_CAPACITY + 2);
    const ticks: number[] = [];
    expect(monitor.drain(e => ticks.push(e.tick))).toBe(ACCIDENT_OUTBOX_CAPACITY);
    expect(ticks.slice(0, 2)).toEqual([7, 7]);
    monitor.reset();
    expect([monitor.pending, monitor.dropped, monitor.total]).toEqual([0, 0, 0]);
  });

  it('starts clean: construction primes the raising branch and forgets it', () => {
    const { monitor } = setup();
    expect([monitor.pending, monitor.dropped, monitor.total]).toEqual([0, 0, 0]);
    expect(() => new AccidentMonitor(new Scripted(), [{ part: 'propeller', rotorId: 9 }], [1, 2], MASS_KG)).toThrow('unknown rotor 9');
    expect(() => new AccidentMonitor(new Scripted(), PARTS, [1, 2], 0)).toThrow('positive mass');
  });
});

describe('accident records', () => {
  const propeller: AccidentEvent = { tick: 10, simTimeS: 0.025, part: { part: 'propeller', rotorId: 3 }, pointBodyM: [0.2, 0.1, 0.03],
    penetrationM: 0.0004, impulseNs: 0.05, forceN: 20, rotorSpeedRadS: 800 };
  const arm: AccidentEvent = { ...propeller, part: { part: 'hull', hullId: 2 }, rotorSpeedRadS: null };

  it('writes the registry rows of the recording: the part with its load, the point, and the impulse with the rotor speed', () => {
    expect(accidentRows(propeller)).toEqual([[2, 3, 20, 0.0004], [3, 0.2, 0.1, 0.03], [4, 0.05, 800]]);
    expect(accidentRows(arm)).toEqual([[1, 2, 20, 0.0004], [3, 0.2, 0.1, 0.03], [4, 0.05]]);
  });
  it('names the part as the profile does', () => {
    expect(describeAccident(propeller)).toBe('The propeller of motor 3 struck the ground at 0.03 s: 20.0 N, 0.4 mm deep');
    expect(describeAccident(arm, ['The body', 'Arm 1', 'Arm 5', 'Arm 7'])).toBe('Arm 5 struck the ground at 0.03 s: 20.0 N, 0.4 mm deep');
    expect(describeAccident(arm)).toContain('Hull shape 2 struck');
    expect(describeAccident({ ...arm, part: { part: 'hull', hullId: 0 } })).toContain('The body struck');
  });
});
