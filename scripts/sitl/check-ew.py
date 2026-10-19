"""Independent pymavlink CRC/wire audit of native EW observations and parameters."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import struct
import sys
from pymavlink.dialects.v20 import ardupilotmega


def digest(data):
    return hashlib.sha256(data).hexdigest()


def f32(value):
    return struct.unpack("<f", struct.pack("<f", value))[0]


def decode(data):
    if len(data) > 64 * 1024 * 1024:
        raise ValueError("Wire capture exceeds budget")
    parser = ardupilotmega.MAVLink(None)
    parser.robust_parsing = True
    messages = parser.parse_buffer(data) or []
    if any(m.get_type() == "BAD_DATA" for m in messages):
        raise ValueError("Invalid CRC/wire bytes")
    return messages


def main():
    if len(sys.argv) != 3 or sys.argv[1] != "--input":
        raise ValueError("Expected --input CAPTURE_DIRECTORY")
    if importlib.metadata.version("pymavlink") != "2.4.50":
        raise ValueError("Expected pinned pymavlink 2.4.50")
    directory = Path(sys.argv[2])
    raw = (directory / "mavlink.raw").read_bytes()
    tx = (directory / "tx.raw").read_bytes()
    telemetry_bytes = (directory / "telemetry.ndjson").read_bytes()
    observations_bytes = (directory / "observations.ndjson").read_bytes()
    telemetry = [json.loads(line) for line in telemetry_bytes.splitlines()]
    observations = [json.loads(line) for line in observations_bytes.splitlines()]
    wanted = {"HEARTBEAT", "EKF_STATUS_REPORT", "GLOBAL_POSITION_INT", "LOCAL_POSITION_NED", "STATUSTEXT",
              "COMMAND_ACK", "EXTENDED_SYS_STATE", "HIGHRES_IMU", "RAW_IMU", "GPS_RAW_INT", "PARAM_VALUE"}
    received = [m for m in decode(raw) if m.get_type() in wanted and m.get_srcSystem() == 1 and m.get_srcComponent() == 1]
    if not telemetry or [r["message"] for r in telemetry] != [m.to_dict() for m in received[:len(telemetry)]]:
        raise ValueError("Telemetry differs from original CRC-checked bytes")
    if [r["wireHex"] for r in telemetry] != [m.get_msgbuf().hex() for m in received[:len(telemetry)]]:
        raise ValueError("Recorded wire frames differ from raw capture")
    outgoing = decode(tx)
    gps = [m for m in outgoing if m.get_type() == "GPS_INPUT"]
    if len(gps) != len(observations):
        raise ValueError(f"Missing transmitted GPS observations: wire={len(gps)} recorded={len(observations)} first={gps[0].time_usec if gps else None} last={gps[-1].time_usec if gps else None}")
    for m, observation in zip(gps, observations):
        c = observation["command"]
        g = c["gps"]
        if m.time_usec != c["timeUs"] or m.time_week_ms != c["weekMs"] or m.time_week != 2300 or m.gps_id != 0 or m.ignore_flags != 0:
            raise ValueError("GPS clock/receiver mismatch")
        if (m.lat, m.lon, m.fix_type, m.satellites_visible) != (
                round(g["latitudeRad"] * 180 / 3.141592653589793 * 1e7),
                round(g["longitudeRad"] * 180 / 3.141592653589793 * 1e7), g["fixType"], g["satellites"]):
            raise ValueError("GPS quantization/fix mismatch")
        for wire, key in (("alt", "altitudeMslM"), ("hdop", "hdop"), ("vdop", "vdop"), ("vn", "vnMps"), ("ve", "veMps"), ("vd", "vdMps")):
            if getattr(m, wire) != f32(g[key]):
                raise ValueError("GPS float32 field mismatch")
    # Parameter values are actual firmware readbacks, not a self-reported config.
    parameters = [r for r in telemetry if r["message"]["mavpackettype"] == "PARAM_VALUE"]
    fault_start = json.loads((directory / "run.json").read_bytes())["experiment"]["faultStart"]
    baseline_parameters = [r["message"] for r in parameters if r["receivedSimS"] < fault_start and r["message"]["param_index"] != 65535]
    if not baseline_parameters or len({m["param_index"] for m in baseline_parameters}) != max(m["param_count"] for m in baseline_parameters):
        raise ValueError("Incomplete pre-fault firmware parameter snapshot")
    for name, expected in {"GPS1_TYPE": 14, "GPS2_TYPE": 0, "GPS1_RATE_MS": 100,
                           "AHRS_EKF_TYPE": 3, "EK3_ENABLE": 1, "ARMING_SKIPCHK": 0}.items():
        matches = [r for r in parameters if r["message"]["param_id"] == name]
        if not matches or any(r["message"]["param_value"] != expected for r in matches):
            raise ValueError(f"Missing/mismatched actual parameter {name}")
    delivered = {(m.lat, m.lon, m.fix_type) for m in gps}
    readbacks = [r["message"] for r in telemetry if r["message"]["mavpackettype"] == "GPS_RAW_INT" and r["receivedSimS"] > 3]
    if not readbacks or any((m["lat"], m["lon"], m["fix_type"]) not in delivered for m in readbacks):
        raise ValueError("Firmware GPS readback differs from transmitted receiver observations")
    inputs = {name: digest((directory / name).read_bytes()) for name in
              ("mavlink.raw", "tx.raw", "telemetry.ndjson", "observations.ndjson")}
    report = {"schemaVersion": 1, "status": "PASS", "pymavlink": "2.4.50", "inputs": inputs,
              "telemetryFrames": len(telemetry), "gpsInputFrames": len(gps), "parameterFrames": len(parameters),
              "auditorSha256": digest(Path(__file__).read_bytes())}
    (directory / "ew-wire-audit.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"PASS: {len(telemetry)} RX frames and {len(gps)} GPS_INPUT TX frames")


if __name__ == "__main__":
    main()
