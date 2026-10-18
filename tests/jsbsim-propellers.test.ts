import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseUiucPropellerFixture } from "../packages/physics/src/uiuc-propeller";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url));

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function field(value: unknown, key: string): unknown {
  if (!record(value) || !Object.hasOwn(value, key)) throw new Error(`missing ${key}`);
  return value[key];
}
function str(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected string");
  return value;
}
function num(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("expected number");
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value;
}
/** Rows of one internal JSBSim table: [J, coefficient]. */
function tableRows(xml: string, name: string): [number, number][] {
  const match = new RegExp(`<table name="${name}" type="internal">\\s*<tableData>([\\s\\S]*?)</tableData>\\s*</table>`).exec(xml);
  const body = match?.[1];
  if (body === undefined) throw new Error(`missing table ${name}`);
  return body.trim().split("\n").map((line) => {
    const [j, c, extra] = line.trim().split(/\s+/).map(Number);
    if (j === undefined || c === undefined || extra !== undefined || !Number.isFinite(j) || !Number.isFinite(c)) throw new Error(`bad row ${line}`);
    return [j, c];
  });
}

const manifest: unknown = JSON.parse(read("data/jsbsim/engine/uiuc-propellers.manifest.json").toString("utf8"));
const entries = list(field(manifest, "propellers"));

