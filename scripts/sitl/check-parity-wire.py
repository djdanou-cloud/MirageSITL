"""Independently join TASK-047 scored diagnostics to original pymavlink bytes."""
import hashlib
import importlib.metadata
import json
import sys
from pathlib import Path
from pymavlink.dialects.v20 import ardupilotmega


def sha(data):
    return hashlib.sha256(data).hexdigest()


def audit(path):
    if importlib.metadata.version("pymavlink") != "2.4.50":
        raise ValueError("pymavlink 2.4.50 required")
    data = Path(path).read_bytes()
    if len(data) > 64 * 1024 * 1024:
        raise ValueError("Capture exceeds budget")
    envelope = json.loads(data)
    capture = envelope.get("capture", envelope)
    if capture.get("type", capture.get("status")) not in ("complete", "captured"):
        raise ValueError("Capture did not finish")
    chunks = capture["wireChunks"]
    if bytes(capture["raw"]) != b"".join(bytes(c["bytes"]) for c in chunks):
        raise ValueError("Raw bytes differ from timestamped chunks")
    parser = ardupilotmega.MAVLink(None)
    parser.robust_parsing = True
    heartbeat, ekf, status_text = [], [], []
    frames, previous, boot_bytes = 0, -1, 0
    for chunk in chunks:
        tick = chunk["tick"]
        if type(tick) is not int or tick < previous or tick > 96000:
            raise ValueError("Invalid wire receive tick")
        previous = tick
        for m in parser.parse_buffer(bytes(chunk["bytes"])) or []:
            if m.get_type() == "BAD_DATA":
                # UART0 contains the real firmware's ASCII startup banner before
                # its first MAVLink frame. Preserve it; reject later corruption.
                if tick < 48000 and m.reason == "Bad prefix" and all(b in (9, 10, 13) or 32 <= b <= 126 for b in m.data):
                    boot_bytes += len(m.data)
                    continue
                raise ValueError("Invalid original MAVLink bytes: " + str(m))
            if m.get_srcSystem() != 1 or m.get_srcComponent() != 1:
                continue
            frames += 1
            if m.get_type() == "HEARTBEAT":
                heartbeat.append((tick, m))
            if m.get_type() == "EKF_STATUS_REPORT":
                ekf.append((tick, m))
            if m.get_type() == "STATUSTEXT":
                status_text.append({"tick": tick, "text": m.text})
    scored = [p for p in capture["samples"] if 72000 <= p["tick"] <= 96000]
    if len(scored) != 3001 or any(p["tick"] != 72000 + i * 8 for i, p in enumerate(scored)):
        raise ValueError("Missing 100 Hz 30 s reference")
    for p in scored:
        hb_tick = p["tick"] - p["heartbeatAgeS"] * 800
        ekf_tick = p["tick"] - p["ekfAgeS"] * 800
        if not any(abs(t - hb_tick) <= 1.01 and m.custom_mode == p["mode"]
                   and bool(m.base_mode & 128) == p["armed"] for t, m in heartbeat):
            raise ValueError("Scored mode/arming lacks original heartbeat at tick " + str(p["tick"]))
        fields = ["velocity_variance", "pos_horiz_variance", "pos_vert_variance", "compass_variance", "terrain_alt_variance"]
        if not any(abs(t - ekf_tick) <= 1.01 and m.flags == p["ekfFlags"]
                   and [getattr(m, f) for f in fields] == p["innovationRatios"] for t, m in ekf):
            raise ValueError("Scored health lacks original EKF at tick " + str(p["tick"]))
    tx_parser = ardupilotmega.MAVLink(None)
    tx = []
    for event in capture["transmitted"]:
        for m in tx_parser.parse_buffer(bytes(event["bytes"])) or []:
            if m.get_srcSystem() != 255 or m.get_srcComponent() != 190:
                raise ValueError("Wrong controller identity")
            tx.append((event["tick"], m))
    commands = [(t, m.command) for t, m in tx if m.get_type() == "COMMAND_LONG" and m.command != 511]
    failsafe = envelope["caseId"] == "gcs-failsafe"
    expected = [(48000, 176), (50400, 400), (56000, 22)] + ([] if failsafe else [(72000, 21)])
    if commands != expected:
        raise ValueError("Transmitted scenario schedule differs")
    arm = next(m for _, m in tx if m.get_type() == "COMMAND_LONG" and m.command == 400)
    if arm.param1 != 1 or arm.param2 != 0:
        raise ValueError("Forced arming is not admissible")
    heartbeats_after_cut = [t for t, m in tx if m.get_type() == "HEARTBEAT" and t >= 72000]
    if failsafe == bool(heartbeats_after_cut):
        raise ValueError("GCS heartbeat cutoff differs")
    if failsafe and not any(72000 <= s["tick"] <= 80000 and "GCS" in s["text"] and "failsafe" in s["text"].lower() for s in status_text):
        raise ValueError("Missing original GCS failsafe status")
    return {"schemaVersion": 1, "kind": "autopilot-parity-wire", "status": "PASS",
            "captureSha256": sha(data), "rawSha256": sha(bytes(capture["raw"])),
            "auditorSha256": sha(Path(__file__).read_bytes()), "pymavlink": "2.4.50",
            "frames": frames, "bootBannerBytes": boot_bytes, "scoredSamples": len(scored), "scenarioCommands": commands,
            "statusText": status_text}


if __name__ == "__main__":
    if len(sys.argv) != 5 or sys.argv[1] != "--input" or sys.argv[3] != "--output":
        raise ValueError("Expected --input CAPTURE --output AUDIT")
    Path(sys.argv[4]).write_text(json.dumps(audit(sys.argv[2]), indent=2) + "\n", encoding="utf-8")
