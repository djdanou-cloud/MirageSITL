"""Independently decode raw MAVLink bytes and compare the recorded telemetry."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
from pymavlink.dialects.v20 import ardupilotmega


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    if len(sys.argv) != 3 or sys.argv[1] != "--input":
        raise ValueError("Expected --input CAPTURE_DIRECTORY")
    version = importlib.metadata.version("pymavlink")
    if version != "2.4.50":
        raise ValueError("Raw audit requires pinned pymavlink 2.4.50")
    directory = Path(sys.argv[2])
    raw = (directory / "mavlink.raw").read_bytes()
    decoded = (directory / "telemetry.ndjson").read_bytes()
    if len(raw) > 32 * 1024 * 1024 or len(decoded) > 32 * 1024 * 1024:
        raise ValueError("MAVLink audit input exceeds budget")
    parser = ardupilotmega.MAVLink(None)
    parser.robust_parsing = True
    messages = parser.parse_buffer(raw) or []
    wanted = {"HEARTBEAT", "EKF_STATUS_REPORT", "GLOBAL_POSITION_INT",
              "LOCAL_POSITION_NED", "STATUSTEXT", "COMMAND_ACK", "EXTENDED_SYS_STATE",
              "HIGHRES_IMU", "RAW_IMU", "GPS_RAW_INT"}
    # The sidecar also forwards PARAM_VALUE for the names the driver read back
    # (TASK-089 IMU noise-floor check); older captures declare none.
    run = json.loads((directory / "run.json").read_text())
    floor = run.get("imuNoiseFloor") or {}
    read_back = {check["name"] for check in floor.get("expected", [])}

    def forwarded(message):
        kind = message.get_type()
        return ((kind in wanted or kind == "PARAM_VALUE" and message.param_id in read_back)
                and message.get_srcSystem() == 1 and message.get_srcComponent() == 1)

    observed = [message.to_dict() for message in messages if forwarded(message)]
    original = [json.loads(line)["message"] for line in decoded.splitlines()]
    records = [json.loads(line) for line in decoded.splitlines()]
    # Raw TCP reads can include a final unprocessed packet when the owned
    # sidecar stops; every emitted observation must match the ordered prefix.
    if not original or observed[:len(original)] != original:
        raise ValueError("Decoded telemetry differs from original CRC-checked MAVLink bytes")
    wire_frames_checked = 0
    if any("wireHex" in record for record in records):
        raw_frames = [message.get_msgbuf().hex() for message in messages if forwarded(message)]
        if [record.get("wireHex") for record in records] != raw_frames[:len(records)]:
            raise ValueError("Recorded wire frames differ from original MAVLink bytes")
        wire_frames_checked = len(records)
    bad = [message for message in messages if message.get_type() == "BAD_DATA"]
    if bad:
        raise ValueError("Malformed or CRC-invalid bytes in raw MAVLink stream")
    report = {"schemaVersion": 1, "status": "PASS", "pymavlink": version,
              "messages": len(messages), "recordedObservations": len(original),
              "filteredRawMessages": len(observed), "rawSha256": digest(raw),
              "wireFramesChecked": wire_frames_checked, "readBackParameters": sorted(read_back),
              "decodedSha256": digest(decoded),
              "generatorSha256": digest(Path(__file__).read_bytes())}
    (directory / "mavlink-audit.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"PASS: {len(original)} recorded observations match original CRC-checked MAVLink")


if __name__ == "__main__":
    main()
