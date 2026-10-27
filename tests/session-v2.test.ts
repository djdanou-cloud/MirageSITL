import { describe, expect, it, vi } from 'vitest';
import { AarRecord } from '@mirage/aar/record';
import { RecordFlag } from '@mirage/aar/format';
import { RecordingHandoff, createRecordingQueue } from '@mirage/aar/handoff';
import { createSessionFaultPort } from '@mirage/ew/session-port';
import { DemoDynamics, PhysicsSessionV2, isaPressurePa, type SessionDynamics, type SessionFaultPort } from '@mirage/physics';
import type { MotorFaults } from '@mirage/physics/motor-fault';
import { ActuatorFrameCodecV2, HeaderV2, PilotFlagV2, PilotReaderV2, PilotWriterV2, RuntimeFlagV2, SensorFrameCodecV2, SensorKindV2, SensorValidityV2, SpscProducer, StateReaderV2,
  EwFlagV2, VehicleFlagV2, createSharedMemoryV2, createSpscQueue, newActuatorFrameV2, newFlightStateV2, newHeaderSnapshotV2,
  newPilotInputV2, newSensorFrameV2, tickToNumber, type CommandResultV2, type EwEffect, type PhysicsHz } from '@mirage/protocol';

/** The physics Worker's own EW port, so these tests drive the fault path the application runs. */
const faultPort = createSessionFaultPort;
/** A Main-side harness around a real PhysicsSessionV2 with a controllable clock. */
function harness(faults: SessionFaultPort | null = null, dynamics?: (hz: PhysicsHz) => SessionDynamics) {
  const time = { mono: 0, wall: 1_790_000_000_000 };
  const stateBuffer = createSharedMemoryV2(), sensorBuffer = createSpscQueue('sensor'), actuatorBuffer = createSpscQueue('actuator');
  const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer, actuatorBuffer },
    { monotonicMs: () => time.mono, wallMs: () => time.wall + time.mono }, dynamics, faults);
  const reader = new StateReaderV2(stateBuffer), pilotWriter = new PilotWriterV2(stateBuffer), header = newHeaderSnapshotV2();
  const state = newFlightStateV2(), previous = newFlightStateV2(), results: CommandResultV2[] = [];
  let requestId = 0;
  const command = (type: string, extra: Record<string, unknown> = {}) => {
    reader.readHeader(header);
    session.handle({ protocolVersion: 2, requestId: ++requestId, expectedEpoch: header.sessionEpoch, type, ...extra });
    session.drain(result => results.push(result));
    return results.at(-1);
  };
  const pilot = newPilotInputV2();
  const stick = (throttle: number, armed: boolean, options: { generation?: number; epoch?: number; ageMs?: number } = {}) => {
    reader.readHeader(header);
    pilot.expectedEpoch = options.epoch ?? header.sessionEpoch; pilot.throttle = throttle;
    pilot.flags = PilotFlagV2.Connected | (armed ? PilotFlagV2.Armed : 0);
    pilot.deviceGeneration = options.generation ?? 0;
    pilot.sampledWallTimeMs = time.wall + time.mono - (options.ageMs ?? 0);
    pilotWriter.publish(pilot);
  };
  /** Advances 1 ms per wakeup, republishing the stick each time like Main's rAF loop. */
  const run = (ms: number, refresh?: () => void) => {
    let last = 0;
    for (let i = 0; i < ms; i++) { time.mono += 1; refresh?.(); last = session.pump(); }
    return last;
  };
  const latest = () => { expect(reader.latest(state)).toBe(true); return state; };
  return { time, session, reader, header, state, previous, results, command, stick, run, latest, actuatorBuffer, sensorBuffer, stateBuffer };
}
const armed = (flags: number) => (flags & VehicleFlagV2.Armed) !== 0;
const jamming: EwEffect = { kind: 'gnss-jamming', severity: 1 };
const motorLoss = (motorIndex: number, mode: 'power-cut' | 'instant-thrust-loss' = 'power-cut', remainingThrustFraction = 0): EwEffect =>
  ({ kind: 'motor-loss', motorIndex, mode, remainingThrustFraction });
