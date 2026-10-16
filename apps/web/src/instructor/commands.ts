import type { ControlCommandV2, WorkerEventV2 } from "@mirage/protocol";
export type CommandPayload<T = ControlCommandV2> = T extends ControlCommandV2
  ? Omit<T, "protocolVersion" | "requestId" | "expectedEpoch">
  : never;
export interface CommandEntry {
  requestId: number;
  epoch: number;
  type: string;
  status: "pending" | "queued" | "applied" | "rejected" | "cancelled";
  message: string;
}
export class CommandLedger {
  readonly entries: CommandEntry[] = [];
  track(c: ControlCommandV2): void {
    if (this.entries.length === 32) this.entries.shift();
    this.entries.push({
      requestId: c.requestId,
      epoch: c.expectedEpoch,
      type: c.type,
      status: "pending",
      message: "Waiting for Worker ACK",
    });
  }
  receive(event: WorkerEventV2, currentEpoch: number): void {
    if (event.type !== "ack-v2" && event.type !== "reject-v2") return;
    const entry = this.entries.find((e) => e.requestId === event.requestId);
    if (!entry || entry.status === "cancelled" || entry.status === "rejected")
      return;
    if (event.type === "reject-v2") {
      entry.status = "rejected";
      entry.message = `${event.code}: ${event.message}`;
      return;
    }
    const changesEpoch =
      entry.type === "sim.reset" ||
      entry.type === "sim.configure" ||
      entry.type === "model.load";
    if (
      event.epoch !== entry.epoch &&
      !(changesEpoch && event.epoch === ((entry.epoch + 1) >>> 0 || 1))
    ) {
      entry.status = "cancelled";
      entry.message = "ACK belongs to another epoch";
      return;
    }
    if (entry.epoch !== currentEpoch && !changesEpoch) {
      entry.status = "cancelled";
      entry.message = "Session epoch changed";
      return;
    }
    if (
      changesEpoch &&
      event.status === "applied" &&
      event.epoch !== currentEpoch
    ) {
      entry.status = "cancelled";
      entry.message = "ACK is no longer current";
      return;
    }
    if (entry.status === "applied" && event.status === "queued") return;
    entry.status = event.status;
    entry.message =
      event.status === "applied"
        ? `Applied at tick ${event.appliedTick.hi * 2 ** 32 + event.appliedTick.lo}`
        : "Queued for a simulation tick";
  }
  epochChanged(epoch: number): void {
    for (const e of this.entries)
      if (
        (e.status === "pending" || e.status === "queued") &&
        e.epoch !== epoch &&
        !(
          (e.type === "sim.reset" ||
            e.type === "sim.configure" ||
            e.type === "model.load") &&
          epoch === ((e.epoch + 1) >>> 0 || 1)
        )
      ) {
        e.status = "cancelled";
        e.message = "Cancelled by reset or model/clock change";
      }
  }
  cancelAll(reason: string): void {
    for (const e of this.entries)
      if (e.status === "pending" || e.status === "queued") {
        e.status = "cancelled";
        e.message = reason;
      }
  }
}
