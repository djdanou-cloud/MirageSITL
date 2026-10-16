import { expect, it } from "vitest";
import {
  RcOverride,
  PilotRcMapper,
  pwm,
  rcSentinel,
} from "../packages/mavlink/src/rc-override";
import {
  parseCalibration,
  saveCalibration,
  loadCalibration,
} from "../packages/input/src/calibration-store";
import {
  defaultCalibration,
  GamepadAdapter,
} from "../packages/input/src/index";
import {
  defaultModeCalibration,
  modeSlot,
} from "../packages/input/src/mode-channel";
import {
  newInput,
  newPilotInputV2,
  ControlFlag,
  UNKNOWN_U32,
} from "@mirage/protocol";
it("uses PWM endpoints and the two channel-group sentinel contracts", () => {
  expect([pwm(-1), pwm(0), pwm(1), pwm(0, true), pwm(1, true)]).toEqual([
    1000, 1500, 2000, 1000, 2000,
  ]);
  expect(pwm(NaN)).toBe(-1);
  expect(rcSentinel(8, "release")).toBe(0);
  expect(rcSentinel(9, "release")).toBe(65534);
  expect(rcSentinel(9, "ignore")).toBe(65535);
  const c = new Uint16Array(18).fill(65535),
    r = new RcOverride();
  c[0] = 1000;
  c[8] = 65534;
  expect(r.into(c, 1, 1)).toBe(true);
  const v = new DataView(r.payload.buffer);
  expect(v.getUint16(0, true)).toBe(1000);
  expect(v.getUint8(16)).toBe(1);
  expect(v.getUint16(18, true)).toBe(65534);
  c[0] = 65534;
  expect(r.into(c, 1, 1)).toBe(false);
});
it("persists validated versioned calibration and rejects malformed storage and duplicate mode axes", () => {
  const values = new Map<string, string>(),
    store = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
  expect(saveCalibration(store, defaultCalibration())).toBe(true);
  expect(loadCalibration(store)?.axes).toEqual(defaultCalibration());
  expect(parseCalibration({ schemaVersion: 2 })).toBeNull();
  const mode = defaultModeCalibration();
  mode.enabled = true;
  expect(modeSlot(-1, mode)).toBe(0);
  expect(modeSlot(1, mode)).toBe(5);
  expect(modeSlot(0, mode)).toBe(3);
  expect(modeSlot(NaN, mode)).toBe(-1);
  mode.axis.axis = 0;
  expect(saveCalibration(store, defaultCalibration(), mode)).toBe(false);
  expect(
    loadCalibration({ getItem: () => "{bad", setItem: () => undefined }),
  ).toBeNull();
});
it("a missing enabled mode axis fails closed and drops every stick value", () => {
  const pad = {
    connected: true,
    index: 0,
    id: "test-radio",
    axes: [0.5, 0, -1, 0],
  };
  const a = new GamepadAdapter(defaultCalibration(), () => [pad]),
    out = newInput();
  a.modeCalibration.enabled = true;
  a.poll(out, 0, true);
  expect(a.status).toBe("invalid-axes");
  expect(out.flags).toBe(0);
  expect(out.roll).toBe(0);
  a.modeCalibration.axis.axis = 0;
  a.poll(out, 1, true);
  expect(a.status).toBe("invalid-axes");
  expect(out.flags).toBe(0);
});

it("maps actual pilot channels and mode slots, releases only owned channels on disconnect", () => {
  const input = newPilotInputV2(),
    m = new PilotRcMapper([1, 2, 3, 4, 10]);
  input.flags = ControlFlag.Connected;
  input.roll = -1;
  input.pitch = 1;
  input.yaw = 0;
  input.throttle = 0.5;
  input.calibratedModeSlot = 5;
  expect(m.mapInto(input)).toBe(true);
  expect(Array.from(m.channels.slice(0, 5))).toEqual([
    1000, 2000, 1500, 1500, 65535,
  ]);
  expect(m.channels[9]).toBe(1900);
  input.calibratedModeSlot = UNKNOWN_U32;
  m.mapInto(input);
  expect(m.channels[9]).toBe(65535);
  input.flags = 0;
  m.mapInto(input);
  expect(m.channels[0]).toBe(0);
  expect(m.channels[9]).toBe(65534);
  expect(m.channels[17]).toBe(65535);
});