/** fault.set fields due at `tick`; the harness adds the envelope. */
const faultAt = (faultId: string, effect: EwEffect, options: { tick?: number; enabled?: boolean } = {}) =>
  ({ atTick: { lo: options.tick ?? 2, hi: 0 }, faultId, enabled: options.enabled ?? true, effect, recovery: 'hold-offset' });
/** Demo flight plus a declared motor-fault input: stands in for a dynamics that reads MotorFaults every step. */
class MotorFaultInput extends DemoDynamics {
  motors: MotorFaults | null = null;
  constructor(hz: PhysicsHz, readonly rotorCount: number) { super(hz); }
  useMotorFaults(motors: MotorFaults): void { this.motors = motors; }
}
function boundTable(dynamics: MotorFaultInput | undefined): MotorFaults {
  if (!dynamics?.motors) throw new Error('The session bound no motor-fault table');
  return dynamics.motors;
}

describe('PhysicsSessionV2 lifecycle', () => {
  it('announces readiness, publishes epoch 1 at tick 0, and steps at tick/hz once started', () => {
    const h = harness();
    expect(h.session.readyEvent()).toEqual({ type: 'ready-v2', protocolVersion: 2, abiVersion: 2, epoch: 1, hz: 400 });
    expect(tickToNumber(h.latest().tickId)).toBe(0);
    expect(h.latest().vehicleFlags & VehicleFlagV2.Paused).toBeTruthy();
    expect(h.command('sim.start')).toMatchObject({ type: 'ack-v2', status: 'applied', epoch: 1 });
    h.reader.readHeader(h.header);
    expect(h.header.runtimeFlags).toBe(RuntimeFlagV2.Ready | RuntimeFlagV2.Running);
    h.run(1000);
    const s = h.latest();
    expect(tickToNumber(s.tickId)).toBe(400);
    expect(s.simTimeS).toBe(1);
    expect(s.epoch).toBe(1); expect(s.modelId).toBe(1);
    expect(h.command('sim.pause')).toMatchObject({ status: 'applied' });
    expect(h.run(50)).toBe(-1);
    expect(tickToNumber(h.latest().tickId)).toBe(400);
  });
  it('reports the ideal specific force of a vehicle resting on the ground and ISA pressure', () => {
    const h = harness();
    h.command('sim.start'); h.run(100);
    const s = h.latest();
    expect(s.vehicleFlags & VehicleFlagV2.GroundContact).toBeTruthy();
    expect(s.specificForceXBodyMps2).toBeCloseTo(0, 6); expect(s.specificForceYBodyMps2).toBeCloseTo(0, 6);
    expect(s.specificForceZBodyMps2).toBeCloseTo(-9.80665, 5); // f_b = R^T (a - g), not free fall
    expect(s.ambientPressurePa).toBeCloseTo(101325, 0);
    expect(isaPressurePa(1000)).toBeCloseTo(89874.6, 0); // US Standard Atmosphere 1976 at 1 km
  });
  it('rejects unsupported scheduled effects and unavailable models without changing state', async () => {
    const h = harness();
    const weather = h.command('weather.set', { atTick: { lo: 10, hi: 0 }, windNedMps: [1, 0, 0], temperatureK: 288, pressurePa: 101325, turbulenceRmsMps: 0, seed: 1 });
    expect(weather).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' });
    expect(h.command('model.load', { modelId: 2, manifestSha256: 'ab'.repeat(32) })).toMatchObject({ status: 'queued' });
    await h.session.settled();
    h.session.drain(result => h.results.push(result));
    expect(h.results.at(-1)).toMatchObject({ type: 'reject-v2', code: 'ASSET_MISSING' });
    expect(h.session.currentEpoch).toBe(1);
    expect(h.command('fault.set', { atTick: { lo: 10, hi: 0 }, faultId: 'unwired', enabled: true,
      effect: { kind: 'gnss-jamming', severity: 1 }, recovery: 'hold-offset' })).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' });
  });
  it('applies an arbitrary fault id through the EW port and publishes its flag', () => {
    const h = harness(faultPort());
    expect(h.command('fault.set', { atTick: { lo: 2, hi: 0 }, faultId: 'arbitrary-fault-42', enabled: true,
      effect: { kind: 'gnss-jamming', severity: 1 }, recovery: 'hold-offset' })).toMatchObject({ type: 'ack-v2', status: 'queued' });
    expect(h.command('weather.set', { atTick: { lo: 2, hi: 0 }, windNedMps: [1, 0, 0], temperatureK: 288, pressurePa: 101325, turbulenceRmsMps: 0, seed: 1 }))
      .toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' });
    h.command('sim.start');
    h.run(50);
    h.session.drain(result => h.results.push(result));
    const applied = h.results.find(result => result.type === 'ack-v2' && result.requestId === 1 && result.status === 'applied');
    expect(applied).toBeTruthy();
    expect(h.latest().ewFlags & EwFlagV2.GnssJamming).toBeTruthy();
    h.command('sim.pause');
    h.command('sim.reset', { seed: 7 });
    expect(h.latest().ewFlags).toBe(0);
  });
});

