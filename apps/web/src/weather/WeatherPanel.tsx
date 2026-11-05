import { useEffect, useState, useSyncExternalStore } from "react";
import { EFFECT_CATALOG } from "@mirage/protocol";
import { MAX_SCHEDULED_EFFECTS, faultTimeline, scheduledEffectId, type ScheduledEffect } from "@mirage/scenarios/fault-schedule";
import { EMPTY_WEATHER_SCHEDULE, weatherSchedule, type WeatherSchedule } from "@mirage/scenarios/weather-schedule";
import type { ProjectStore } from "@mirage/project/store";
import type { EffectEntry } from "../run/session-controller";
import type { SessionLink } from "../run/session-link";
import type { LocationChoice } from "./location";
import { WEATHER_EFFECTS, describeWeather, initialWeatherForm, isWeatherEffect, newSeed, weatherControl, type WeatherEffect, type WeatherForm } from "./weather-form";
import { loadWeatherSchedule, saveWeatherSchedule } from "./weather-store";

// The weather of the Weather and location tab (TASK-167, S07): a steady wind, the synthetic gust, a discrete gust, Dryden turbulence
// and the air at the ground, each applied by hand on the run going now or put on the schedule the next run applies by itself, counted
// from the first arming. Every value is a TASK-166 control, logged with its values and seeds, so a seed repeats its realization.

const TITLES: Readonly<Record<WeatherEffect, string>> = {
  "wind.mean": "Steady wind", "wind.gust": "Synthetic gust", "wind.discrete-gust": "Discrete gust", "wind.turbulence": "Turbulence", atmosphere: "Air at the ground",
};
const STATUS_TEXT = { pending: "Pending", applied: "Applied", rejected: "Rejected" } as const;
const seconds = (value: number | null) => (value === null ? "—" : value.toFixed(2));
const typed = (text: string): number | null => {
  const value = text.trim() === "" ? Number.NaN : Number(text);
  return Number.isFinite(value) ? value : null;
};
/** What each weather effect is now in this run: its last applied control. */
function inEffect(effects: readonly EffectEntry[]): Map<WeatherEffect, EffectEntry> {
  const now = new Map<WeatherEffect, EffectEntry>();
  for (const entry of effects) if (isWeatherEffect(entry.effect) && entry.status === "applied") now.set(entry.effect, entry);
  return now;
}

