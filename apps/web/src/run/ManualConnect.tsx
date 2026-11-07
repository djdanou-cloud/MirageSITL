import { useState } from "react";
import type { CompatibilityCheck, ConnectionSpec } from "./session-controller";

// Manual connection (TASK-155): the endpoints of an ArduPilot SITL the user
// started, and the checks a connection passed. ArduPilot's defaults are SITL
// instance 0: JSON physics to UDP 9002 (--sim-port-out) and MAVLink on the TCP
// server of SERIAL0, 5760. A UDP MAVLink port is one SITL or MAVProxy sends
// to. MirageSITL owns only the connection: Disconnect never stops the SITL.

/** ArduPilot SITL instance 0 (libraries/AP_HAL_SITL/SITL_cmdline.cpp at V4.7.2). */
export const DEFAULT_JSON_PHYSICS_PORT = 9002, DEFAULT_MAVLINK_TCP_PORT = 5760, DEFAULT_MAVLINK_UDP_PORT = 14550;

function portOf(text: string, label: string): number {
  const port = Number(text.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Enter the ${label} (1 to 65535)`);
  return port;
}

export function ManualConnect({ disabled, again, onConnect, onError }: {
  disabled: boolean; again: boolean; onConnect: (spec: ConnectionSpec) => void; onError: (message: string) => void;
}) {
  const [jsonPort, setJsonPort] = useState(String(DEFAULT_JSON_PHYSICS_PORT));
  const [transport, setTransport] = useState<"tcp" | "udp">("tcp");
  const [mavlinkPort, setMavlinkPort] = useState(String(DEFAULT_MAVLINK_TCP_PORT));
  const connect = () => {
    try {
      onConnect({ jsonPhysicsPort: portOf(jsonPort, "JSON physics port"), mavlink: { transport, port: portOf(mavlinkPort, "MAVLink port") } });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <fieldset className="sitl-connect">
      <legend>Or connect to a SITL you started</legend>
      <p className="hint">
        Start ArduCopter with <code>--model JSON</code> at the session's home, disarmed, with this profile's parameters. MirageSITL checks
        its physics packets, version, parameters and home, writes nothing to it, and never stops it.
      </p>
      <div className="sitl-form">
        <label htmlFor="sitl-json-port">JSON physics port (UDP)</label>
        <input id="sitl-json-port" type="text" inputMode="numeric" value={jsonPort} disabled={disabled} onChange={event => setJsonPort(event.target.value)} />
        <label htmlFor="sitl-mavlink-transport">MAVLink</label>
        <select id="sitl-mavlink-transport" value={transport} disabled={disabled} onChange={event => {
          const next = event.target.value === "udp" ? "udp" : "tcp";
          setTransport(next);
          setMavlinkPort(String(next === "udp" ? DEFAULT_MAVLINK_UDP_PORT : DEFAULT_MAVLINK_TCP_PORT));
        }}>
          <option value="tcp">TCP: SITL's serial port server</option>
          <option value="udp">UDP: a port SITL sends to</option>
        </select>
        <label htmlFor="sitl-mavlink-port">MAVLink port</label>
        <input id="sitl-mavlink-port" type="text" inputMode="numeric" value={mavlinkPort} disabled={disabled} onChange={event => setMavlinkPort(event.target.value)} />
      </div>
      <button type="button" onClick={connect} disabled={disabled}>{again ? "Connect again" : "Connect to running SITL"}</button>
    </fieldset>
  );
}

/** The checks a connection passed, in order. */
export function CompatibilityList({ checks }: { checks: readonly CompatibilityCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="sitl-compatibility" aria-label="Connection checks" data-testid="sitl-compatibility">
      {checks.map(check => <li key={check.check} data-check={check.check}>{check.text}</li>)}
    </ul>
  );
}