describe('PhysicsSessionV2 arming and input protection', () => {
  it('arms only at <=5% throttle, then flies on fresh input', () => {
    const h = harness();
    h.command('sim.start');
    h.run(20, () => h.stick(0.5, true));
    expect(armed(h.latest().vehicleFlags)).toBe(false); // high throttle never arms
    h.run(20, () => h.stick(0.5, false));
    h.run(20, () => h.stick(0, true));
    expect(armed(h.latest().vehicleFlags)).toBe(true);
    h.run(2000, () => h.stick(0.7, true));
    expect(h.latest().downM).toBeLessThan(-1);
    expect(h.latest().vehicleFlags & VehicleFlagV2.InputFailsafe).toBe(0);
  });
  it('a changed device_generation disarms and blocks rearming until the arm request is withdrawn', () => {
    const h = harness();
    h.command('sim.start');
    h.run(20, () => h.stick(0, true, { generation: 1 }));
    expect(armed(h.latest().vehicleFlags)).toBe(true);
    h.run(20, () => h.stick(0, true, { generation: 2 })); // a different transmitter, still "armed"
    expect(armed(h.latest().vehicleFlags)).toBe(false);
    h.run(20, () => h.stick(0, true, { generation: 2 }));
    expect(armed(h.latest().vehicleFlags)).toBe(false); // no silent re-arm
    h.run(20, () => h.stick(0, false, { generation: 2 }));
    h.run(20, () => h.stick(0, true, { generation: 2 }));
    expect(armed(h.latest().vehicleFlags)).toBe(true); // explicit rearm
  });
  it('stale epochs and stale samples disarm with zero thrust', () => {
    const h = harness();
    h.command('sim.start');
    h.run(20, () => h.stick(0, true, { epoch: 7 }));
    expect(armed(h.latest().vehicleFlags)).toBe(false);
    h.run(20, () => h.stick(0, true));
    expect(armed(h.latest().vehicleFlags)).toBe(true);
    h.run(20, () => h.stick(0, true, { ageMs: 300 })); // older than 250 ms
    const s = h.latest();
    expect(armed(s.vehicleFlags)).toBe(false);
    expect(s.vehicleFlags & VehicleFlagV2.InputFailsafe).toBeTruthy();
  });
});

