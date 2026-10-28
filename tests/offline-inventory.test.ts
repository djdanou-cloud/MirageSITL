import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// TASK-131: the offline inventory check runs as its CLI, against the repository and against small synthetic roots.
type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const isRows = (value: unknown): value is Row[] => Array.isArray(value) && value.every(isRow);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");

interface Report { verdict: string; failures: string[]; fields: Row }

function run(...args: string[]): { status: number | null; report: Report } {
  const result = spawnSync(process.execPath, ["scripts/check-offline.mjs", ...args], { encoding: "utf8", timeout: 120000 });
  const fields: unknown = JSON.parse(result.stdout);
  if (!isRow(fields) || typeof fields.verdict !== "string" || !isStrings(fields.failures)) throw new Error(`Malformed report: ${result.stdout}`);
  return { status: result.status, report: { verdict: fields.verdict, failures: fields.failures, fields } };
}

const rows = (report: Report, key: string): Row[] => {
  const value = report.fields[key];
  if (!isRows(value)) throw new Error(`Report field ${key} is not a list of records`);
  return value;
};

const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

function write(root: string, path: string, value: unknown): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
}

interface Parts { app: Row; items: Row[]; pad: Row; sources: Row[]; packages: Record<string, Row> }

/** A minimal root that passes; each test breaks one rule. */
function syntheticRoot(change: (parts: Parts) => void = () => undefined): string {
  const root = mkdtempSync(join(tmpdir(), "mirage-offline-"));
  const data = "local terrain bytes";
  const app: Row = {
    id: "app", category: "application", item: "Application", version: "1", source: "Repository", license: "Project-owned",
    licenseStatus: "not-applicable", neededFor: "Everything", installDownload: false, status: "ready",
  };
  const pad: Row = {
    id: "pad", name: "Pad", kind: "synthetic-surface", source: "Scene", license: "Project-owned", licenseStatus: "not-applicable",
    coverage: "Any", resolution: "Analytic", readiness: "ready",
    files: [{ path: "data/pad.bin", bytes: data.length, sha256: sha256(data) }],
  };
  const parts: Parts = {
    app, items: [app], pad, sources: [pad],
    packages: {
      "": { name: "root" },
      "node_modules/runtime": { version: "1.0.0", license: "MIT" },
      "node_modules/tool": { version: "2.0.0", license: "GPL-3.0-only", dev: true },
    },
  };
  change(parts);
  write(root, "config/offline-inventory.json", {
    schemaVersion: 1,
    scan: { roots: ["src"], extensions: [".ts"] },
    npm: { lockfile: "package-lock.json", allowedLicenses: ["MIT"] },
    networkOrigins: [
      { origin: "http://127.0.0.1", use: "loopback", reason: "Local bridge." },
      { origin: "https://docs.example.org", use: "documentation-link", reason: "Named only by a bundled library." },
    ],
    items: parts.items,
  });
  write(root, "data/terrain/inventory.json", { schemaVersion: 1, sources: parts.sources, gaps: [] });
  write(root, "package-lock.json", { lockfileVersion: 3, packages: parts.packages });
  write(root, "data/pad.bin", data);
  write(root, "src/bridge.ts", "export const BRIDGE = \"http://127.0.0.1/ws\";\n");
  return root;
}

