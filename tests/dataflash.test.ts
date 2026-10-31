// TASK-178 (S14, S15): DataFlash reader and writer. Oracle: pymavlink 2.4.50
// DFReader's decoding of a reference log cut from a real pinned-SITL log
// (tests/fixtures/dataflash/reference.json, scripts/generate-dataflash-fixtures.py),
// damaged copies whose ranges the generator chose, and, when the pinned
// Python environment is present, DFReader re-reading the writer's output.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DataflashReader, readDataflash, type Column, type DataflashLog } from "../packages/dataflash/src/reader.ts";
import { DataflashWriter, MIRAGE_MESSAGES } from "../packages/dataflash/src/writer.ts";
import { createDataflashHandler, type DataflashResponse } from "../packages/dataflash/src/dataflash.worker.ts";

interface FixtureMessage { type: string; timestampS: number; values: Record<string, unknown> }
interface Damaged { id: string; ranges: [number, number, string][]; pymavlinkMessages: number; base64: string }
interface Fixture {
  referenceBase64: string; referenceSha256: string; gpsTimeBaseS: number; units: Record<string, Record<string, string>>;
  messages: FixtureMessage[]; damaged: Damaged[]; ardupilotLogNames: string[];
}
const parsed: unknown = JSON.parse(readFileSync(new URL("./fixtures/dataflash/reference.json", import.meta.url), "utf8"));
// The registry pins this file's SHA-256 (tests/fixtures.test.ts); its shape is checked by use below.
const fixture = parsed as Fixture;
const reference = new Uint8Array(Buffer.from(fixture.referenceBase64, "base64"));
const PYTHON = new URL("../.cache/task-127/venv/bin/python", import.meta.url).pathname;

/** A fixture value in the reader's representation. */
function expected(value: unknown): unknown {
  if (value === "NaN") return NaN;
  if (value === "Infinity") return Infinity;
  if (value === "-Infinity") return -Infinity;
  if (typeof value === "object" && value !== null && "base64" in value) return new Uint8Array(Buffer.from(String(value.base64), "base64"));
  if (Array.isArray(value)) return Int16Array.from(value.map(Number));
  return value;
}
function cell(column: Column, row: number): unknown {
  return column[row];
}
function totalRows(log: DataflashLog): number {
  let rows = 0;
  for (const table of log.tables.values()) rows += table.count;
  return rows;
}
function compare(log: DataflashLog): string[] {
  const differences: string[] = [];
  const byType = new Map<string, FixtureMessage[]>();
  for (const message of fixture.messages) byType.set(message.type, [...(byType.get(message.type) ?? []), message]);
  if (totalRows(log) !== fixture.messages.length) differences.push(`${totalRows(log)} records, pymavlink ${fixture.messages.length}`);
  for (const [type, messages] of byType) {
    const table = log.tables.get(type);
    if (!table) { differences.push(`no ${type} table`); continue; }
    if (table.count !== messages.length) differences.push(`${type}: ${table.count} rows, pymavlink ${messages.length}`);
    messages.forEach((message, row) => {
      if (!Object.is(table.timestampS[row], message.timestampS)) differences.push(`${type}[${row}] time ${table.timestampS[row]} != ${message.timestampS}`);
      for (const [name, value] of Object.entries(message.values)) {
        const column = table.columns[name];
        if (!column) { differences.push(`${type}.${name} missing`); continue; }
        const got = cell(column, row), want = expected(value);
        const equal = want instanceof Int16Array || want instanceof Uint8Array
          ? got instanceof want.constructor && Buffer.from((got as Int16Array | Uint8Array).buffer).equals(Buffer.from(want.buffer))
          : Object.is(got, want);
        if (!equal) differences.push(`${type}[${row}].${name}: ${String(got)} != ${String(want)}`);
      }
    });
  }
  return differences;
}

