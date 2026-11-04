// Where a response chart draws (TASK-173). There is one time scale, xOfS, for both
// lines: that is what makes them time-aligned, so tests/response-series.test.ts
// checks it here, and the browser test checks that the chart draws what this says.
import type { ResponseSeries } from "@mirage/scenarios/maneuvers";

export interface PlotBox { readonly width: number; readonly height: number; readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }
export interface PlotTick { readonly value: number; readonly at: number }
export interface PlotGeometry {
  readonly startS: number; readonly endS: number;
  xOfS(timeS: number): number;
  yOf(value: number): number;
  /** The request holds each value until the next: horizontal then vertical, so a change draws as a corner at its moment. */
  readonly requestedPath: string;
  readonly actualPath: string;
  /** Task time, from `startS`. */
  readonly xTicks: readonly PlotTick[];
  readonly yTicks: readonly PlotTick[];
}
export const PLOT_BOX: PlotBox = { width: 720, height: 260, left: 52, right: 12, top: 12, bottom: 34 };

/** Ticks on round numbers: 1, 2 or 5 times a power of ten, about `count` of them. */
export function niceTicks(low: number, high: number, count: number): number[] {
  if (!(high > low)) return [low];
  const rough = (high - low) / count, power = 10 ** Math.floor(Math.log10(rough)), share = rough / power;
  const step = (share <= 1 ? 1 : share <= 2 ? 2 : share <= 5 ? 5 : 10) * power;
  const ticks: number[] = [];
  // Round from the step's own multiples, so 0.1 + 0.2 does not read 0.30000000000000004.
  for (let i = Math.ceil(low / step); i * step <= high + step * 1e-9; i++) ticks.push(Number((i * step).toPrecision(12)));
  return ticks;
}

/** A dense line, reduced to what can differ on a chart this wide: in each pixel column its first, lowest, highest and last value, in time order. */
export function thinned(series: ResponseSeries, xOfS: (timeS: number) => number): { x: number; value: number }[] {
  const out: { x: number; value: number }[] = [];
  let column = Number.NaN, firstAt = 0, lowAt = 0, highAt = 0, lastAt = 0;
  const flush = () => {
    if (Number.isNaN(column)) return;
    for (const at of [...new Set([firstAt, lowAt, highAt, lastAt])].sort((a, b) => a - b)) {
      const t = series.timeS[at], value = series.value[at];
      if (t !== undefined && value !== undefined) out.push({ x: xOfS(t), value });
    }
  };
  for (let i = 0; i < series.value.length; i++) {
    const t = series.timeS[i], value = series.value[i];
    if (t === undefined || value === undefined) continue;
    const here = Math.floor(xOfS(t));
    if (here !== column) { flush(); column = here; firstAt = lowAt = highAt = lastAt = i; continue; }
    lastAt = i;
    if (value < (series.value[lowAt] ?? value)) lowAt = i;
    if (value > (series.value[highAt] ?? value)) highAt = i;
  }
  flush();
  return out;
}

const round = (value: number): number => Math.round(value * 100) / 100;

export function plotGeometry(requested: ResponseSeries, actual: ResponseSeries, startS: number, endS: number, box: PlotBox = PLOT_BOX): PlotGeometry {
  const plotWidth = box.width - box.left - box.right, plotHeight = box.height - box.top - box.bottom;
  const lengthS = endS > startS ? endS - startS : 1;
  const xOfS = (timeS: number) => box.left + (timeS - startS) / lengthS * plotWidth;
  // The value axis holds both lines over the time shown, with some air, and has a round tick at each end of it.
  const inWindow = (series: ResponseSeries) => series.value.filter((_, i) => { const t = series.timeS[i]; return t !== undefined && t >= startS && t <= endS; });
  const shown = [...inWindow(requested), ...inWindow(actual)];
  const low = shown.length > 0 ? Math.min(...shown) : 0, high = shown.length > 0 ? Math.max(...shown) : 1, air = (high - low || 1) * 0.08;
  const yTickValues = niceTicks(low - air, high + air, 5);
  const yLow = Math.min(low - air, yTickValues[0] ?? low), yHigh = Math.max(high + air, yTickValues[yTickValues.length - 1] ?? high);
  const yOf = (value: number) => box.top + (yHigh - value) / (yHigh - yLow) * plotHeight;

  let requestedPath = "";
  for (let i = 0; i < requested.value.length; i++) {
    const t = requested.timeS[i], value = requested.value[i];
    if (t === undefined || value === undefined || t < startS || t > endS) continue;
    requestedPath += requestedPath === "" ? `M${round(xOfS(t))} ${round(yOf(value))}` : `H${round(xOfS(t))}V${round(yOf(value))}`;
  }
  let actualPath = "";
  for (const point of thinned({ timeS: actual.timeS.filter(t => t >= startS && t <= endS), value: actual.value.filter((_, i) => { const t = actual.timeS[i]; return t !== undefined && t >= startS && t <= endS; }) }, xOfS)) {
    actualPath += `${actualPath === "" ? "M" : "L"}${round(point.x)} ${round(yOf(point.value))}`;
  }
  return {
    startS, endS, xOfS, yOf, requestedPath, actualPath,
    xTicks: niceTicks(0, endS - startS, 8).map(value => ({ value, at: xOfS(startS + value) })),
    yTicks: yTickValues.map(value => ({ value, at: yOf(value) })),
  };
}
