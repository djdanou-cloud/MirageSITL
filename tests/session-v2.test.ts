import { describe, expect, it, vi } from 'vitest';
import { AarRecord } from '@mirage/aar/record';
import { RecordFlag } from '@mirage/aar/format';
import { RecordingHandoff, createRecordingQueue } from '@mirage/aar/handoff';
import { EwEngine } from '@mirage/ew/engine';
import { MotorFaults } from '@mirage/physics/motor-fault';
import { PhysicsSessionV2, isaPressurePa, type SessionFaultPort } from '@mirage/physics';
import { ActuatorFrameCodecV2, HeaderV2, PilotFlagV2, PilotReaderV2, PilotWriterV2, RuntimeFlagV2, SensorFrameCodecV2, SensorKindV2, SensorValidityV2, SpscProducer, StateReaderV2,
  EwFlagV2, VehicleFlagV2, createSharedMemoryV2, createSpscQueue, newActuatorFrameV2, newFlightStateV2, newHeaderSnapshotV2,
  newPilotInputV2, newSensorFrameV2, tickToNumber, type CommandResultV2 } from '@mirage/protocol';

/** A Main-side harness around a real PhysicsSessionV2 with a controllable clock. */
function faultPort(): SessionFaultPort {
  const motors = new MotorFaults([0, 1, 2, 3]);
  const engine = new EwEngine(motors);
  return {
    apply: (command, tick) => engine.apply(command, tick),
    reset: (seed) => engine.reset(seed),
    advanceInto: (context) => engine.advanceInto({
      dtS: context.dtS, simTimeS: context.simTimeS,
      truthNorthM: context.northM, truthEastM: context.eastM, truthDownM: context.downM,
    }),
    get flags() { return engine.flags; },
    get validityFlags() { return motors.vehicleFlags; },
  };
}
function harness(faults: SessionFaultPort | null = null) {
  const time = { mono: 0, wall: 1_790_000_000_000 };
  const stateBuffer = createSharedMemoryV2(), sensorBuffer = createSpscQueue('sensor'), actuatorBuffer = createSpscQueue('actuator');
  const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer, actuatorBuffer },
    { monotonicMs: () => time.mono, wallMs: () => time.wall + time.mono }, undefined, faults);
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
  it('keeps a sample stamped within clock rounding of the read time fresh, and still blocks future-dated samples', () => {
    const h = harness();
    h.command('sim.start');
    h.run(20, () => h.stick(0, true));
    expect(armed(h.latest().vehicleFlags)).toBe(true);
    // Captured in a G3 flight (2026-10-22): age -0.000244140625 ms, one double step at epoch milliseconds.
    h.run(20, () => h.stick(0.7, true, { ageMs: -0.000244140625 }));
    expect(armed(h.latest().vehicleFlags)).toBe(true);
    expect(h.session.pilotRejection.count).toBe(0);
    h.run(20, () => h.stick(0.7, true, { ageMs: -2 })); // beyond the 1 ms clock tolerance
    const s = h.latest();
    expect(armed(s.vehicleFlags)).toBe(false);
    expect(s.vehicleFlags & VehicleFlagV2.InputFailsafe).toBeTruthy();
    expect(h.session.pilotRejection.count).toBe(1);
    expect(h.session.pilotRejection.ageMs).toBe(-2);
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