describe("offline inventory (TASK-131)", () => {
  it("passes on the repository: every named origin is listed and every runtime npm license is reviewed", () => {
    const { status, report } = run();
    expect(report.failures).toEqual([]);
    expect(status).toBe(0);
    const origins = rows(report, "origins");
    expect(origins.length).toBeGreaterThan(0);
    expect(origins.filter(origin => origin.use === "UNLISTED")).toEqual([]);
    expect(report.fields.npmRuntimePackages).toBeGreaterThan(0);
    // The three WorldCover tiles are hashed on every run.
    expect(report.fields.hashedFiles).toBe(3);
    // Unresolved items stay pending on their decisions rather than being marked ready.
    const pending = report.fields.pendingItems;
    expect(isStrings(pending) ? pending : []).toEqual(expect.arrayContaining(["uavlogviewer", "ardupilot-source", "ardupilot-parameter-metadata"]));
    expect(rows(report, "openLicenses").filter(entry => typeof entry.decision !== "string" || entry.decision === "")).toEqual([]);
  }, 120000);

  it("distinguishes imagery, elevation and land cover, and keeps the synthetic pad ready without map services", () => {
    const { report } = run();
    const sources = rows(report, "terrainSources");
    const kinds = new Set(sources.map(source => source.kind));
    for (const kind of ["synthetic-surface", "land-cover", "elevation", "imagery-and-mesh"]) expect(kinds.has(kind)).toBe(true);
    expect(sources.find(source => source.id === "synthetic-pad")?.readiness).toBe("ready");
    // An adapter that needs keys, a deployment or data is never reported as a ready source.
    expect(sources.find(source => source.id === "google-photorealistic-3d-tiles")?.readiness).toBe("needs-keys-or-deployment");
    expect(sources.find(source => source.id === "fabdem-elevation")?.readiness).toBe("needs-data");
  }, 120000);

  it("passes a minimal root, ignores development-only npm licenses and does not count the inventory's own origins", () => {
    const { status, report } = run("--root", syntheticRoot());
    expect(report.failures).toEqual([]);
    expect(status).toBe(0);
    expect(rows(report, "origins")).toEqual([{ origin: "http://127.0.0.1", use: "loopback" }]);
    expect(report.fields.unusedOrigins).toEqual(["https://docs.example.org"]);
  });

  it("scans a built bundle when asked", () => {
    const listed = syntheticRoot();
    write(listed, "apps/web/dist/assets/index.js", "const docs = \"https://docs.example.org/errors\";\n");
    const passed = run("--root", listed, "--dist", "apps/web/dist");
    expect(passed.report.failures).toEqual([]);
    expect(passed.report.fields.bundleFiles).toBe(1);
    expect(passed.report.fields.unusedOrigins).toEqual([]);
    const unlisted = syntheticRoot();
    write(unlisted, "apps/web/dist/assets/index.js", "fetch(\"https://cdn.example.net/lib.js\");\n");
    const failed = run("--root", unlisted, "--dist", "apps/web/dist");
    expect(failed.status).toBe(1);
    expect(failed.report.failures).toEqual(["unlisted network origin https://cdn.example.net in apps/web/dist/assets/index.js"]);
  });

  it("fails on a network origin that the inventory does not list", () => {
    const root = syntheticRoot();
    write(root, "src/tiles.ts", "export const TILES = \"https://tiles.example.com/v1/root.json\";\n");
    const { status, report } = run("--root", root);
    expect(status).toBe(1);
    expect(report.failures).toEqual(["unlisted network origin https://tiles.example.com in src/tiles.ts"]);
  });

  it("fails on a runtime npm package with an unreviewed or missing license", () => {
    const root = syntheticRoot(({ packages }) => {
      packages["node_modules/copyleft"] = { version: "3.0.0", license: "GPL-3.0-only" };
      packages["node_modules/runtime/node_modules/unlabeled"] = { version: "0.1.0" };
    });
    const { status, report } = run("--root", root);
    expect(status).toBe(1);
    expect(report.failures).toEqual([
      "npm runtime package copyleft@3.0.0 has unreviewed license GPL-3.0-only",
      "npm runtime package unlabeled@0.1.0 has unreviewed license NONE",
    ]);
  });

  it("fails when an inventoried file changed or is missing", () => {
    const changed = syntheticRoot();
    write(changed, "data/pad.bin", "local terrain BYTES");
    expect(run("--root", changed).report.failures).toEqual(["pad: data/pad.bin: SHA-256 differs from the inventory"]);
    const resized = syntheticRoot();
    write(resized, "data/pad.bin", "short");
    expect(run("--root", resized).report.failures).toEqual(["pad: data/pad.bin: 5 bytes, the inventory records 19"]);
    const missing = syntheticRoot(({ pad }) => {
      pad.files = [{ path: "data/absent.bin", bytes: 1, sha256: sha256("x") }];
    });
    expect(run("--root", missing).report.failures).toEqual(["pad: data/absent.bin: file missing"]);
  });

  it("requires a decision for an unresolved license, a pending item and an unready terrain source", () => {
    const root = syntheticRoot(({ items, sources }) => {
      items.push({
        id: "viewer", category: "viewer", item: "Viewer", version: "?", source: "?", license: "?", licenseStatus: "unresolved",
        neededFor: "Logs", installDownload: true, status: "pending",
      });
      sources.push({
        id: "dem", name: "DEM", kind: "elevation", source: "Tooling", license: "CC-BY-4.0", licenseStatus: "reviewed",
        coverage: "Box", resolution: "30 m", readiness: "needs-data",
      });
    });
    const { status, report } = run("--root", root);
    expect(status).toBe(1);
    expect(report.failures).toEqual([
      "item viewer: an unresolved or restricted license and a pending item name the decision or task that resolves them",
      "terrain source dem: an unresolved or restricted license and an unready source name the decision or task that resolves them",
    ]);
  });

  it("rejects unknown categories, kinds and readiness values", () => {
    const root = syntheticRoot(({ app, pad }) => {
      app.category = "cloud-service";
      pad.kind = "orthophoto";
      pad.readiness = "probably";
    });
    const { status, report } = run("--root", root);
    expect(status).toBe(1);
    expect(report.failures).toEqual([
      "item app: unknown category cloud-service",
      "terrain source pad: unknown kind orthophoto",
      "terrain source pad: unknown readiness probably",
    ]);
  });

  it("fails when the requested bundle directory is missing", () => {
    const { status, report } = run("--root", syntheticRoot(), "--dist", "apps/web/dist");
    expect(status).toBe(1);
    expect(report.failures).toEqual(["bundle directory apps/web/dist is missing; run npm run build first"]);
  });

  it("reads local files only", () => {
    const source = readFileSync("scripts/check-offline.mjs", "utf8");
    for (const network of ["fetch(", "node:http", "node:https", "node:net", "node:dgram", "child_process"]) expect(source).not.toContain(network);
  });
});