describe("UIUC-derived JSBSim propeller definitions (TASK-086)", () => {
  it("lists six hash-pinned files that trace to the inventoried archive", () => {
    expect(entries).toHaveLength(6);
    const inventory: unknown = JSON.parse(read("data/uiuc-propdb/inventory.json").toString("utf8"));
    expect(field(manifest, "archiveDataSha256")).toBe(field(inventory, "dataSha256"));
    const hashes = new Map(list(field(inventory, "files")).map((f) => [str(field(f, "path")), str(field(f, "sha256"))]));
    for (const e of entries) {
      expect(sha(read(str(field(e, "file"))))).toBe(field(e, "sha256"));
      for (const s of list(field(e, "sources"))) expect(hashes.get(str(field(s, "source")))).toBe(field(s, "sha256"));
    }
  });

  it("writes strictly increasing J tables that start at the static point", () => {
    for (const e of entries) {
      const xml = read(str(field(e, "file"))).toString("utf8");
      expect(xml).toMatch(/^<\?xml version="1\.0"\?>/);
      expect(xml).toContain(`<numblades> ${num(field(e, "bladeCount"))} </numblades>`);
      expect(xml).toContain(`<diameter unit="IN"> ${num(field(e, "diameterIn"))} </diameter>`);
      expect(xml).not.toContain("<ixx");
      const thrust = tableRows(xml, "C_THRUST"), power = tableRows(xml, "C_POWER");
      expect(thrust.map((r) => r[0])).toEqual(power.map((r) => r[0]));
      expect(thrust).toHaveLength(num(field(e, "rows")));
      expect(thrust[0]?.[0]).toBe(0);
      for (let i = 1; i < thrust.length; i++) expect(thrust[i]?.[0]).toBeGreaterThan(thrust[i - 1]?.[0] ?? Infinity);
      expect(thrust[thrust.length - 1]?.[0]).toBe(field(e, "maxAdvanceRatio"));
      // The chosen sweep reaches zero thrust, so the table spans the working range.
      expect(field(e, "reachesZeroThrust")).toBe(true);
      expect(Math.min(...thrust.map((r) => r[1]))).toBeLessThanOrEqual(0);
      expect(power.every((r) => r[1] > 0)).toBe(true);
    }
  });

  it("matches the independently generated TASK-033 fixture for DA4002 9x6.75", () => {
    const fixture = parseUiucPropellerFixture(JSON.parse(read("tests/fixtures/rotors/uiuc-propellers.json").toString("utf8")));
    const prop = fixture.propellers.find((p) => p.id === "da4002-9x6.75-2b");
    const entry = entries.find((e) => field(e, "propeller") === "da4002_9x6.75");
    if (!prop || !entry || !prop.static) throw new Error("DA4002 9x6.75 missing");
    const sources = list(field(entry, "sources"));
    const runs = new Set(sources.filter((s) => record(s) && Object.hasOwn(s, "rpm")).map((s) => str(field(s, "source"))));
    const staticRpm = num(field(sources.find((s) => record(s) && Object.hasOwn(s, "staticRpm")), "staticRpm"));
    const measured = new Map<number, [number, number]>();
    for (const run of prop.runs) if (runs.has(run.source)) for (const [j, ct, cp] of run.points) if (!measured.has(j)) measured.set(j, [ct, cp]);
    const staticRow = prop.static.points.find((r) => r[0] === staticRpm);
    if (!staticRow) throw new Error("static row");
    const xml = read(str(field(entry, "file"))).toString("utf8");
    const thrust = tableRows(xml, "C_THRUST"), power = tableRows(xml, "C_POWER");
    expect(thrust[0]).toEqual([0, staticRow[1]]);
    expect(power[0]).toEqual([0, staticRow[2]]);
    expect(thrust.length - 1).toBe(measured.size);
    for (let i = 1; i < thrust.length; i++) {
      const [j, ct] = thrust[i] ?? [NaN, NaN];
      expect(measured.get(j)).toEqual([ct, power[i]?.[1]]);
    }
  });

  it("compares JSBSim probe output with measured rows using independent arithmetic", () => {
    // Runs the checker's pure functions in Node; the native probe itself needs a JSBSim checkout.
    const code = `import * as c from './scripts/check-jsbsim-propellers.mjs';
      const rows = [[0, 0.10], [0.2, 0.08], [0.4, 0.05], [0.6, 0.0]];
      const out = {
        interp: [c.interpolate(rows, 0.3), c.interpolate(rows, -1), c.interpolate(rows, 9)],
        select: c.selectAdvanceRatios(rows),
        density: c.ISA_SEA_LEVEL_SLUG_FT3,
        ok: c.evaluatePoint({ rpm: 6000, requestedJ: 0.3, advanceRatio: 0.3, densitySlugFt3: c.ISA_SEA_LEVEL_SLUG_FT3,
          thrustLbf: 0.065 * c.ISA_SEA_LEVEL_SLUG_FT3 * 100 * 100, powerFtLbfPerS: 0.03 * c.ISA_SEA_LEVEL_SLUG_FT3 * 1e6 }, rows,
          [[0, 0.03], [0.6, 0.03]], 1).passed,
        offByTwoPercent: c.evaluatePoint({ rpm: 6000, requestedJ: 0.3, advanceRatio: 0.3, densitySlugFt3: c.ISA_SEA_LEVEL_SLUG_FT3,
          thrustLbf: 1.02 * 0.065 * c.ISA_SEA_LEVEL_SLUG_FT3 * 1e4, powerFtLbfPerS: 0.03 * c.ISA_SEA_LEVEL_SLUG_FT3 * 1e6 }, rows,
          [[0, 0.03], [0.6, 0.03]], 1).passed,
      };
      let rejected = 0;
      for (const bad of ['<table name="C_THRUST" type="internal"><tableData> 0 1 \\n 0 2 </tableData>',
                         '<table name="C_THRUST" type="internal"><tableData> 0 1 2 </tableData>', '<x/>'])
        try { c.parseTable(bad, 'C_THRUST'); } catch { rejected++; }
      console.log(JSON.stringify({ ...out, rejected }));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const out: unknown = JSON.parse(result.stdout);
    // n = 100 rev/s, D = 1 ft: T = CT rho n^2 D^4, P = CP rho n^3 D^5; CT(0.3) = (0.08 + 0.05) / 2.
    expect(out).toEqual({
      interp: [0.065, 0.1, 0],
      select: [
        { kind: "static-row", advanceRatio: 0 },
        { kind: "advancing-row", advanceRatio: 0.4 },
        { kind: "interpolated", advanceRatio: 0.5 },
      ],
      density: 1.225 / 515.3788183932,
      ok: true,
      offByTwoPercent: false,
      rejected: 3,
    });
  });
});