describe('PhysicsSessionV2 epochs, rates, and clock modes', () => {
  it('reset and configure start new epochs that break render history; configure changes the rate', () => {
    const h = harness();
    h.command('sim.start'); h.run(100);
    expect(h.command('sim.reset', { seed: 0 })).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' }); // running
    h.command('sim.pause');
    expect(h.command('sim.reset', { seed: 0 })).toMatchObject({ status: 'applied', epoch: 2 });
    const current = newFlightStateV2();
    expect(h.reader.latestPair(current, h.previous)).toBe('latest');
    expect([tickToNumber(current.tickId), current.epoch]).toEqual([0, 2]);
    expect(h.command('sim.configure', { hz: 1200, clockMode: 'interactive' })).toMatchObject({ status: 'applied', epoch: 3 });
    h.reader.readHeader(h.header);
    expect([h.header.physicsHz, h.header.sessionEpoch]).toEqual([1200, 3]);
    h.command('sim.start'); h.run(1000);
    const s = h.latest();
    expect([tickToNumber(s.tickId), s.simTimeS, s.epoch]).toEqual([1200, 1, 3]);
    expect(h.reader.latestPair(current, h.previous)).toBe('pair');
  });
  it('sitl-lockstep waits responsively without actuators and steps exactly on frames for each tick', () => {
    const h = harness();
    h.command('sim.configure', { hz: 400, clockMode: 'sitl-lockstep' });
    h.command('sim.start');
    expect(h.run(500)).toBe(1); // waiting: poll again in 1 ms, never blocks
    expect(tickToNumber(h.latest().tickId)).toBe(0);
    expect(h.command('sim.pause')).toMatchObject({ status: 'applied' }); // still responsive
    h.command('sim.start');
    const producer = new SpscProducer(h.actuatorBuffer, 'actuator', 'sitl-would-block');
    const frame = newActuatorFrameV2(), codec = new ActuatorFrameCodecV2();
    frame.epoch = 2; frame.actuatorCount = 4;
    for (let tick = 1; tick <= 10; tick++) {
      frame.tickId.lo = tick; codec.encode(frame); producer.tryPush(codec.words);
    }
    h.run(20);
    const s = h.latest();
    expect(tickToNumber(s.tickId)).toBe(10);
    expect(s.vehicleFlags & VehicleFlagV2.ActuatorValid).toBeTruthy();
    expect(tickToNumber(s.lastActuatorTick)).toBe(10);
  });
  it('records every physics tick and a consumed sensor or actuator without a second queue consumer', () => {
    const h = harness();
    const handoff = new RecordingHandoff(createRecordingQueue());
    const encoded = new AarRecord();
    const pilot = new Float64Array(4);
    h.session.setRecorder((sample) => {
      for (let i = 0; i < 4; i++) pilot[i] = sample.pilot[i]!;
      if (encoded.encode(sample.state, pilot, sample.sensor, sample.actuator, 0, 0, false)) handoff.push(encoded.words);
    });
    const sensor = new SensorFrameCodecV2();
    const frame = newSensorFrameV2();
    frame.kind = SensorKindV2.Barometer;
    frame.epoch = 1;
    frame.valueCount = 3;
    frame.validityFlags = SensorValidityV2.PayloadValid | SensorValidityV2.TimestampValid;
    frame.values[0] = 101325;
    frame.values[1] = 0;
    frame.values[2] = 288.15;
    frame.sourceId = 1;
    expect(sensor.encode(frame)).toBe(true);
    expect(new SpscProducer(h.sensorBuffer, 'sensor', 'sitl-would-block').tryPush(sensor.words)).toBe('ok');
    h.command('sim.start');
    h.run(40);
    const out = new AarRecord();
    let count = 0, sensorSeen = false, decimated = false;
    while (handoff.pop(out.words)) {
      expect(out.decode()).toBe(true);
      const flags = out.view.getUint32(48, true);
      expect(flags & RecordFlag.Truth).toBeTruthy();
      expect(flags & RecordFlag.Pilot).toBeTruthy();
      if (flags & RecordFlag.Sensor) sensorSeen = true;
      if (flags & RecordFlag.Decimated) decimated = true;
      count++;
    }
    expect(count).toBeGreaterThan(8);
    expect(sensorSeen).toBe(true);
    expect(decimated).toBe(false);
  });
  it('hitl-realtime faults on a missed deadline and stays faulted until a new epoch', () => {
    const h = harness();
    h.command('sim.configure', { hz: 1200, clockMode: 'hitl-realtime' });
    h.command('sim.start'); h.run(100);
    expect(h.session.fault).toBe('');
    h.time.mono += 1000; // the Worker stalled for a second
    expect(h.session.pump()).toBe(-1);
    expect(h.session.fault).toContain('HITL');
    h.reader.readHeader(h.header);
    expect(h.header.runtimeFlags & RuntimeFlagV2.Fault).toBeTruthy();
    const before = tickToNumber(h.latest().tickId);
    h.run(100);
    expect(tickToNumber(h.latest().tickId)).toBe(before);
    h.command('sim.pause'); h.command('sim.reset', { seed: 0 });
    expect(h.session.fault).toBe('');
  });
  it('dispose clears the runtime flags and rejects later commands', () => {
    const h = harness();
    expect(h.command('worker.dispose')).toMatchObject({ status: 'applied' });
    expect(h.session.disposed).toBe(true);
    expect(Atomics.load(new Int32Array(h.stateBuffer), HeaderV2.RuntimeFlags)).toBe(0);
    expect(h.command('sim.start')).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' });
  });
});

