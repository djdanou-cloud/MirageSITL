import { useEffect, useState } from "react";
import {
  EFFECT_CATALOG,
  EFFECT_IDS,
  effectDefinition,
  initialEffectParameters,
  type EffectFamily,
  type EffectId,
  type EffectParameterValue,
  type EffectRecovery,
} from "@mirage/protocol";
import type { SimulationRuntime } from "../runtime";
import { EffectFieldInput, numberText } from "./effect-form";
import { instructorKey } from "./hotkeys";

// The instructor's controls (TASK-166): one form for every effect, read from the
// protocol's catalog, so a range shown here is the range the protocol enforces and
// a new effect appears without changing this file. Sending never claims success:
// the log shows pending, queued, applied or rejected from the TASK-075 ledger.

interface Draft {
  id: string;
  enabled: boolean;
  intensity: number;
  parameters: Record<string, EffectParameterValue>;
  recovery: EffectRecovery;
}
const FAMILIES: readonly { family: EffectFamily; label: string }[] = [
  { family: "environment", label: "Environment" },
  { family: "fault", label: "Faults and electronic warfare" },
  { family: "sensor", label: "Sensor errors" },
  { family: "delivery", label: "Frozen readings and lost links" },
  { family: "ardupilot", label: "ArduPilot's own sensor faults" },
];
const newDraft = (effect: EffectId): Draft => ({
  id: effect.replaceAll(".", "-"),
  enabled: true,
  intensity: 1,
  parameters: initialEffectParameters(effect),
  recovery: "hold-offset",
});
export function Console({ runtime }: { runtime: SimulationRuntime | null }) {
  const [effect, setEffect] = useState<EffectId>("wind.mean");
  const [drafts, setDrafts] = useState<Partial<Record<EffectId, Draft>>>({});
  const [refusal, setRefusal] = useState("");
  const [modelId, setModelId] = useState(0),
    [modelHash, setModelHash] = useState("");
  const definition = effectDefinition(effect);
  const draft = drafts[effect] ?? newDraft(effect);
  const change = (next: Partial<Draft>) => {
    setRefusal("");
    setDrafts((all) => ({ ...all, [effect]: { ...draft, ...next } }));
  };
  const send = () => {
    if (!runtime) return;
    const command = runtime.submitControl({
      type: "effect.set",
      atTick: runtime.nextTick(),
      control: { schemaVersion: 1, id: draft.id, effect, enabled: draft.enabled, intensity: draft.intensity, parameters: draft.parameters },
      recovery: draft.recovery,
    });
    // The protocol refused it before it reached the Worker, so the ledger will not show it.
    setRefusal(command ? "" : runtime.notice);
  };
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const action = instructorKey(event);
      if (!action || !runtime?.ready) return;
      event.preventDefault();
      if (action === "pause") runtime.command("pause");
      else if (action === "reset") runtime.command("reset");
      else send();
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
        Shortcuts: P pause · R reset · F send this control. A control takes
        effect only when the log says applied. A backend that cannot apply one
        rejects it here and says why.
      </p>
      <label>
        Effect
        <select
          aria-label="Effect"
          value={effect}
          onChange={(e) => {
            const next = EFFECT_IDS.find((id) => id === e.target.value);
            if (next) { setRefusal(""); setEffect(next); }
          }}
        >
          {FAMILIES.map(({ family, label }) => (
            <optgroup key={family} label={label}>
              {EFFECT_IDS.filter((id) => EFFECT_CATALOG[id].family === family).map((id) => (
                <option key={id} value={id}>{EFFECT_CATALOG[id].label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <p className="hint" data-testid="effect-meaning">{definition.meaning}</p>
      <label>
        Control ID
        <input
          aria-label="Control ID"
          value={draft.id}
          onChange={(e) => change({ id: e.target.value })}
          maxLength={64}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => change({ enabled: e.target.checked })}
        />
        On
      </label>
      <label>
        Intensity
        <input
          aria-label="Intensity"
          type="number"
          min={0}
          step={0.1}
          value={numberText(draft.intensity)}
          onChange={(e) => change({ intensity: e.target.valueAsNumber })}
        />
        <small>0 or more; 1 is the values below</small>
      </label>
      {definition.fields.map((field) => (
        <EffectFieldInput
          key={field.key}
          field={field}
          value={draft.parameters[field.key]}
          onChange={(next) => change({ parameters: { ...draft.parameters, [field.key]: next } })}
        />
      ))}
      {definition.family === "fault" && (
        <label>
          When switched off
          <select
            aria-label="When switched off"
            value={draft.recovery}
            onChange={(e) => {
              if (e.target.value === "hold-offset" || e.target.value === "step-to-truth") change({ recovery: e.target.value });
            }}
          >
            <option value="hold-offset">Hold the offset</option>
            <option value="step-to-truth">Step back to the truth</option>
          </select>
        </label>
      )}
      <button disabled={!runtime?.ready} onClick={send}>
        Send control
      </button>
      {refusal && <p className="alert" role="alert" data-testid="control-refused">{refusal}</p>}
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
            {e.label}: {e.status} — {e.message}
          </li>
        ))}
      </ol>
    </section>
  );
}
