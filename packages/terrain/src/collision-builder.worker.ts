import { buildCollisionChunk, type HeightTile } from "./collision-build.ts";
function isTile(value: unknown): value is HeightTile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.keys(value).length === 8 && "version" in value && value.version === 1 &&
    "epoch" in value && typeof value.epoch === "number" &&
    "revision" in value && typeof value.revision === "number" &&
    "northIndex" in value && typeof value.northIndex === "number" &&
    "eastIndex" in value && typeof value.eastIndex === "number" &&
    "resolution" in value && typeof value.resolution === "number" &&
    "spacingM" in value && typeof value.spacingM === "number" &&
    "downM" in value && value.downM instanceof Float64Array;
}
// Dedicated module Worker entry point. Check the platform method before use;
// the real browser test exercises transfer ownership and malformed input.
const send: unknown = Reflect.get(globalThis, "postMessage");
if (typeof send !== "function") throw new Error("Collision builder requires a Worker messaging API");
globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  try {
    if (!isTile(event.data)) throw new Error("Invalid collision tile message");
    const chunk = buildCollisionChunk(event.data);
    Reflect.apply(send, globalThis, [{ type: "collision-built", chunk }, [chunk.downM.buffer, chunk.verticesNedM.buffer, chunk.indices.buffer]]);
  } catch {
    Reflect.apply(send, globalThis, [{ type: "collision-rejected" }]);
  }
});
