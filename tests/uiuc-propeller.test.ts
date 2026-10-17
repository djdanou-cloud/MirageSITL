import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyFixture } from "@mirage/test-support/fixtures";
import {
  ATTACHED_HALF_RANGE_RAD,
  auditUiucFixture,
  betRequest,
  bladeStations,
  evaluateUiucPropellers,
  parseBetResponse,
  parseUiucPropellerFixture,
  thinAirfoilPolar,
  thinAirfoilZeroLiftRad,
  type PolarTableData,
  type UiucFixture,
} from "../packages/physics/src/uiuc-propeller";
import registry from "./fixtures/registry.json";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const bytes = readFileSync(new URL("./fixtures/rotors/uiuc-propellers.json", import.meta.url));
const payload: unknown = JSON.parse(bytes.toString("utf8"));
const fixture = parseUiucPropellerFixture(payload);
const runBet = (input: string) =>
  execFileSync("cargo", ["run", "-q", "--locked", "-p", "mirage-bet", "--example", "propeller_points"], {
    cwd: new URL("../native", import.meta.url),
    input,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!record(current) || !Object.hasOwn(current, key)) throw new Error(path.join("."));
    current = current[key];
  }
  return current;
}
function node(value: unknown, ...path: string[]): Record<string, unknown> {
  const v = field(value, ...path);
  if (!record(v)) throw new Error(path.join("."));
  return v;
}
/** Two-surface airfoil from a mean line and symmetric thickness, cosine spaced. */
function airfoil(camber: (x: number) => number, points = 30): [number, number][] {
  const out: [number, number][] = [];
  const thickness = (x: number) => 0.06 * Math.sqrt(x) * (1 - x);
  for (let i = points; i >= 0; i--) {
    const x = (1 - Math.cos((Math.PI * i) / points)) / 2;
    out.push([x, camber(x) + thickness(x)]);
  }
  for (let i = 1; i <= points; i++) {
    const x = (1 - Math.cos((Math.PI * i) / points)) / 2;
    out.push([x, camber(x) - thickness(x)]);
  }
  return out;
}
function mutate(change: (value: Record<string, unknown>) => void): unknown {
  const copy: unknown = JSON.parse(bytes.toString("utf8"));
  if (!record(copy)) throw new Error("fixture");
  change(copy);
  return copy;
}

describe("UIUC propeller database fixture", () => {
  it("is registered with measured provenance and an exact payload hash", async () => {
    const entry = registry.fixtures.find((item) => item.path === "rotors/uiuc-propellers.json");
    if (!entry) throw new Error("UIUC fixture is not registered");
    const manifest = await verifyFixture(entry.manifest, bytes);
    expect(manifest.provenance).toEqual({
      kind: "measured",
      datasetId: "UIUC-Propeller-Database-Vols-1-4",
      license: "UIUC-Propeller-Database-citation-requested-no-explicit-license",
      acquiredAt: "2022-06-27T00:00:00Z",
      referenceUrl: "https://m-selig.ae.illinois.edu/props/propDB.html",
    });
    expect(fixture.propellers.map((p) => p.id)).toHaveLength(14);
  });

  it("traces every table to the inventoried archive and the SDA1075 transcription", () => {
    const inventoryBytes = readFileSync(new URL("../data/uiuc-propdb/inventory.json", import.meta.url));
    const files = field(JSON.parse(inventoryBytes.toString("utf8")), "files");
    if (!Array.isArray(files)) throw new Error("inventory files");
    const hashes = new Map<string, string>();
    let lines = "";
    for (const f of files) {
      const path = field(f, "path"), digest = field(f, "sha256");
      if (typeof path !== "string" || typeof digest !== "string") throw new Error("inventory entry");
      hashes.set(path, digest);
      lines += `${path}\t${digest}\n`;
    }
    const inventory: unknown = JSON.parse(inventoryBytes.toString("utf8"));
    // The aggregate digest rule is recomputed independently of the generator.
    expect(sha(lines)).toBe(field(inventory, "dataSha256"));
    expect(field(payload, "archive", "dataSha256")).toBe(field(inventory, "dataSha256"));
    expect(hashes.size).toBe(field(payload, "archive", "dataFiles"));
    for (const p of fixture.propellers) {
      for (const run of p.runs) expect(hashes.get(run.source)).toBe(run.sha256);
      if (p.static) expect(hashes.get(p.static.source)).toBe(p.static.sha256);
    }
    const dat = readFileSync(new URL("./fixtures/rotors/uiuc/sda1075.dat", import.meta.url));
    expect(sha(dat)).toBe(field(payload, "airfoils", "SDA1075", "transcriptionSha256"));
    const parsed = dat.toString("ascii").trim().split("\n").slice(1).map((l) => l.split(" ").map(Number));
    expect(parsed).toEqual(fixture.airfoilCoordinates);
  });

  it("passes the dataset-only eta and Froude-bound oracles", () => {
    const audit = auditUiucFixture(fixture);
    expect(audit).toEqual(fixture.audit);
    expect(audit).toMatchObject({ points: 716, etaInconsistent: 0, aboveFroudeBound: 0 });
    // A row above the ideal actuator-disk efficiency is detected.
    const first = fixture.propellers[0], run = first?.runs[0], row = run?.points[0];
    if (!first || !run || !row) throw new Error("fixture rows");
    const broken: UiucFixture = {
      ...fixture,
      propellers: [{ ...first, runs: [{ ...run, points: [[row[0], row[1], row[2], 0.99]] }] }],
    };
    expect(auditUiucFixture(broken)).toMatchObject({ etaInconsistent: 1, aboveFroudeBound: 1 });
  });

  it("rejects malformed or out-of-contract payloads", () => {
    const cases: ((v: Record<string, unknown>) => void)[] = [
      (v) => { v.referenceUrl = "http://m-selig.ae.illinois.edu/props/propDB.html"; },
      (v) => { v.schemaVersion = 2; },
      (v) => { node(v, "propellers", "0").airfoil = "NACA4412"; },
      (v) => { node(v, "propellers", "0", "geometry").radiusRatio = [0.5, 0.4, 1]; },
      (v) => { node(v, "propellers", "1").id = field(v, "propellers", "0", "id"); },
      (v) => { node(v, "propellers", "0", "runs", "0", "points")["0"] = [-0.1, 0.1, 0.05, 0]; },
      (v) => { node(v, "comparison").ctRelativeTolerance = 0; },
    ];
    for (const change of cases) expect(() => parseUiucPropellerFixture(mutate(change))).toThrow("Invalid UIUC propeller fixture");
  });
});

