import { useState, type ChangeEvent, type FormEvent } from "react";
import type { ComponentCard, ComponentType } from "@mirage/aircraft/components";
import {
  checkMeasurementCards, measurementSetBench, measurementSetDraft, measurementSetFromBenchCsv, measurementSetFromColumns,
  type Combination, type MeasurementSet,
} from "@mirage/aircraft/measurements";
import type { ProjectStore } from "@mirage/project/store";
import { nameLanguage } from "../shell/project-files";
import {
  EMPTY_ROW, ENTRY_COLUMNS, describeCombination, describeLibraryError, entryColumns, parseDecimal, parseOptional, type EntryRow, type LibraryData,
} from "./library-data";

// Measurement sets (TASK-140, S04): bench data of one motor, propeller, ESC
// and power-supply combination, uploaded as bench CSV (v1 or v2) or typed in.
// A quantity left out is stored as not measured; nothing is filled in.

const LABORATORY = "laboratory";
const today = () => new Date().toISOString().slice(0, 10);
const optionalText = (text: string) => (text.trim() === "" ? null : text.trim());

function describeSet(set: MeasurementSet): string {
  const bench = measurementSetBench(set), rpms = bench.points.map(point => point.rpm);
  const conditions = set.conditions.airDensityKgM3 !== null
    ? `air density ${set.conditions.airDensityKgM3} kg/m³`
    : `air density ${bench.airDensityKgM3.toPrecision(4)} kg/m³ from ${set.conditions.airTemperatureK} K and ${set.conditions.airPressurePa} Pa`;
  const supply = set.conditions.supplyVoltageV === null ? "" : `, supply ${set.conditions.supplyVoltageV} V`;
  return `${bench.points.length} points from ${Math.min(...rpms)} to ${Math.max(...rpms)} rpm; ${conditions}${supply}.`;
}

