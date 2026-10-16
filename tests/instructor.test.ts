import { expect, test } from "vitest";
import { CommandLedger } from "../apps/web/src/instructor/commands";
const command = {
  protocolVersion: 2 as const,
  requestId: 1,
  expectedEpoch: 1,
  type: "sim.pause" as const,
};
test("queued is not applied, stale epochs cancel, rejection/reset cannot be hidden by a late ACK", () => {
  const l = new CommandLedger();
  l.track(command);
  expect(l.entries[0]?.status).toBe("pending");
  l.receive(
    {
      type: "ack-v2",
      requestId: 1,
      status: "queued",
      epoch: 1,
      appliedTick: { lo: 0, hi: 0 },
    },
    1,
  );
  expect(l.entries[0]?.status).toBe("queued");
  l.receive(
    {
      type: "ack-v2",
      requestId: 1,
      status: "applied",
      epoch: 1,
      appliedTick: { lo: 4, hi: 0 },
    },
    1,
  );
  expect(l.entries[0]?.status).toBe("applied");
  l.track({ ...command, requestId: 2 });
  l.epochChanged(2);
  l.receive(
    {
      type: "ack-v2",
      requestId: 2,
      status: "applied",
      epoch: 1,
      appliedTick: { lo: 4, hi: 0 },
    },
    2,
  );
  expect(l.entries[1]?.status).toBe("cancelled");
  l.track({ ...command, requestId: 3, expectedEpoch: 2 });
  l.receive(
    {
      type: "reject-v2",
      requestId: 3,
      code: "BAD_STATE",
      message: "Unsupported",
    },
    2,
  );
  expect(l.entries[2]?.status).toBe("rejected");
  l.track({
    ...command,
    requestId: 4,
    expectedEpoch: 2,
    type: "sim.reset",
    seed: 0,
  });
  l.epochChanged(3);
  expect(l.entries[3]?.status).toBe("pending");
  l.receive(
    {
      type: "ack-v2",
      requestId: 4,
      status: "applied",
      epoch: 3,
      appliedTick: { lo: 0, hi: 0 },
    },
    3,
  );
  expect(l.entries[3]?.status).toBe("applied");
  for (let i = 5; i < 100; i++) l.track({ ...command, requestId: i });
  expect(l.entries.length).toBe(32);
});
