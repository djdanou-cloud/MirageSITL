import { parameterText, type AnalysisContext, type TimelineStatus } from "./experiment-adapter";

// Beside the viewer (TASK-180): what the source of this log can say, and that it cannot say the rest.

const STATUS_TEXT: Readonly<Record<TimelineStatus, string>> = {
  requested: "Requested, not yet confirmed", confirmed: "Confirmed", rejected: "Rejected", superseded: "Replaced by a later write", logged: "In the log; who asked is not known",
};

export function ContextPanel({ context }: { context: AnalysisContext }) {
  return (
    <section className="project-section analysis-context" aria-labelledby="analysis-context-heading" data-testid="analysis-context" data-source={context.source}>
      <h3 id="analysis-context-heading">{context.title}</h3>
      <dl className="sitl-status">
        {context.rows.map(row => (
          <div key={row.label} data-testid="analysis-context-row" data-label={row.label} data-unknown={row.value === null}>
            <dt>{row.label}</dt>
            <dd>{row.value ?? "Unknown"}</dd>
          </div>
        ))}
      </dl>
      {context.lineage && <p className="hint" data-testid="analysis-lineage">{context.lineage}</p>}
      <h4>Parameter changes</h4>
      {context.history === null
        ? <p className="hint" data-testid="analysis-no-history">{context.source === "experiment" ? "This experiment has no stored parameter history." : "This log holds no parameter records, so nothing can be said about its parameter changes."}</p>
        : context.events.length === 0
          ? <p className="hint" data-testid="analysis-no-events">{context.history === "run" ? "No parameter was changed in this run." : "The parameters in this log never change."}</p>
          : (
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Parameter changes table">
              <table className="scheme-table" aria-label="Parameter changes" data-testid="analysis-events">
                <thead><tr><th scope="col">Time, s</th><th scope="col">Parameter</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Outcome</th></tr></thead>
                <tbody>
                  {context.events.map((event, index) => (
                    <tr key={index} data-status={event.status}>
                      <th scope="row">{event.timeS.toFixed(2)}</th><td>{event.name}</td><td>{parameterText(event.from)}</td><td>{parameterText(event.to)}</td><td>{STATUS_TEXT[event.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      {context.differences && context.differences.length > 0 && (
        <>
          <h4>What changed over the {context.source === "experiment" ? "run" : "log"}</h4>
          <ul data-testid="analysis-differences">
            {context.differences.map(item => <li key={item.name}>{`${item.name}: ${parameterText(item.from)} → ${parameterText(item.to)}`}</li>)}
          </ul>
        </>
      )}
    </section>
  );
}
