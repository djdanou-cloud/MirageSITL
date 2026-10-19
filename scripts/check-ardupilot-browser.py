"""Independent CRC/parameter/EEPROM audit of the real local browser firmware capture."""
import hashlib
import importlib.metadata
import inspect
import json
from pathlib import Path
import sys
from pymavlink.dialects.v20 import ardupilotmega


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    if len(sys.argv) != 3 or sys.argv[1] != "--input":
        raise ValueError("Expected --input BROWSER_CAPTURE_JSON")
    if importlib.metadata.version("pymavlink") != "2.4.50":
        raise ValueError("Requires pinned pymavlink 2.4.50")
    module_sha = sha(Path(inspect.getfile(ardupilotmega)).read_bytes())
    oracle = json.loads(Path("tests/fixtures/mavlink/wasm-parameters.json").read_bytes())
    if module_sha != oracle["generatedModuleSha256"]:
        raise ValueError("pymavlink generated-module identity mismatch")
    path = Path(sys.argv[2])
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Browser capture exceeds budget")
    data = json.loads(path.read_bytes())
    pinned = json.loads(Path("native/ardupilot/wasm-artifact.manifest.json").read_bytes())
    if data["schemaVersion"] != 1 or data["manifest"] != pinned or data["errors"] or data["remainingWorkers"] != 0:
        raise ValueError("Browser artifact/cleanup identity mismatch")
    identity = f"{pinned['sourceCommit']}:{pinned['module']['sha256']}:{data['profile']}"
    phases = []
    previous_revision = 0
    for name in ("first", "second", "third"):
        phase = data[name]
        serial = phase["serial"]
        if len(serial) > 4 * 1024 * 1024 or any(type(b) is not int or b < 0 or b > 255 for b in serial):
            raise ValueError("Invalid original serial bytes")
        raw = bytes(serial)
        parser = ardupilotmega.MAVLink(None)
        parser.robust_parsing = True
        messages = parser.parse_buffer(raw) or []
        # The serial bridge also carries the firmware's ASCII boot console.
        bad = [m for m in messages if m.get_type() == "BAD_DATA"]
        if any("CRC" in str(m.reason).upper() for m in bad):
            raise ValueError("CRC-invalid MAVLink in browser serial capture")
        heartbeats = [m for m in messages if m.get_type() == "HEARTBEAT" and m.get_srcSystem() == 1 and m.get_srcComponent() == 1]
        if len(heartbeats) < 3 or any(m.base_mode & 128 for m in heartbeats):
            raise ValueError("Missing real disarmed heartbeat evidence")
        values = [m.param_value for m in messages if m.get_type() == "PARAM_VALUE" and m.param_id == "WP_SPD"
                  and m.get_srcSystem() == 1 and m.get_srcComponent() == 1]
        if 8.125 not in values or name == "first" and data["initial"] not in values:
            raise ValueError("Real parameter set/restore differs from original wire bytes")
        if name == "first" and (data["initial"] == 8.125 or values[0] != data["initial"]) or name != "first" and any(v != 8.125 for v in values):
            raise ValueError("Parameter change/recovery order differs from original readbacks")
        initialized = next(e for e in phase["events"] if e["type"] == "initialized")
        booted = next(e for e in phase["events"] if e["type"] == "booted")
        if initialized["restoredRevision"] != previous_revision or initialized["maximumMemoryBytes"] != 2147483648:
            raise ValueError("Stored revision/memory budget mismatch")
        if not 0 < booted["memoryBytes"] <= 2147483648 or booted["ownedPthreads"] != 4:
            raise ValueError("Unexpected real firmware memory/thread topology")
        saved = phase["checkpoint"]
        image = bytes(saved["image"])
        if saved["identity"] != identity or len(image) != 16384 or sha(image) != saved["sha256"] or saved["revision"] <= previous_revision:
            raise ValueError("EEPROM image identity/checksum/revision mismatch")
        if name != "second":
            stopped = next(e for e in phase["events"] if e["type"] == "stopped")
            if stopped["terminatedPthreads"] != 4:
                raise ValueError("Owned firmware threads not terminated")
        previous_revision = saved["revision"]
        raw_path = path.with_name(f"task-045-{name}-serial.bin")
        image_path = path.with_name(f"task-045-{name}-eeprom.bin")
        raw_path.write_bytes(raw)
        image_path.write_bytes(image)
        phases.append({"phase": name, "heartbeats": len(heartbeats), "parameterValuesMps": values,
                       "consoleFragments": len(bad), "memoryBytes": booted["memoryBytes"],
                       "ownedPthreads": booted["ownedPthreads"], "restoredRevision": initialized["restoredRevision"],
                       "savedRevision": saved["revision"], "raw": {"file": raw_path.as_posix(), "sha256": sha(raw)},
                       "eeprom": {"file": image_path.as_posix(), "sha256": sha(image)}})
    result = {"schemaVersion": 1, "status": "PASS", "kind": "real-browser-local-firmware-boot-storage",
              "sourceCapture": {"file": path.as_posix(), "sha256": sha(path.read_bytes())},
              "auditorSha256": sha(Path(__file__).read_bytes()), "pymavlink": "2.4.50", "generatedModuleSha256": module_sha,
              "browser": data["browser"], "bootWorkers": data["bootWorkers"], "remainingWorkers": 0,
              "phases": phases, "scope": "Built-in synthetic quad, disarmed; no MirageSITL physics/HAL/parity/READY acceptance"}
    output = path.with_name("task-045-wire-audit.json")
    output.write_text(json.dumps(result, indent=2) + "\n")
    print("PASS: independent CRC-valid browser heartbeats/parameter readbacks and three EEPROM checkpoint hashes")


if __name__ == "__main__":
    main()
