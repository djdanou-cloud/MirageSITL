import { useMemo, useRef, useState } from "react";
import { PLOT_BOX, plotGeometry } from "./response-geometry";
import { valueAt, type ManeuverSeries } from "./response-series";

// Requested against actual on one time axis (TASK-173): the request as the corners
// it really had, and the truth the recording holds. Hovering reads both at a moment,
// and the table below the chart holds the same numbers for anyone not reading a chart.

const NO_HOVER = null;

export function ResponsePlot({ series }: { series: ManeuverSeries }) {
  const { requested, actual, startS, endS, label, unit } = series;
  const geometry = useMemo(() => plotGeometry(requested, actual, startS, endS), [requested, actual, startS, endS]);
  const svg = useRef<SVGSVGElement | null>(null);
  const [hoverS, setHoverS] = useState<number | null>(NO_HOVER);
  const box = PLOT_BOX;
  const digits = unit === "m" ? 2 : 1;
  const onMove = (clientX: number) => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const x = (clientX - rect.left) / rect.width * box.width;
    const share = (x - box.left) / (box.width - box.left - box.right);
    setHoverS(share < 0 || share > 1 ? NO_HOVER : startS + share * (endS - startS));
  };
  const hoverRequested = hoverS === null ? null : valueAt(requested, hoverS), hoverActual = hoverS === null ? null : valueAt(actual, hoverS);
  const hoverX = hoverS === null ? 0 : geometry.xOfS(hoverS);
  const text = (value: number | null) => (value === null ? "none" : `${value.toFixed(digits)} ${unit}`);
  return (
    <figure className="response-plot" data-testid="response-plot">
      <figcaption className="response-legend">
        <span><i className="response-key response-key-requested" aria-hidden="true" />Requested</span>
        <span><i className="response-key response-key-actual" aria-hidden="true" />Actual (physics truth)</span>
      </figcaption>
      <div className="response-canvas">
        <svg ref={svg} viewBox={`0 0 ${box.width} ${box.height}`} role="img"
          aria-label={`${label} requested and actual, in ${unit === "m" ? "metres" : "degrees"}, over ${(endS - startS).toFixed(1)} s. The table below holds the numbers.`}
          data-start-s={startS} data-end-s={endS} data-left={box.left} data-right={box.width - box.right}
          onPointerMove={event => onMove(event.clientX)} onPointerLeave={() => setHoverS(NO_HOVER)}>
          {geometry.yTicks.map(tick => (
            <g key={tick.value}>
              <line className="response-grid" x1={box.left} x2={box.width - box.right} y1={tick.at} y2={tick.at} />
              <text className="response-tick" x={box.left - 6} y={tick.at + 4} textAnchor="end">{tick.value}</text>
            </g>
          ))}
          {geometry.xTicks.map(tick => (
            <text key={tick.value} className="response-tick" x={tick.at} y={box.height - box.bottom + 15} textAnchor="middle">{tick.value}</text>
          ))}
          <text className="response-tick" x={box.left + (box.width - box.left - box.right) / 2} y={box.height - 4} textAnchor="middle">Task time, s</text>
          <text className="response-tick" transform={`translate(11 ${box.top + (box.height - box.top - box.bottom) / 2}) rotate(-90)`} textAnchor="middle">{`${label}, ${unit}`}</text>
          <path className="response-line response-requested" data-testid="response-requested" d={geometry.requestedPath} />
          <path className="response-line response-actual" data-testid="response-actual" d={geometry.actualPath} />
          {hoverS !== null && (
            <g data-testid="response-crosshair">
              <line className="response-crosshair" x1={hoverX} x2={hoverX} y1={box.top} y2={box.height - box.bottom} />
              {hoverRequested !== null && <circle className="response-dot response-dot-requested" cx={hoverX} cy={geometry.yOf(hoverRequested)} r={4} />}
              {hoverActual !== null && <circle className="response-dot response-dot-actual" cx={hoverX} cy={geometry.yOf(hoverActual)} r={4} />}
            </g>
          )}
        </svg>
        {hoverS !== null && (
          <div className="response-tooltip" data-testid="response-tooltip" style={{ left: `${hoverX / box.width * 100}%` }} data-flip={hoverX > box.width * 0.7}>
            <strong>{`${(hoverS - startS).toFixed(2)} s`}</strong>
            <span><i className="response-key response-key-requested" aria-hidden="true" />{`Requested ${text(hoverRequested)}`}</span>
            <span><i className="response-key response-key-actual" aria-hidden="true" />{`Actual ${text(hoverActual)}`}</span>
          </div>
        )}
      </div>
    </figure>
  );
}