describe("DataFlash reader against pymavlink DFReader", () => {
  test("the reference log is the one the fixture names", () => {
    expect(createHash("sha256").update(reference).digest("hex")).toBe(fixture.referenceSha256);
  });
  test.each([1, 3, 89, 4096, 1 << 20])("decodes every value, timestamp and unit identically in chunks of %i bytes", chunk => {
    const log = readDataflash(reference, chunk);
    expect(log.damaged).toEqual([]);
    expect(compare(log)).toEqual([]);
    expect(log.gpsTimeBaseS).toBe(fixture.gpsTimeBaseS);
    for (const format of log.formats.values()) {
      const want = fixture.units[format.name];
      if (want) expect(Object.fromEntries(format.columns.map((column, i) => [column, format.units?.[i] ?? ""]))).toEqual(want);
      else expect(format.units).toBeNull();
    }
  });
  test.each(fixture.damaged.map(item => [item.id, item] as const))("reports the damaged range of the %s copy and keeps every other record", (_, item) => {
    const log = readDataflash(new Uint8Array(Buffer.from(item.base64, "base64")), 777);
    expect(log.damaged.map(range => [range.start, range.end, range.reason])).toEqual(item.ranges);
    expect(totalRows(log)).toBe(item.pymavlinkMessages);
  });
  test("refuses an FMT record whose format does not fit its length", () => {
    const fmt = new Uint8Array(89);
    fmt.set([0xa3, 0x95, 0x80, 0x40, 3 + 4]);
    fmt.set(Buffer.from("BADX"), 5);
    fmt.set(Buffer.from("QQ"), 9);
    fmt.set(Buffer.from("A,B"), 25);
    const log = readDataflash(fmt);
    expect(log.damaged).toEqual([{ start: 0, end: 89, reason: "invalid-format" }]);
    expect(log.formats.has(0x40)).toBe(false);
    const reader = new DataflashReader();
    reader.push(reference.subarray(0, 10));
    reader.finish();
    expect(() => reader.push(reference)).toThrow(/finished/);
  });
});

