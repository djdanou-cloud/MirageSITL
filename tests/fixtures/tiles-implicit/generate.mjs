// Minimal 3D Tiles 1.1 implicit-tiling fixture (TASK-073). Own work, CC0-1.0.
//
// One level (availableLevels 1) whose subtree declares tile and content
// availability as constants, so the binary subtree carries JSON only. The
// single content tile is the CC0 fixture tile (../tiles/tile.glb) placed with
// the same root transform, so the explicit and implicit fixtures must load to
// the same geometry. This mirrors the layout pg2b3dm writes for buildings:
// content/{level}_{x}_{y}.glb and subtrees/{level}_{x}_{y}.subtree.
//
//   node tests/fixtures/tiles-implicit/generate.mjs
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const explicit = JSON.parse(readFileSync(fileURLToPath(new URL("../tiles/tileset.json", import.meta.url)), "utf8"));
mkdirSync(`${here}/content`, { recursive: true });
mkdirSync(`${here}/subtrees`, { recursive: true });
copyFileSync(fileURLToPath(new URL("../tiles/tile.glb", import.meta.url)), `${here}/content/0_0_0.glb`);

// Subtree binary: magic "subt", version 1, uint64 JSON length, uint64 binary length, JSON padded to 8 bytes.
const subtree = { tileAvailability: { constant: 1 }, contentAvailability: [{ constant: 1 }], childSubtreeAvailability: { constant: 0 } };
let json = Buffer.from(JSON.stringify(subtree));
json = Buffer.concat([json, Buffer.alloc((8 - (json.length % 8)) % 8, 0x20)]);
const header = Buffer.alloc(24);
header.write("subt", 0, "ascii");
header.writeUInt32LE(1, 4);
header.writeBigUInt64LE(BigInt(json.length), 8);
header.writeBigUInt64LE(0n, 16);
writeFileSync(`${here}/subtrees/0_0_0.subtree`, Buffer.concat([header, json]));

const tileset = {
  asset: { version: "1.1", generator: "MirageSITL tests/fixtures/tiles-implicit/generate.mjs",
    extras: { ...explicit.asset.extras, license: "CC0-1.0", attribution: "MirageSITL synthetic test tiles (CC0-1.0)" } },
  geometricError: explicit.geometricError,
  root: {
    transform: explicit.root.transform,
    boundingVolume: explicit.root.boundingVolume,
    geometricError: 0,
    refine: "REPLACE",
    content: { uri: "content/{level}_{x}_{y}.glb" },
    implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 1, availableLevels: 1, subtrees: { uri: "subtrees/{level}_{x}_{y}.subtree" } },
  },
};
writeFileSync(`${here}/tileset.json`, JSON.stringify(tileset, null, 1) + "\n");
console.log("implicit fixture written");