describe("declared comparison model", () => {
  it("recovers exact thin-airfoil zero-lift angles", () => {
    // Parabolic mean line z = 4h x(1-x): dz/dx = 4h cos(theta), alpha0 = -2h exactly.
    for (const h of [0.01, 0.03])
      expect(thinAirfoilZeroLiftRad(airfoil((x) => 4 * h * x * (1 - x)))).toBeCloseTo(-2 * h, 3);
    expect(Math.abs(thinAirfoilZeroLiftRad(airfoil(() => 0)))).toBeLessThan(1e-12);
    // Upper/lower interpolation error shrinks with resolution (31 vs 121 points per surface).
    const coarse = Math.abs(thinAirfoilZeroLiftRad(airfoil((x) => 0.12 * x * (1 - x))) + 0.06);
    const fine = Math.abs(thinAirfoilZeroLiftRad(airfoil((x) => 0.12 * x * (1 - x), 120)) + 0.06);
    expect(fine).toBeLessThan(coarse / 4);
    const a0 = thinAirfoilZeroLiftRad(fixture.airfoilCoordinates);
    expect((a0 * 180) / Math.PI).toBeCloseTo(-1.341, 2);
  });

  it("builds the polar in the native index layout with Blasius drag", () => {
    const a0 = -0.02, polar = thinAirfoilPolar(a0);
    const na = polar.alphaRad.length, nr = polar.reynolds.length;
    expect(polar.cl).toHaveLength(na * nr * polar.mach.length);
    expect(polar.alphaRad[0]).toBeCloseTo(a0 - ATTACHED_HALF_RANGE_RAD, 15);
    expect(polar.alphaRad[na - 1]).toBeCloseTo(a0 + ATTACHED_HALF_RANGE_RAD, 15);
    expect(polar.cl[10]).toBeCloseTo(0, 15);
    // (iMach * nRe + iRe) * nAlpha + iAlpha
    const re = polar.reynolds[3] ?? NaN;
    expect(polar.cd[(1 * nr + 3) * na + 4]).toBeCloseTo((2 * 1.328) / Math.sqrt(re), 15);
    expect(polar.cl[(1 * nr + 3) * na + 4]).toBeCloseTo(2 * Math.PI * ((polar.alphaRad[4] ?? NaN) - a0), 12);
  });

  it("discretizes only the declared airfoil span", () => {
    for (const p of fixture.propellers) {
      const s = bladeStations(p, fixture.comparison.airfoilStartRadiusRatio);
      expect(s.widthM.reduce((a, b) => a + b, 0)).toBeCloseTo(s.radiusM - s.cutoutM, 12);
      expect(s.cutoutM).toBeCloseTo(0.3 * p.diameterM / 2, 15);
      for (let k = 0; k < s.stationM.length; k++) {
        expect(s.stationM[k]).toBeGreaterThan(k ? (s.stationM[k - 1] ?? 0) : s.cutoutM);
        expect(s.chordM[k]).toBeGreaterThan(0);
      }
      expect(s.stationM[s.stationM.length - 1]).toBeLessThan(s.radiusM);
    }
  });

  it("classifies points and never reports PASS without a comparison", () => {
    const one: UiucFixture = { ...fixture, propellers: fixture.propellers.slice(0, 1) };
    const prop = one.propellers[0];
    if (!prop) throw new Error("fixture");
    const rows = [...prop.runs.flatMap((r) => r.points.map((p) => [p[1], p[2]] as const)), ...(prop.static?.points ?? []).map((p) => [p[1], p[2]] as const)];
    const answer = (render: (ct: number, cp: number, i: number) => string) => () => rows.map(([ct, cp], i) => render(ct, cp, i)).join("\n");
    const exact = evaluateUiucPropellers(one, answer((ct, cp) => `ok ${ct} ${cp} 0 0 0 0 0`));
    expect(exact.status).toBe("pass");
    expect(exact.totals.passed).toBe(rows.length);
    const off = evaluateUiucPropellers(one, answer((ct, cp, i) => (i === 0 ? `ok ${ct * 1.2} ${cp} 0 0 0 0 0` : `ok ${ct} ${cp} 0 0 0 0 0`)));
    expect(off.status).toBe("failed");
    expect(off.points[0]).toMatchObject({ result: "failed", ctWithinTolerance: false, cpWithinTolerance: true });
    expect(evaluateUiucPropellers(one, answer((ct, cp) => `ok ${ct} ${cp} 0 0 0 2 0`)).status).toBe("unvalidated");
    expect(evaluateUiucPropellers(one, answer((ct, cp) => `ok ${ct} ${cp} 0 0 0 0 1`)).status).toBe("unvalidated");
    expect(evaluateUiucPropellers(one, answer((ct, cp, i) => (i === 0 ? "err" : `ok ${ct} ${cp} 0 0 0 0 0`))).status).toBe("failed");
    expect(() => parseBetResponse("ok 1 2 3\n", 1)).toThrow("Malformed");
    expect(() => parseBetResponse("", 1)).toThrow("0 of 1");
  });

  it("satisfies the Froude identity through the native runner with zero drag", () => {
    // With CD = 0 every element obeys dP = dT (V + v), so eta must equal the
    // actuator-disk ideal 2/(1 + sqrt(1 + 8 CT/(pi J^2))) for any geometry.
    const base = thinAirfoilPolar(thinAirfoilZeroLiftRad(fixture.airfoilCoordinates));
    const wide: PolarTableData = {
      alphaRad: [-Math.PI, Math.PI],
      reynolds: [1, 1e9],
      mach: [0, 1],
      cl: Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? -2 * Math.PI * Math.PI : 2 * Math.PI * Math.PI)),
      cd: Array.from({ length: 8 }, () => 0),
    };
    expect(base.alphaRad.length).toBeGreaterThan(2);
    const prop = fixture.propellers.find((p) => p.id === "da4002-9x6.75-2b");
    if (!prop) throw new Error("fixture");
    // A sweep starting at low J (some RPMs are split into low- and high-J runs).
    const run = prop.runs.find((r) => (r.points[0]?.[0] ?? 1) < 0.2 && r.points.length > 10);
    if (!run) throw new Error("fixture");
    const one: UiucFixture = { ...fixture, propellers: [{ ...prop, static: null, runs: [run] }] };
    const predictions = parseBetResponse(runBet(betRequest(one, wide)), run.points.length);
    let checked = 0;
    for (let i = 0; i < run.points.length; i++) {
      const p = predictions[i], j = run.points[i]?.[0] ?? NaN;
      if (!p?.ok || p.outsideMomentumValidity || p.ct <= 0) continue;
      const ideal = 2 / (1 + Math.sqrt(1 + (8 * p.ct) / (Math.PI * j * j)));
      expect((j * p.ct) / p.cp).toBeCloseTo(ideal, 9);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  }, 300000);
});
