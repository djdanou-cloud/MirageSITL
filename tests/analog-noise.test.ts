// TASK-068: analog video interference uniforms (rendering only). Pixel
// behaviour is checked in tests/browser/analog.spec.ts.
import { describe, expect, it } from "vitest";
import { AnalogVideo, DEFAULT_VIDEO_NOISE, hash32, type VideoNoiseConfig } from "../packages/cameras/src/analog.ts";

function snapshot(video: AnalogVideo): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(video.uniforms) as [string, { value: number }][]) out[k] = v.value;
  return out;
}

describe("visual RNG", () => {
  it("matches an independent lowbias32 implementation", () => {
    // Values from a separate Python implementation of the same hash.
    expect([0, 1, 2, 0xdeadbeef, 0xffffffff].map(hash32)).toEqual([0, 1753845952, 3507691905, 3861431939, 1734902346]);
  });

  it("derives the frame seed only from (seed, video frame)", () => {
    const video = new AnalogVideo({ ...DEFAULT_VIDEO_NOISE, seed: 1 });
    video.update(0, 0);
    expect(video.uniforms.uFrameSeed.value).toBe(1753845952); // hash32(1 ^ hash32(0)), Python reference
    video.update(1 / 30 + 1e-9, 0.9);
    expect(video.uniforms.uFrameSeed.value).toBe(3529208806); // hash32(1 ^ hash32(1)); throttle has no effect
    const seeds = new Set<number>();
    for (let k = 0; k < 10_000; k++) { video.update((k + 0.5) / 30, k % 7 / 7); seeds.add(video.uniforms.uFrameSeed.value); }
    expect(seeds.size).toBe(10_000);
  });
});

describe("AnalogVideo", () => {
  it("gives equal uniforms for equal seed, time and throttle, independent of render cadence", () => {
    const at60 = new AnalogVideo(), at144 = new AnalogVideo();
    const states60: Record<string, number>[] = [], states144: Record<string, number>[] = [];
    // Constant throttle within each video frame; render loops at 60 and 144 Hz.
    const throttle = (t: number) => (Math.floor(t * 30) % 10) / 10;
    for (let i = 0; i < 600; i++) { const t = i / 60; if (at60.update(t, throttle(t))) states60.push(snapshot(at60)); }
    for (let i = 0; i < 1440; i++) { const t = i / 144; if (at144.update(t, throttle(t))) states144.push(snapshot(at144)); }
    expect(states60).toHaveLength(300);
    expect(states144).toEqual(states60);
    const other = new AnalogVideo({ ...DEFAULT_VIDEO_NOISE, seed: 2 });
    other.update(0, 0);
    expect(other.uniforms.uFrameSeed.value).not.toBe(states60[0]!.uFrameSeed);
  });

  it("samples throttle once per video frame (decimated) and scales noise and jelly with it", () => {
    const video = new AnalogVideo();
    expect(video.update(0.001, 0)).toBe(true);
    const idle = snapshot(video);
    expect(video.update(0.02, 1)).toBe(false); // same video frame: unchanged
    expect(snapshot(video)).toEqual(idle);
    expect(video.update(0.034, 1)).toBe(true);
    const full = snapshot(video);
    const c = DEFAULT_VIDEO_NOISE;
    expect(idle.uNoise).toBeCloseTo(c.noiseBase, 15);
    expect(full.uNoise).toBeCloseTo(c.noiseBase + c.noiseThrottleGain, 15);
    expect([idle.uJellyAmpUv, full.uJellyAmpUv]).toEqual([0, c.jellyAmplitudeUv]);
    expect([idle.uVibFreqHz, full.uVibFreqHz]).toEqual([c.vibFreqMinHz, c.vibFreqMaxHz]);
    expect(full.uFrameStartS).toBeCloseTo(1 / 30, 15);
    expect(full.uLineTimeS).toBeCloseTo(c.readoutFraction / (30 * 480), 18);
    video.update(0.07, Number.NaN);
    expect(video.uniforms.uNoise.value).toBeCloseTo(c.noiseBase, 15); // NaN throttle reads as 0
    video.update(0.1, 7);
    expect(video.uniforms.uJellyAmpUv.value).toBe(c.jellyAmplitudeUv); // clamped
    expect(video.update(Number.NaN, 0)).toBe(false);
  });

  it("reads throttle without writing it or any other input", () => {
    const video = new AnalogVideo();
    const input = Object.freeze({ timeS: 1.234, throttle: 0.6 });
    expect(video.updateFrom(input)).toBe(true);
    expect(input).toEqual({ timeS: 1.234, throttle: 0.6 });
    // The controller exposes only uniforms; no method takes or returns physics state.
    expect(Object.getOwnPropertyNames(AnalogVideo.prototype).sort()).toEqual(["constructor", "frameSeedInto", "reset", "update", "updateFrom", "videoFrame"]);
  });

  it("rejects invalid configurations", () => {
    const bad: Partial<VideoNoiseConfig>[] = [{ seed: -1 }, { seed: 1.5 }, { frameRateHz: 0 }, { lines: 8 }, { readoutFraction: 0 }, { noiseBase: 2 },
      { vibFreqMaxHz: 10, vibFreqMinHz: 20 }, { jellyAmplitudeUv: 0.5 }, { tearProbability: Number.NaN }];
    for (const change of bad) expect(() => new AnalogVideo({ ...DEFAULT_VIDEO_NOISE, ...change }), JSON.stringify(change)).toThrow();
  });

  it("updates 1e6 render frames without triggering GC", async () => {
    const video = new AnalogVideo();
    const input = { timeS: 0, throttle: 0 };
    const run = (frames: number, start: number) => {
      let started = 0;
      for (let i = 0; i < frames; i++) {
        input.timeS = (start + i) / 144;
        input.throttle = (i % 100) / 100;
        if (video.updateFrom(input)) started++;
      }
      return started;
    };
    run(200_000, 0);
    // A per-update allocation of one 16-byte HeapNumber is 16 MB per window and always triggers a scavenge.
    const gcStarts: number[] = [];
    const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) gcStarts.push(e.startTime); });
    observer.observe({ entryTypes: ["gc"] });
    const windows: number[][] = [];
    for (let w = 0; w < 3; w++) {
      const t0 = performance.now();
      expect(run(1_000_000, 200_000 + w * 1_000_000)).toBeGreaterThan(200_000);
      const t1 = performance.now();
      windows.push([t0, t1]);
      await new Promise(resolve => setTimeout(resolve, 100));
      if (gcStarts.every(t => t < t0 || t > t1)) break;
    }
    observer.disconnect();
    const perWindow = windows.map(([t0, t1]) => gcStarts.filter(t => t >= t0! && t <= t1!).length);
    expect(perWindow, JSON.stringify(perWindow)).toContain(0);
  }, 60_000);
});
