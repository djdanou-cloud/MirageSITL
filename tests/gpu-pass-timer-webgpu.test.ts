import { describe, expect, it } from "vitest";
import { G3_PASSES } from "../apps/web/src/render/gpu-pass-timer";
import { LOG_FRAMES, attributePasses, newPassLog, newPassRanges } from "../apps/web/src/render/gpu-pass-timer-webgpu";

// TASK-073 diagnostics: resolved WebGPU timestamp pairs are attributed to the G3 pass whose
// allocation range contains them, summed per frame, with the frame's GPU span.
const P = G3_PASSES.length;
const pass = (name: (typeof G3_PASSES)[number]) => G3_PASSES.indexOf(name);

function ranges(rows: [frame: number, pass: number, start: number, end: number][]) {
  const r = newPassRanges(16);
  for (const [f, p, s, e] of rows) {
    const i = r.count++;
    r.frame[i] = f; r.pass[i] = p; r.start[i] = s; r.end[i] = e;
  }
  return r;
}

describe("WebGPU pass attribution", () => {
  it("sums every pair inside a pass's range and spans the frame", () => {
    // Frame 0: fpvScene opened two passes (shadow map 1 ms + scene 4 ms), fisheye 0.5 ms; frame 1: chaseScene 3 ms.
    const ns = 1_000_000n;
    const times = [10n * ns, 11n * ns, 12n * ns, 16n * ns, 17n * ns, 17n * ns + ns / 2n, 30n * ns, 33n * ns];
    const log = newPassLog();
    const written = attributePasses(times, ranges([[0, pass("fpvScene"), 0, 4], [0, pass("fisheye"), 4, 6], [1, pass("chaseScene"), 6, 8]]), log);
    expect(written).toBe(2);
    expect(log.frames).toBe(2);
    expect(log.passMs[pass("fpvScene")]).toBeCloseTo(5, 9);
    expect(log.passMs[pass("fisheye")]).toBeCloseTo(0.5, 9);
    expect(log.spanMs[0]).toBeCloseTo(7.5, 9); // 10 ms -> 17.5 ms
    expect(log.passMs[P + pass("chaseScene")]).toBeCloseTo(3, 9);
    expect(log.passMs[P + pass("fpvScene")]).toBe(0);
    expect(Array.from(log.frame.slice(0, 2))).toEqual([0, 1]);
  });

  it("skips pairs that were never written or run backwards", () => {
    const log = newPassLog();
    attributePasses([0n, 5_000_000n, 9_000_000n, 8_000_000n, 1_000_000n, 3_000_000n], ranges([[4, pass("gbuffer"), 0, 6]]), log);
    expect(log.passMs[pass("gbuffer")]).toBeCloseTo(2, 9);
    expect(log.spanMs[0]).toBeCloseTo(2, 9);
  });

  it("wraps the log ring and clears the reused row", () => {
    const log = newPassLog();
    log.frames = LOG_FRAMES - 1;
    log.passMs.fill(7);
    attributePasses([5_000_000n, 6_000_000n, 7_000_000n, 9_000_000n], ranges([[9, pass("thermal"), 0, 2], [10, pass("present"), 2, 4]]), log);
    const last = (LOG_FRAMES - 1) * P;
    expect(log.passMs[last + pass("thermal")]).toBeCloseTo(1, 9);
    expect(log.passMs[last + pass("fpvScene")]).toBe(0);
    expect(log.passMs[pass("present")]).toBeCloseTo(2, 9); // row 0 reused
    expect(log.passMs[pass("thermal")]).toBe(0);
    expect(log.frames).toBe(LOG_FRAMES + 1);
  });
});