describe("DataFlash writer", () => {
  function sample(): DataflashWriter {
    const writer = new DataflashWriter();
    writer.truth(1_000_000, [1.5, -2.25, -10.125], [0.5, 0.25, -0.125], [1, 0, 0, 0]);
    writer.motor(1_000_000, 3, 1500, 0.4, 7200.5, 4.25, 15.75, NaN);
    writer.event(1_250_000, 7, "Motor 3 fault injected");
    writer.parameter(1_500_000, "MOT_THST_EXPO", 0.65, NaN, "requested", "");
    writer.parameter(1_520_000, "MOT_THST_EXPO", 0.65, 0.65, "confirmed", "read back");
    writer.parameter(1_530_000, "WP_SPD", 50, 10, "rejected", "out of range");
    writer.truth(2 ** 40 + 7, [0, 0, 0], [0, 0, 0], [0.5, 0.5, 0.5, 0.5]);
    return writer;
  }
  test("uses names the pinned ArduPilot never logs", () => {
    const names = new Set(fixture.ardupilotLogNames);
    for (const message of MIRAGE_MESSAGES) expect(names.has(message.name)).toBe(false);
  });
  test("output re-parses to the written values, with units", () => {
    const bytes = sample().bytes();
    const log = readDataflash(bytes, 50);
    expect(log.damaged).toEqual([]);
    const truth = log.tables.get("MTRU")!, motor = log.tables.get("MMOT")!, event = log.tables.get("MEVT")!, parameter = log.tables.get("MPRM")!;
    expect(Array.from(truth.columns.TimeUS as Float64Array)).toEqual([1_000_000, 2 ** 40 + 7]);
    expect(Array.from(truth.columns.PE as Float64Array)).toEqual([-2.25, 0]);
    expect(Array.from(truth.columns.QX as Float64Array)).toEqual([0, 0.5]);
    expect((motor.columns.RPM as Float64Array)[0]).toBe(Math.fround(7200.5));
    expect((motor.columns.Thr as Float64Array)[0]).toBe(Math.fround(0.4));
    expect((motor.columns.Temp as Float64Array)[0]).toBeNaN();
    expect(event.columns.Text).toEqual(["Motor 3 fault injected"]);
    expect(parameter.columns.Name).toEqual(["MOT_THST_EXPO", "MOT_THST_EXPO", "WP_SPD"]);
    expect(Array.from(parameter.columns.Stat as Float64Array)).toEqual([0, 1, 2]);
    expect((parameter.columns.Conf as Float64Array)[0]).toBeNaN();
    expect(truth.format.units).toEqual(["µs", "m", "m", "m", "m/s", "m/s", "m/s", "", "", "", ""]);
    expect(motor.format.units).toEqual(["µs", "instance", "us", "", "rpm", "A", "V", "degC"]);
    expect(Array.from(truth.timestampS)).toEqual([1_000_000 * 0.000001, (2 ** 40 + 7) * 0.000001]);
    // Writing again reproduces the same bytes.
    expect(Buffer.from(sample().bytes()).equals(Buffer.from(bytes))).toBe(true);
  });
  test("refuses values that do not fit their fields", () => {
    const writer = new DataflashWriter();
    expect(() => writer.truth(-1, [0, 0, 0], [0, 0, 0], [1, 0, 0, 0])).toThrow(/integer/);
    expect(() => writer.truth(1.5, [0, 0, 0], [0, 0, 0], [1, 0, 0, 0])).toThrow(/integer/);
    expect(() => writer.truth(0, [0, 0], [0, 0, 0], [1, 0, 0, 0])).toThrow(/3 position/);
    expect(() => writer.motor(0, 256, 1500, 0, 0, 0, 0, 0)).toThrow(/0 to 255/);
    expect(() => writer.event(0, 1, "é")).toThrow(/printable ASCII/);
    expect(() => writer.event(0, 1, "x".repeat(65))).toThrow(/at most 64/);
    expect(() => writer.parameter(0, "lower", 1, 1, "confirmed", "")).toThrow(/name/);
  });
  test.skipIf(!existsSync(PYTHON))("pymavlink DFReader reads the writer's output with the same values and units", () => {
    const directory = mkdtempSync(join(tmpdir(), "mirage-dataflash-"));
    try {
      const path = join(directory, "mirage.BIN");
      writeFileSync(path, sample().bytes());
      const program = [
        "import json, math, sys",
        "from pymavlink import DFReader",
        "r = DFReader.DFReader_binary(sys.argv[1], zero_time_base=True)",
        "out = []",
        "while True:",
        "    m = r.recv_msg()",
        "    if m is None: break",
        "    if m.get_type() in ('MTRU', 'MMOT', 'MEVT', 'MPRM'):",
        "        out.append([m.get_type(), {c: ('NaN' if isinstance(getattr(m, c), float) and math.isnan(getattr(m, c)) else getattr(m, c)) for c in m._fieldnames}, {c: m.fmt.get_unit(c) for c in m._fieldnames}])",
        "print(json.dumps(out))",
      ].join("\n");
      const run = spawnSync(PYTHON, ["-I", "-c", program, path], { encoding: "utf8" });
      expect(run.status).toBe(0);
      const decoded: unknown = JSON.parse(run.stdout);
      const log = readDataflash(sample().bytes());
      const rows = new Map<string, number>();
      expect(Array.isArray(decoded) && decoded.length === 7).toBe(true);
      for (const entry of decoded as [string, Record<string, unknown>, Record<string, string>][]) {
        const [type, values, units] = entry;
        const row = rows.get(type) ?? 0;
        rows.set(type, row + 1);
        const table = log.tables.get(type)!;
        for (const [name, value] of Object.entries(values)) expect(cell(table.columns[name]!, row)).toStrictEqual(expected(value));
        expect(table.format.units).toEqual(table.format.columns.map(column => units[column]));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("DataFlash Worker handler", () => {
  test("parses transferred chunks and transfers numeric columns back", () => {
    const responses: [DataflashResponse, Transferable[]][] = [];
    const handle = createDataflashHandler((response, transfer) => responses.push([response, transfer]));
    for (let offset = 0; offset < reference.length; offset += 10000) handle({ kind: "chunk", bytes: reference.slice(offset, offset + 10000).buffer });
    handle({ kind: "finish" });
    const [result, transfer] = responses.at(-1)!;
    if (result.kind !== "result") throw new Error(result.kind);
    expect(responses.filter(([response]) => response.kind === "progress")).toHaveLength(Math.ceil(reference.length / 10000));
    expect(result.bytes).toBe(reference.length);
    expect(result.gpsTimeBaseS).toBe(fixture.gpsTimeBaseS);
    expect(result.tables.reduce((sum, table) => sum + table.timestampS.length, 0)).toBe(fixture.messages.length);
    expect(transfer.length).toBeGreaterThan(result.tables.length * 2);
    handle({ kind: "unknown" });
    expect(responses.at(-1)![0]).toEqual({ kind: "error", message: "Unknown DataFlash request" });
  });
});