export function MeasurementsEditor({ store, projectId, library, onSaved }: {
  store: ProjectStore; projectId: string; library: LibraryData; onSaved: () => void;
}) {
  const cards = library.cards.flatMap(entry => (entry.value ? [{ sha256: entry.stored.sha256, name: entry.stored.record.name, card: entry.value }] : []));
  const names = new Map(cards.map(item => [item.sha256, item.name]));
  const ofType = (type: ComponentType) => cards.filter(item => item.card.type === type);
  const [name, setName] = useState("");
  const [motor, setMotor] = useState("");
  const [propeller, setPropeller] = useState("");
  const [esc, setEsc] = useState("");
  const [supply, setSupply] = useState("");
  const [date, setDate] = useState(today);
  const [description, setDescription] = useState("");
  const [applicability, setApplicability] = useState("");
  const [source, setSource] = useState<"file" | "manual">("file");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [conditionsKind, setConditionsKind] = useState<"density" | "temperature">("density");
  const [density, setDensity] = useState("");
  const [temperature, setTemperature] = useState("");
  const [pressure, setPressure] = useState("");
  const [supplyVoltage, setSupplyVoltage] = useState("");
  const [rows, setRows] = useState<EntryRow[]>([EMPTY_ROW, EMPTY_ROW]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const readFile = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    if (!chosen) {
      setFile(null);
      return;
    }
    void chosen.text().then(text => setFile({ name: chosen.name, text }), () => setStatus(`The file ${chosen.name} could not be read.`));
  };
  const setCell = (index: number, key: keyof EntryRow, value: string) =>
    setRows(current => current.map((row, i) => (i === index ? { ...row, [key]: value } : row)));

  const build = async (): Promise<MeasurementSet> => {
    if (name.trim() === "") throw new Error("Give the measurement set a name");
    if (motor === "" || propeller === "" || esc === "" || supply === "") throw new Error("Choose the motor, propeller, ESC and power supply of the bench run");
    const combination: Combination = { motor, propeller, esc, supply: supply === LABORATORY ? { kind: "laboratory" } : { kind: "battery", card: supply } };
    const details = { combination, date, description: optionalText(description), applicability: optionalText(applicability) };
    let set: MeasurementSet;
    if (source === "file") {
      if (!file) throw new Error("Choose a bench CSV file");
      set = await measurementSetFromBenchCsv(file.text, { ...details, fileName: file.name });
    } else {
      const card = cards.find(item => item.sha256 === propeller)?.card;
      if (card?.type !== "propeller") throw new Error("Choose a propeller card");
      const conditions = conditionsKind === "density"
        ? { airDensityKgM3: parseDecimal(density, "Air density"), airTemperatureK: null, airPressurePa: null }
        : { airDensityKgM3: null, airTemperatureK: parseDecimal(temperature, "Air temperature"), airPressurePa: parseDecimal(pressure, "Air pressure") };
      set = measurementSetFromColumns({
        ...details, diameterM: card.values.diameterM, columns: entryColumns(rows),
        conditions: { ...conditions, supplyVoltageV: parseOptional(supplyVoltage, "Supply voltage") },
      });
    }
    checkMeasurementCards(set, new Map<string, ComponentCard>(cards.map(item => [item.sha256, item.card])));
    return set;
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    void (async () => {
      const set = await build();
      const stored = await store.createItem(projectId, "measurement-set", measurementSetDraft(name, set));
      const missing = measurementSetBench(set).missing;
      setName("");
      setFile(null);
      setRows([EMPTY_ROW, EMPTY_ROW]);
      onSaved();
      return `Saved measurement set ${stored.record.name}: ${set.points.rpm.length} points. ` +
        (missing.length > 0 ? `Not measured: ${missing.join(", ")}.` : "Every quantity was measured.");
    })().then(setStatus, (error: unknown) => setStatus(`The measurement set was not saved: ${describeLibraryError(error)}`)).finally(() => setBusy(false));
  };

  const select = (id: string, label: string, value: string, onChange: (value: string) => void, type: ComponentType, laboratory = false) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={event => onChange(event.target.value)}>
        <option value="">Choose a card</option>
        {ofType(type).map(item => <option key={item.sha256} value={item.sha256}>{item.name}</option>)}
        {laboratory && <option value={LABORATORY}>Laboratory power supply</option>}
      </select>
    </div>
  );
  const sets = library.sets;
  return (
    <section className="project-section measurements" aria-labelledby="measurements-heading">
      <h3 id="measurements-heading">Measurements</h3>
      <p className="hint">
        Bench data belongs to one exact motor, propeller, ESC and power supply. It is never used for another combination,
        and static data of one rotor does not validate forward flight, descent or coaxial pairs.
      </p>
      {sets.length === 0 ? <p>No measurement sets yet.</p> : (
        <ul className="card-list" aria-label="Measurement sets">
          {sets.map(entry => (
            <li key={entry.stored.sha256}>
              <span className="card-name" lang={nameLanguage(entry.stored.record.name)}>{entry.stored.record.name}</span>
              {entry.value ? (
                <span className="hint">
                  {describeCombination(entry.value.combination, names)}. {describeSet(entry.value)}{" "}
                  {entry.value.source.kind === "file" ? `File ${entry.value.source.fileName ?? ""}` : "Entered by hand"}, measured {entry.value.source.date}.{" "}
                  {measurementSetBench(entry.value).missing.length > 0 ? `Not measured: ${measurementSetBench(entry.value).missing.join(", ")}.` : ""}
                </span>
              ) : <span className="project-warning">This measurement set cannot be read: {entry.error}</span>}
            </li>
          ))}
        </ul>
      )}
      <form className="measurement-form" onSubmit={save} aria-label="New measurement set">
        <div className="field">
          <label htmlFor="set-name">Measurement set name</label>
          <input id="set-name" type="text" value={name} onChange={event => setName(event.target.value)} />
        </div>
        {select("set-motor", "Motor card", motor, setMotor, "motor")}
        {select("set-propeller", "Propeller card", propeller, setPropeller, "propeller")}
        {select("set-esc", "ESC card", esc, setEsc, "esc")}
        {select("set-supply", "Power supply", supply, setSupply, "battery", true)}
        <div className="field">
          <label htmlFor="set-date">Measurement date</label>
          <input id="set-date" type="date" value={date} onChange={event => setDate(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="set-description">Description (optional)</label>
          <input id="set-description" type="text" value={description} onChange={event => setDescription(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="set-applicability">Limits of use (optional)</label>
          <input id="set-applicability" type="text" value={applicability} onChange={event => setApplicability(event.target.value)} />
        </div>
        <fieldset>
          <legend>Data</legend>
          <label className="choice"><input type="radio" name="set-source" checked={source === "file"} onChange={() => setSource("file")} /> Upload a bench CSV file</label>
          <label className="choice"><input type="radio" name="set-source" checked={source === "manual"} onChange={() => setSource("manual")} /> Enter values</label>
        </fieldset>
        {source === "file" ? (
          <div className="field">
            <label htmlFor="set-file">Bench CSV file</label>
            <input id="set-file" type="file" accept=".csv,text/csv" onChange={readFile} />
            <p className="hint" data-testid="set-file-read">{file ? `Read ${file.name}.` : "No file is chosen."}</p>
            <p className="hint">Bench CSV v2 states the air density, or the temperature and pressure, and holds only the measured columns. Version 1 files are accepted when all rows share one air density.</p>
          </div>
        ) : (
          <>
            <fieldset>
              <legend>Conditions</legend>
              <label className="choice"><input type="radio" name="set-conditions" checked={conditionsKind === "density"} onChange={() => setConditionsKind("density")} /> Air density</label>
              <label className="choice"><input type="radio" name="set-conditions" checked={conditionsKind === "temperature"} onChange={() => setConditionsKind("temperature")} /> Temperature and pressure</label>
              {conditionsKind === "density" ? (
                <div className="field">
                  <label htmlFor="set-density">Air density (kg/m³)</label>
                  <input id="set-density" type="text" inputMode="decimal" value={density} onChange={event => setDensity(event.target.value)} />
                </div>
              ) : (
                <>
                  <div className="field">
                    <label htmlFor="set-temperature">Air temperature (K)</label>
                    <input id="set-temperature" type="text" inputMode="decimal" value={temperature} onChange={event => setTemperature(event.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="set-pressure">Air pressure (Pa)</label>
                    <input id="set-pressure" type="text" inputMode="decimal" value={pressure} onChange={event => setPressure(event.target.value)} />
                  </div>
                </>
              )}
              <div className="field">
                <label htmlFor="set-supply-voltage">Supply voltage (V, optional)</label>
                <input id="set-supply-voltage" type="text" inputMode="decimal" value={supplyVoltage} onChange={event => setSupplyVoltage(event.target.value)} />
              </div>
            </fieldset>
            <fieldset>
              <legend>Measured values</legend>
              <p className="hint">Speed and thrust are needed in every row. Leave a column empty in all rows if it was not measured.</p>
              <div className="table-scroll">
                <table className="entry-table">
                  <thead>
                    <tr>{ENTRY_COLUMNS.map(column => <th key={column.key} scope="col">{column.label}</th>)}</tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={index}>
                        {ENTRY_COLUMNS.map(column => (
                          <td key={column.key}>
                            <input type="text" inputMode="decimal" aria-label={`Row ${index + 1} ${column.label}`} value={row[column.key]}
                              onChange={event => setCell(index, column.key, event.target.value)} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="button-row">
                <button type="button" onClick={() => setRows(current => [...current, EMPTY_ROW])}>Add row</button>
                <button type="button" disabled={rows.length <= 1} onClick={() => setRows(current => current.slice(0, -1))}>Remove last row</button>
              </div>
            </fieldset>
          </>
        )}
        <div className="button-row">
          <button type="submit" disabled={busy}>Save measurement set</button>
        </div>
      </form>
      <p role="status" className="status-message" data-testid="measurement-status">{status}</p>
    </section>
  );
}