describe('PhysicsSessionV2 fault and EW contract', () => {
  it('rejects a position step beyond the 10 km norm at admission; one inside it applies and the session keeps running', () => {
    const h = harness(faultPort());
    // Each component is inside [-10 km, 10 km], but |b| = 11.3 km is beyond the PositionStep kernel envelope.
    expect(h.command('fault.set', faultAt('spoof-far', { kind: 'position-step', offsetNedM: [8000, 8000, 0] })))
      .toMatchObject({ type: 'reject-v2', code: 'OUT_OF_RANGE' });
    expect(h.command('fault.set', faultAt('spoof-near', { kind: 'position-step', offsetNedM: [7000, 7000, 0] })))
      .toMatchObject({ type: 'ack-v2', status: 'queued' });
    h.command('sim.start'); h.run(50);
    h.session.drain(result => h.results.push(result));
    expect(h.session.fault).toBe('');
    expect(h.results.some(r => r.type === 'ack-v2' && r.requestId === 2 && r.status === 'applied')).toBe(true);
    expect(h.latest().ewFlags & EwFlagV2.PositionStep).toBeTruthy();
    expect(tickToNumber(h.latest().tickId)).toBe(20);
  });
  it('reports a fault that cannot take effect at its tick as a final reject, faults the session, and sim.reset recovers it', () => {
    const h = harness(faultPort(), hz => new MotorFaultInput(hz, 16));
    // Four observation effects and twelve motors fill the 16-slot registry; motor 12 cannot be registered.
    const effects: EwEffect[] = [jamming, { kind: 'position-step', offsetNedM: [10, 0, 0] },
      { kind: 'velocity-drift', accelerationNedMps2: [0.1, 0, 0], maxSpeedMps: 2 },
      { kind: 'magnetic', rotationRad: [0, 0, 0.5], biasBodyGauss: [0, 0, 0] },
      ...Array.from({ length: 13 }, (_, motor) => motorLoss(motor))];
    effects.forEach((effect, i) => expect(h.command('fault.set', faultAt(`fault-${i}`, effect))).toMatchObject({ status: 'queued' }));
    h.command('sim.start'); h.run(20);
    h.session.drain(result => h.results.push(result));
    expect(h.results.filter(r => r.type === 'ack-v2' && r.status === 'applied' && r.requestId <= 17)).toHaveLength(16);
    expect(h.results.find(r => r.type === 'reject-v2' && r.requestId === 17))
      .toEqual({ type: 'reject-v2', requestId: 17, code: 'OVERLOAD', message: 'EW fault registry is full' });
    expect(h.session.fault).toBe('EW fault registry is full');
    h.reader.readHeader(h.header);
    expect(h.header.runtimeFlags).toBe(RuntimeFlagV2.Ready | RuntimeFlagV2.Fault);
    // The session stopped on its own: start is refused and reset needs no pause.
    expect(h.command('sim.start')).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' });
    expect(h.command('sim.reset', { seed: 3 })).toMatchObject({ type: 'ack-v2', status: 'applied', epoch: 2 });
    expect(h.session.fault).toBe('');
    expect([h.latest().epoch, h.latest().ewFlags]).toEqual([2, 0]);
    expect(h.command('sim.start')).toMatchObject({ type: 'ack-v2', status: 'applied' });
    h.run(20);
    expect(tickToNumber(h.latest().tickId)).toBe(8);
  });
  it('rejects motor-loss at admission while the active dynamics reads no motor-fault table', () => {
    const h = harness(faultPort());
    const result = h.command('fault.set', faultAt('motor-0', motorLoss(0)));
    expect(result).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' });
    expect(result?.type === 'reject-v2' ? result.message : '').toContain('motor-loss');
    expect(h.command('fault.set', faultAt('motor-0', motorLoss(0), { enabled: false }))).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' });
    expect(h.command('fault.set', faultAt('motor-9', motorLoss(9)))).toMatchObject({ type: 'reject-v2', code: 'OUT_OF_RANGE' });
    expect(h.command('fault.set', faultAt('jam', jamming))).toMatchObject({ type: 'ack-v2', status: 'queued' });
  });
  it('builds the motor table from the active dynamics and rebuilds it with the dynamics on sim.configure', () => {
    const built: MotorFaultInput[] = [];
    const h = harness(faultPort(), hz => { const dynamics = new MotorFaultInput(hz, 6); built.push(dynamics); return dynamics; });
    expect(h.command('fault.set', faultAt('motor-5', motorLoss(5, 'power-cut', 0.25)))).toMatchObject({ status: 'queued' });
    expect(h.command('fault.set', faultAt('motor-2', motorLoss(2, 'instant-thrust-loss', 0)))).toMatchObject({ status: 'queued' });
    expect(h.command('fault.set', faultAt('motor-6', motorLoss(6)))).toMatchObject({ type: 'reject-v2', code: 'OUT_OF_RANGE' });
    h.command('sim.start'); h.run(20);
    expect(h.session.fault).toBe('');
    const first = boundTable(built[0]);
    expect([first.driveTorque(5, 2), first.driveTorque(4, 2), first.outsideValidity(2)]).toEqual([0.5, 2, true]);
    expect(first.driveTorque(6, 2)).toBeNaN(); // motor IDs are exactly 0..5
    expect(h.latest().ewFlags & EwFlagV2.MotorFault).toBeTruthy();
    expect(h.latest().vehicleFlags & VehicleFlagV2.ModelOutsideValidity).toBeTruthy();
    h.command('sim.pause');
    expect(h.command('sim.configure', { hz: 800, clockMode: 'interactive' })).toMatchObject({ status: 'applied', epoch: 2 });
    const second = boundTable(built[1]);
    expect(second).not.toBe(first);
    expect([second.driveTorque(5, 2), second.outsideValidity(2)]).toEqual([2, false]);
    expect(h.latest().ewFlags & EwFlagV2.MotorFault).toBe(0);
    expect(h.latest().vehicleFlags & VehicleFlagV2.ModelOutsideValidity).toBe(0);
  });
  it('re-enabling a fault ID with another effect or motor releases what it held, so one disable clears it', () => {
    const built: MotorFaultInput[] = [];
    const h = harness(faultPort(), hz => { const dynamics = new MotorFaultInput(hz, 4); built.push(dynamics); return dynamics; });
    // TASK-125: the instructor console keeps its fault ID while the effect select changes, and always sends hold-offset.
    const retargets: [number, EwEffect][] = [[2, { kind: 'position-step', offsetNedM: [10, 0, 0] }],
      [6, { kind: 'magnetic', rotationRad: [0, 0, 0.5], biasBodyGauss: [0, 0, 0] }], [10, motorLoss(0)], [14, motorLoss(1)]];
    for (const [tick, effect] of retargets) {
      expect(h.command('fault.set', faultAt('training-fault', effect, { tick }))).toMatchObject({ status: 'queued' });
    }
    expect(h.command('fault.set', faultAt('training-fault', motorLoss(1), { tick: 18, enabled: false }))).toMatchObject({ status: 'queued' });
    const table = boundTable(built[0]);
    h.command('sim.start');
    h.run(20); // tick 8
    expect(h.latest().ewFlags).toBe(EwFlagV2.MagneticAnomaly); // the position step ended at tick 6
    h.run(10); // tick 12
    expect([h.latest().ewFlags, table.driveTorque(0, 2)]).toEqual([EwFlagV2.MotorFault, 0]);
    h.run(10); // tick 16
    expect([table.driveTorque(0, 2), table.driveTorque(1, 2)]).toEqual([2, 0]);
    h.run(10); // tick 20
    h.session.drain(result => h.results.push(result));
    expect(h.results.filter(r => r.type === 'ack-v2' && r.status === 'applied' && r.requestId <= 5)).toHaveLength(5);
    expect([h.session.fault, h.latest().ewFlags, table.driveTorque(1, 2)]).toEqual(['', 0, 2]);
  });
  it('sim.configure clears active faults like sim.reset and keeps the seed of the last reset', () => {
    const port = faultPort(), resets = vi.spyOn(port, 'reset');
    const h = harness(port);
    expect(h.command('sim.reset', { seed: 7 })).toMatchObject({ status: 'applied', epoch: 2 });
    expect(h.command('fault.set', faultAt('jam', jamming))).toMatchObject({ status: 'queued' });
    h.command('sim.start'); h.run(20); h.command('sim.pause');
    expect(h.latest().ewFlags & EwFlagV2.GnssJamming).toBeTruthy();
    expect(h.command('sim.configure', { hz: 800, clockMode: 'interactive' })).toMatchObject({ status: 'applied', epoch: 3 });
    expect(h.latest().ewFlags).toBe(0);
    expect(resets.mock.calls.map(([seed]) => seed)).toEqual([7, 7]);
  });
  it('a session fault stops the session, so sim.reset recovers it while the pilot still holds arm', () => {
    const h = harness();
    h.command('sim.configure', { hz: 1200, clockMode: 'hitl-realtime' });
    h.command('sim.start');
    h.run(50, () => h.stick(0, true));
    expect(armed(h.latest().vehicleFlags)).toBe(true);
    h.time.mono += 1000; // the Worker stalled for a second
    h.stick(0, true);
    expect(h.session.pump()).toBe(-1);
    expect([h.session.fault !== '', h.session.running, h.session.isArmed()]).toEqual([true, false, false]);
    expect(h.command('sim.start')).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' });
    expect(h.command('sim.reset', { seed: 0 })).toMatchObject({ type: 'ack-v2', status: 'applied', epoch: 3 });
    expect(h.session.fault).toBe('');
    h.reader.readHeader(h.header);
    expect(h.header.runtimeFlags).toBe(RuntimeFlagV2.Ready);
    expect(h.command('sim.start')).toMatchObject({ type: 'ack-v2', status: 'applied' });
    h.run(50);
    expect(tickToNumber(h.latest().tickId)).toBe(60);
  });
});

it('timestamps pilot freshness after the coherent read so a concurrent publication cannot spuriously block arming', () => {
  const h = harness();h.command('sim.start');h.run(20,()=>h.stick(0,true));
  expect(armed(h.latest().vehicleFlags)).toBe(true);
  const referenceReader=new PilotReaderV2(h.stateBuffer);
  const original=referenceReader.latest.bind(referenceReader);
  const reader = vi.spyOn(PilotReaderV2.prototype,'latest').mockImplementation(function(this:PilotReaderV2,out){
    h.time.mono+=0.125;h.stick(0,true);
    return original(out);
  });
  try {h.run(10);expect(armed(h.latest().vehicleFlags)).toBe(true);expect(h.latest().vehicleFlags&VehicleFlagV2.InputFailsafe).toBe(0);}
  finally {reader.mockRestore();}
  h.run(20,()=>h.stick(0,true,{ageMs:-1000}));
  expect(armed(h.latest().vehicleFlags)).toBe(false);expect(h.latest().vehicleFlags&VehicleFlagV2.InputFailsafe).toBeTruthy();
});