export function WeatherPanel({ store, projectId, link, active, location }: {
  store: ProjectStore | null; projectId: string | null; link: SessionLink; active: boolean; location: LocationChoice;
}) {
  const session = useSyncExternalStore(link.subscribe, link.snapshot);
  const view = session?.view ?? null, controller = session?.controller ?? null, running = controller !== null && controller.active;
  const [form, setForm] = useState<WeatherForm>(() => initialWeatherForm(location));
  const [schedule, setSchedule] = useState<WeatherSchedule>(EMPTY_WEATHER_SCHEDULE);
  const [onset, setOnset] = useState("0"), [duration, setDuration] = useState("");
  const [refusal, setRefusal] = useState("");
  useEffect(() => {
    if (!store || !projectId || !active) return;
    let cancelled = false;
    void loadWeatherSchedule(store, projectId).then(loaded => { if (!cancelled) setSchedule(loaded); });
    return () => { cancelled = true; };
  }, [store, projectId, active]);
  // A new location brings its own sea-level pressure and temperature offset.
  useEffect(() => { setForm(current => ({ ...current, air: initialWeatherForm(location).air })); }, [location]);

  const set = <K extends keyof WeatherForm>(group: K, key: keyof WeatherForm[K], value: string) => {
    setRefusal("");
    setForm(current => ({ ...current, [group]: { ...current[group], [key]: value } }));
  };
  const send = (effect: WeatherEffect, enabled: boolean) => {
    setRefusal("");
    if (!controller) { setRefusal("No run is active: start one on the Run tab, or put this on the schedule."); return; }
    const outcome = weatherControl(form, effect, location, effect.replaceAll(".", "-"));
    if (!outcome.control) { setRefusal(outcome.problem); return; }
    const why = controller.setEffect({ ...outcome.control, enabled });
    if (why !== null) setRefusal(why);
  };
  const keep = (next: WeatherSchedule) => {
    setSchedule(next);
    if (store && projectId) void saveWeatherSchedule(store, projectId, next).catch((cause: unknown) => setRefusal(`The schedule could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
  const add = (effect: WeatherEffect) => {
    setRefusal("");
    const onsetS = typed(onset), durationS = duration.trim() === "" ? null : typed(duration);
    if (onsetS === null || onsetS < 0) { setRefusal("The onset must be a time of 0 s or more."); return; }
    if (duration.trim() !== "" && durationS === null) { setRefusal("The duration must be a number of seconds, or empty to keep it on until the run ends."); return; }
    if (schedule.entries.length >= MAX_SCHEDULED_EFFECTS) { setRefusal(`A schedule holds at most ${MAX_SCHEDULED_EFFECTS} weather changes.`); return; }
    const used = new Set(schedule.entries.map(entry => entry.control.id));
    let index = schedule.entries.length;
    while (used.has(scheduledEffectId(effect, index))) index++;
    const outcome = weatherControl(form, effect, location, scheduledEffectId(effect, index));
    if (!outcome.control) { setRefusal(outcome.problem); return; }
    const entry: ScheduledEffect = { control: outcome.control, onsetS, durationS, recovery: "hold-offset" };
    try {
      keep(weatherSchedule([...schedule.entries, entry]));
    } catch (cause) {
      setRefusal(cause instanceof Error ? cause.message.replace(/^Invalid weather schedule: (entries\[\d+\]: )?/, "") : String(cause));
    }
  };
  const remove = (id: string) => keep(weatherSchedule(schedule.entries.filter(entry => entry.control.id !== id)));

  const text = (id: string, label: string, value: string, onChange: (next: string) => void) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" inputMode="decimal" value={value} onChange={event => onChange(event.target.value)} />
    </div>
  );
  const buttons = (effect: WeatherEffect) => {
    const title = TITLES[effect], lower = title.toLowerCase();
    return (
      <div className="button-row">
        <button type="button" onClick={() => send(effect, true)} disabled={!running} aria-label={`Apply the ${lower} now`}>Apply now</button>
        <button type="button" onClick={() => send(effect, false)} disabled={!running} aria-label={`Turn the ${lower} off`}>Turn off</button>
        <button type="button" onClick={() => add(effect)} aria-label={`Add the ${lower} to the schedule`}>Add to the schedule</button>
      </div>
    );
  };
  const seed = (id: string, label: string, group: "gust" | "turbulence") => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="inline-field">
        <input id={id} type="text" inputMode="numeric" value={form[group].seed} onChange={event => set(group, "seed", event.target.value)} />
        <button type="button" onClick={() => set(group, "seed", String(newSeed()))} aria-label={`New ${label.toLowerCase()}`}>New seed</button>
      </div>
    </div>
  );
  const now = inEffect(view?.effects ?? []);
  const plan = view?.weatherPlan ?? null, waiting = plan ? faultTimeline(plan.schedule).slice(plan.sent) : [];
  const ledger = (view?.effects ?? []).filter(entry => isWeatherEffect(entry.effect));

  return (
    <section className="project-section weather-section" aria-labelledby="weather-heading" data-testid="weather-panel">
      <h3 id="weather-heading">Weather</h3>
      <p className="hint">
        Each setting is applied by hand on the run going now, or put on the schedule the next run applies by itself. A seed fixes a gust
        or turbulence realization: the same seed gives the same weather again, and every value is logged with the run.
      </p>
      {!running && <p className="hint" data-testid="weather-no-run">Apply now needs a run with ArduPilot going on the Run tab.</p>}

      <fieldset className="weather-effect" data-effect="wind.mean">
        <legend>{TITLES["wind.mean"]}</legend>
        <div className="field-grid">
          {text("weather-wind-speed", "Speed, m/s", form.wind.speedMps, value => set("wind", "speedMps", value))}
          {text("weather-wind-from", "From, ° (bearing)", form.wind.fromDeg, value => set("wind", "fromDeg", value))}
        </div>
        {buttons("wind.mean")}
      </fieldset>
      <fieldset className="weather-effect" data-effect="wind.discrete-gust">
        <legend>{TITLES["wind.discrete-gust"]}</legend>
        <p className="hint">{EFFECT_CATALOG["wind.discrete-gust"].meaning}</p>
        <div className="field-grid">
          {text("weather-discrete-amplitude", "Amplitude, m/s", form.discrete.amplitudeMps, value => set("discrete", "amplitudeMps", value))}
          {text("weather-discrete-duration", "Duration, s", form.discrete.durationS, value => set("discrete", "durationS", value))}
          {text("weather-discrete-from", "Gust from, ° (bearing)", form.discrete.fromDeg, value => set("discrete", "fromDeg", value))}
          {text("weather-discrete-upward", "Upward angle, °", form.discrete.upwardDeg, value => set("discrete", "upwardDeg", value))}
        </div>
        {buttons("wind.discrete-gust")}
      </fieldset>
      <fieldset className="weather-effect" data-effect="wind.gust">
        <legend>{TITLES["wind.gust"]}</legend>
        <p className="hint">{EFFECT_CATALOG["wind.gust"].meaning}</p>
        <div className="field-grid">
          {text("weather-gust-rms", "RMS per axis, m/s", form.gust.rmsMps, value => set("gust", "rmsMps", value))}
          {text("weather-gust-bandwidth", "Bandwidth, Hz", form.gust.bandwidthHz, value => set("gust", "bandwidthHz", value))}
          {seed("weather-gust-seed", "Gust seed", "gust")}
        </div>
        {buttons("wind.gust")}
      </fieldset>
      <fieldset className="weather-effect" data-effect="wind.turbulence">
        <legend>{TITLES["wind.turbulence"]}</legend>
        <p className="hint">{EFFECT_CATALOG["wind.turbulence"].meaning}</p>
        <div className="field-grid">
          {text("weather-turbulence-w20", "Mean wind at 6 m (W20), m/s", form.turbulence.w20Mps, value => set("turbulence", "w20Mps", value))}
          {text("weather-turbulence-intensity", "Intensity", form.turbulence.intensity, value => set("turbulence", "intensity", value))}
          {seed("weather-turbulence-seed", "Turbulence seed", "turbulence")}
        </div>
        {buttons("wind.turbulence")}
      </fieldset>
      <fieldset className="weather-effect" data-effect="atmosphere">
        <legend>{TITLES.atmosphere}</legend>
        <p className="hint">{`The air at the location's elevation of ${location.groundElevationMslM} m, from this sea-level pressure and temperature offset; the pressure stays consistent with the altitude.`}</p>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="weather-air-pressure">Sea-level pressure</label>
            <select id="weather-air-pressure" value={form.air.pressure} onChange={event => set("air", "pressure", event.target.value === "measured" ? "measured" : "standard")}>
              <option value="standard">ISA standard (1013.25 hPa)</option>
              <option value="measured">Measured QNH</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="weather-air-qnh">Measured QNH (hPa)</label>
            <input id="weather-air-qnh" type="text" inputMode="decimal" value={form.air.qnhHpa} disabled={form.air.pressure !== "measured"} onChange={event => set("air", "qnhHpa", event.target.value)} />
          </div>
          {text("weather-air-offset", "Temperature offset from ISA, K", form.air.temperatureOffsetK, value => set("air", "temperatureOffsetK", value))}
        </div>
        {buttons("atmosphere")}
      </fieldset>
      {refusal && <p className="alert" role="alert" data-testid="weather-refusal">{refusal}</p>}

      <h4>In effect in this run</h4>
      <ul data-testid="weather-now">
        {WEATHER_EFFECTS.map(effect => {
          const entry = now.get(effect);
          const what = !entry || !entry.enabled || entry.intensity === 0 ? `${TITLES[effect]}: off`
            : entry.parameters ? describeWeather(effect, entry.parameters, entry.intensity) : `${TITLES[effect]}: on`;
          return <li key={effect} data-effect={effect} data-on={Boolean(entry?.enabled)}>{what}</li>;
        })}
      </ul>

      <h4>Schedule of the next run</h4>
      <p className="hint">Times count simulated seconds from when ArduPilot first reports the aircraft armed, as the fault schedule does. A run keeps the schedule it started with, in its experiment record, with its seeds.</p>
      <div className="field-grid">
        {text("weather-onset", "Onset, s after arming", onset, setOnset)}
        {text("weather-duration", "Duration, s (empty: until the run ends)", duration, setDuration)}
      </div>
      {schedule.entries.length === 0 ? <p className="hint" data-testid="weather-schedule-empty">No weather is scheduled.</p> : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="The weather schedule of the next run, scrollable">
          <table className="scheme-table" aria-label="The weather schedule of the next run" data-testid="weather-schedule">
            <thead><tr><th scope="col">Weather</th><th scope="col">Onset, s</th><th scope="col">Duration, s</th><th scope="col"><span className="visually-hidden">Remove</span></th></tr></thead>
            <tbody>
              {schedule.entries.map(entry => {
                const effect = entry.control.effect;
                if (!isWeatherEffect(effect)) return null;
                return (
                  <tr key={entry.control.id} data-effect={effect}>
                    <th scope="row">{describeWeather(effect, entry.control.parameters, entry.control.intensity)}</th>
                    <td>{entry.onsetS}</td>
                    <td>{entry.durationS ?? "Until the run ends"}</td>
                    <td><button type="button" onClick={() => remove(entry.control.id)} aria-label={`Remove ${describeWeather(effect, entry.control.parameters, entry.control.intensity)}`}>Remove</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h4>This run</h4>
      {plan && <p className="hint" data-testid="weather-armed">{plan.armedAtS === null ? "Its weather schedule starts counting when ArduPilot reports the aircraft armed." : `Armed at ${plan.armedAtS.toFixed(2)} s of simulated time.`}</p>}
      {waiting.length > 0 && plan && (
        <ul data-testid="weather-waiting">
          {waiting.map(item => {
            const entry = plan.schedule.entries[item.entry];
            return entry ? <li key={`${item.entry}-${item.on}`}>{`${EFFECT_CATALOG[entry.control.effect].label} goes ${item.on ? "on" : "off"} ${item.atS} s after arming`}</li> : null;
          })}
        </ul>
      )}
      {ledger.length === 0 ? <p className="hint" data-testid="weather-ledger-empty">No weather has been sent in this run.</p> : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="What became of each weather change, scrollable">
          <table className="scheme-table" aria-label="What became of each weather change" data-testid="weather-ledger">
            <thead><tr><th scope="col">Weather</th><th scope="col">Asked</th><th scope="col">From</th><th scope="col">Meant for, s</th><th scope="col">Applied at, s</th><th scope="col">Outcome</th></tr></thead>
            <tbody>
              {ledger.map((entry, index) => isWeatherEffect(entry.effect) && (
                <tr key={index} data-effect={entry.effect} data-status={entry.status} data-enabled={entry.enabled} data-origin={entry.origin}>
                  <th scope="row">{entry.parameters ? describeWeather(entry.effect, entry.parameters, entry.intensity) : TITLES[entry.effect]}</th>
                  <td>{entry.enabled ? "On" : "Off"}</td>
                  <td>{entry.origin === "manual" ? "By hand" : "Schedule"}</td>
                  <td>{seconds(entry.requestedSimS)}</td>
                  <td>{seconds(entry.appliedSimS)}</td>
                  <td>{entry.message || STATUS_TEXT[entry.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
