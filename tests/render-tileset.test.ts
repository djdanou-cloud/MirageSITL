import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// TASK-073: the synthetic render stress tileset is deterministic, flat at the
// physics origin, and front-facing from above (back-face culling keeps it visible).
const dirs: string[] = [];
function generate(): { dir: string; manifest: { tiles: number; contentSha256: string; synthetic: boolean; license: string } } {
  const dir = mkdtempSync(join(tmpdir(), "mirage-tiles-"));
  dirs.push(dir);
  const r = spawnSync(process.execPath, ["scripts/generate-render-tileset.mjs", "--out", dir, "--depth", "1", "--size", "1000"], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  const manifest: unknown = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (typeof manifest !== "object" || manifest === null || !("tiles" in manifest) || !("contentSha256" in manifest) || !("synthetic" in manifest) || !("license" in manifest) ||
    typeof manifest.tiles !== "number" || typeof manifest.contentSha256 !== "string" || typeof manifest.synthetic !== "boolean" || typeof manifest.license !== "string") throw new Error("Bad manifest");
  return { dir, manifest: { tiles: manifest.tiles, contentSha256: manifest.contentSha256, synthetic: manifest.synthetic, license: manifest.license } };
}
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** Positions and indices of a GLB written by the generator (POSITION accessor 0, indices accessor 3). */
function readGlb(path: string): { positions: Float32Array; indices: Uint16Array } {
  const bytes = readFileSync(path);
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  const jsonLength = bytes.readUInt32LE(12);
  const gltf: unknown = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
  if (typeof gltf !== "object" || gltf === null || !("bufferViews" in gltf) || !Array.isArray(gltf.bufferViews)) throw new Error("Bad glTF");
  const views: unknown[] = gltf.bufferViews;
  const view = (i: number): { byteOffset: number; byteLength: number } => {
    const v = views[i];
    if (typeof v !== "object" || v === null || !("byteOffset" in v) || !("byteLength" in v) || typeof v.byteOffset !== "number" || typeof v.byteLength !== "number") throw new Error("Bad view");
    return { byteOffset: v.byteOffset, byteLength: v.byteLength };
  };
  const bin = bytes.subarray(20 + jsonLength + 8);
  const copy = (i: number) => { const v = view(i); return Uint8Array.from(bin.subarray(v.byteOffset, v.byteOffset + v.byteLength)).buffer; };
  return { positions: new Float32Array(copy(0)), indices: new Uint16Array(copy(3)) };
}

describe("render stress tileset generator", () => {
  it("is byte-deterministic and labelled synthetic CC0", () => {
    const a = generate(), b = generate();
    expect(a.manifest.tiles).toBe(5); // root + 4 children at depth 1
    expect(a.manifest.contentSha256).toBe(b.manifest.contentSha256);
    expect([a.manifest.synthetic, a.manifest.license]).toEqual([true, "CC0-1.0"]);
  });

  it("keeps the origin plateau at 0 m and every triangle facing up", () => {
    const { dir } = generate();
    const { positions, indices } = readGlb(join(dir, "t0.glb"));
    let plateau = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const e = positions[i]!, h = positions[i + 1]!, n = -positions[i + 2]!; // i + 2 < length
      if (Math.hypot(e, n) <= 250) { expect(h).toBe(0); plateau++; }
    }
    expect(plateau).toBeGreaterThan(100);
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!].map(k => 3 * k) as [number, number, number];
      // y of (b - a) x (c - a): positive means counter-clockwise seen from +y (glTF up).
      const ux = positions[b]! - positions[a]!, uz = positions[b + 2]! - positions[a + 2]!;
      const vx = positions[c]! - positions[a]!, vz = positions[c + 2]! - positions[a + 2]!;
      expect(uz * vx - ux * vz).toBeGreaterThan(0);
    }
    const tileset: unknown = JSON.parse(readFileSync(join(dir, "tileset.json"), "utf8"));
    expect(JSON.stringify(tileset)).toContain("\"geometricError\":0"); // leaves
  });
});
