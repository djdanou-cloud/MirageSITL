import { useEffect, useState } from "react";
import type { EwEffect } from "@mirage/protocol";
import type { SimulationRuntime } from "../runtime";
import { instructorKey } from "./hotkeys";
const EFFECTS: Readonly<Record<EwEffect["kind"], EwEffect>> = {
  "gnss-jamming": { kind: "gnss-jamming", severity: 1 },
  "position-step": { kind: "position-step", offsetNedM: [100, 0, 0] },
  "velocity-drift": {
    kind: "velocity-drift",
    accelerationNedMps2: [0.2, 0, 0],
    maxSpeedMps: 2,
  },
  magnetic: {
    kind: "magnetic",
    rotationRad: [0, 0, 0.5],
    biasBodyGauss: [0, 0, 0],
  },
  "motor-loss": {
    kind: "motor-loss",
    motorIndex: 0,
    mode: "power-cut",
    remainingThrustFraction: 0,
  },
};
/** Dynamic IDs are validated by Control Protocol v2 and the backend registry, never hard-coded as applied. */
export function Console({ runtime }: { runtime: SimulationRuntime | null }) {
  const [faultId, setFaultId] = useState("training-fault"),
    [kind, setKind] = useState<EwEffect["kind"]>("gnss-jamming"),
    [enabled, setEnabled] = useState(true);
  const [motorIndex, setMotorIndex] = useState(0);
  const [motorMode, setMotorMode] = useState<
    "power-cut" | "instant-thrust-loss"
  >("power-cut");
  const [remaining, setRemaining] = useState(0);
  const [wind, setWind] = useState(0),
    [modelId, setModelId] = useState(0),
    [modelHash, setModelHash] = useState("");
  const fault = () => {
    if (runtime)
      runtime.submitControl({
        type: "fault.set",
        atTick: runtime.nextTick(),
        faultId,
        enabled,
        effect:
          kind === "motor-loss"
            ? {
                kind,
                motorIndex,
                mode: motorMode,
                remainingThrustFraction: remaining,
              }
            : EFFECTS[kind],
        recovery: "hold-offset",
      });
  };
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const action = instructorKey(event);
      if (!action || !runtime?.ready) return;
      event.preventDefault();
      if (action === "pause") runtime.command("pause");
      else if (action === "reset") runtime.command("reset");
      else fault();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  });
  return (
    <section
      className="control-section instructor-console"
      aria-label="Instructor console"
    >
      <h2>Instructor</h2>
      <p>
        Shortcuts: P pause · R reset · F selected fault. The demo rejects
        unsupported weather/fault/model commands.
      </p>
      <label>
        Fault ID
        <input
          aria-label="Fault ID"
          value={faultId}
          onChange={(e) => setFaultId(e.target.value)}
          maxLength={64}
        />
      </label>
      <label>
        Effect
        <select
          aria-label="Fault effect"
          value={kind}
          onChange={(e) => {
            const k = Object.keys(EFFECTS).find((k) => k === e.target.value);
            if (k && k in EFFECTS) setKind(k as EwEffect["kind"]);
          }}
        >
          {Object.keys(EFFECTS).map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      {kind === "motor-loss" && (
        <>
          <label>
            Motor channel index
            <input
              aria-label="Motor channel index"
              type="number"
              min={0}
              max={31}
              value={motorIndex}
              onChange={(e) => setMotorIndex(Number(e.target.value))}
            />
          </label>
          <label>
            Motor failure mode
            <select
              aria-label="Motor failure mode"
              value={motorMode}
              onChange={(e) => {
                if (
                  e.target.value === "power-cut" ||
                  e.target.value === "instant-thrust-loss"
                )
                  setMotorMode(e.target.value);
              }}
            >
              <option value="power-cut">
                Power cut (preserve spool decay)
              </option>
              <option value="instant-thrust-loss">
                Instant thrust loss (synthetic)
              </option>
            </select>
          </label>
          <label>
            Remaining thrust fraction
            <input
              aria-label="Remaining thrust fraction"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={remaining}
              onChange={(e) => setRemaining(Number(e.target.value))}
            />
          </label>
        </>
      )}
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Enable fault
      </label>
      <button disabled={!runtime?.ready} onClick={fault}>
        Send fault
      </button>
      <label>
        Wind north (m/s)
        <input
          aria-label="Wind north"
          type="number"
          min={-100}
          max={100}
          value={wind}
          onChange={(e) => setWind(Number(e.target.value))}
        />
      </label>
      <button
        disabled={!runtime?.ready}
        onClick={() =>
          runtime?.submitControl({
            type: "weather.set",
            atTick: runtime.nextTick(),
            windNedMps: [wind, 0, 0],
            temperatureK: 288.15,
            pressurePa: 101325,
            turbulenceRmsMps: 0,
            seed: 0,
          })
        }
      >
        Send weather
      </button>
      <label>
        Model ID
        <input
          aria-label="Model ID"
          type="number"
          min={0}
          value={modelId}
          onChange={(e) => setModelId(Number(e.target.value))}
        />
      </label>
      <label>
        Model SHA-256
        <input
          aria-label="Model SHA-256"
          value={modelHash}
          onChange={(e) => setModelHash(e.target.value)}
          maxLength={64}
        />
      </label>
      <button
        disabled={!runtime?.ready || runtime.running}
        onClick={() =>
          runtime?.submitControl({
            type: "model.load",
            modelId,
            manifestSha256: modelHash,
          })
        }
      >
        Load model
      </button>
      <ol aria-live="polite" className="command-log">
        {runtime?.commands.entries.slice(-4).map((e) => (
          <li key={e.requestId} data-testid="command-result">
            {e.type}: {e.status} — {e.message}
          </li>
        ))}
      </ol>
    </section>
  );
}
