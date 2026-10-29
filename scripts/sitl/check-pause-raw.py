"""TASK-129 independent pymavlink CRC, observation, clock and outgoing traffic audit."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
from pymavlink.dialects.v20 import ardupilotmega
from pymavlink import DFReader


def sha(data):
    return hashlib.sha256(data).hexdigest()


def decode(data):
    parser = ardupilotmega.MAVLink(None)
    parser.robust_parsing = True
    result = parser.parse_buffer(data) or []
    if any(message.get_type() == "BAD_DATA" for message in result):
        raise ValueError("Malformed or CRC-invalid MAVLink bytes")
    return result


def main():
    if len(sys.argv) != 3 or sys.argv[1] != "--input":
        raise ValueError("Expected --input CAPTURE_DIRECTORY")
    directory = Path(sys.argv[2])
    if importlib.metadata.version("pymavlink") != "2.4.50":
        raise ValueError("Requires pymavlink 2.4.50")

    def read(name):
        path = directory / name
        if path.stat().st_size > 64 * 1024 * 1024:
            raise ValueError("Input exceeds 64 MiB")
        return path.read_bytes()

    run = json.loads(read("run.json"))
    if run["task"] != "TASK-129" or run["status"] != "captured":
        raise ValueError("Not a completed pause capture")
    incoming, outgoing = read("mavlink.raw"), read("tx.raw")
    messages, tx = decode(incoming), decode(outgoing)
    wanted = {"HEARTBEAT", "EKF_STATUS_REPORT", "GLOBAL_POSITION_INT", "LOCAL_POSITION_NED",
              "STATUSTEXT", "COMMAND_ACK", "EXTENDED_SYS_STATE", "HIGHRES_IMU", "RAW_IMU",
              "GPS_RAW_INT", "SYSTEM_TIME", "RC_CHANNELS"}
    names = set(run["frameExpectedParameters"])
    selected = [m for m in messages if m.get_srcSystem() == 1 and m.get_srcComponent() == 1
                and (m.get_type() in wanted or m.get_type() == "PARAM_VALUE" and m.param_id in names)]
    events = [json.loads(line) for line in read("telemetry.ndjson").splitlines()]
    if not events or [m.to_dict() for m in selected[:len(events)]] != [r["message"] for r in events]:
        raise ValueError("Telemetry differs from original CRC-checked stream")
    if [m.get_msgbuf().hex() for m in selected[:len(events)]] != [r["wireHex"] for r in events]:
        raise ValueError("Telemetry wire identity differs")
    tx_events = [json.loads(line) for line in read("tx.ndjson").splitlines()]
    if b"".join(bytes.fromhex(r["hex"]) for r in tx_events) != outgoing:
        raise ValueError("Outgoing wall log differs from original bytes")
    # Each write must be exactly one independently parsed frame; no silent partial traffic.
    typed_tx = []
    for event in tx_events:
        decoded = decode(bytes.fromhex(event["hex"]))
        if len(decoded) != 1:
            raise ValueError("Outgoing write is not exactly one MAVLink frame")
        typed_tx.append({"wallMonotonicS": event["wallMonotonicS"], "message": decoded[0].to_dict()})
    sets = [m for m in tx if m.get_type() == "PARAM_SET"]
    commands = [c for c in run["commands"] if c["kind"] == "set-parameter"]
    if len(sets) != len(commands):
        raise ValueError("Parameter write count differs")
    for message, command in zip(sets, commands):
        if (message.target_system, message.target_component, message.param_id,
            message.param_value, message.param_type) != (1, 1, command["name"], command["value"], 9):
            raise ValueError("Parameter write differs from original wire")
    values = {m.param_id: m.param_value for m in selected if m.get_type() == "PARAM_VALUE"}
    for name, value in run["frameExpectedParameters"].items():
        if values.get(name) != value or run["parameterValues"].get(name) != value:
            raise ValueError("Parameter missing final read-back: " + name)
    if not any(m.get_type() == "SYSTEM_TIME" for m in selected):
        raise ValueError("Missing autopilot clock observations")
    dataflash = []
    navigation = []
    reset_events = []
    errors = []
    for path in sorted((directory / "dataflash").glob("*.BIN")):
        if path.stat().st_size > 64 * 1024 * 1024:
            raise ValueError("DataFlash exceeds budget")
        dataflash.append({"file": str(path.relative_to(directory)), "sha256": sha(path.read_bytes())})
        reader = DFReader.DFReader_binary(str(path))
        while True:
            message = reader.recv_match()
            if message is None:
                break
            kind = message.get_type()
            if kind == "XKF4" and message.C == 0:
                navigation.append(message.to_dict())
            if kind == "EV" and message.Id in (60, 62):
                reset_events.append(message.to_dict())
            if kind == "ERR":
                errors.append(message.to_dict())
    if not dataflash or not navigation:
        raise ValueError("Missing original DataFlash EKF diagnostics")
    windows = []
    for pause in run["pauses"]:
        low, high = pause["timeS"] - 0.25, pause["timeS"] + 1
        samples = [r for r in navigation if low <= r["TimeUS"] / 1e6 <= high]
        # XKF4 is logged at 10 Hz. Keep the sample from the interval that contains the hold,
        # and every sample through one simulated second after it. An offset change older than
        # that interval finished before the hold and is not a resume reset.
        boundary = [r for r in samples if r["TimeUS"] / 1e6 >= pause["timeS"] - 0.1]
        bad_resets = [r for r in reset_events if low <= r["TimeUS"] / 1e6 <= high]
        bad_errors = [r for r in errors if low <= r["TimeUS"] / 1e6 <= high]
        if len(samples) < 5 or len(boundary) < 5 or not any(r["TimeUS"] / 1e6 >= pause["timeS"] for r in boundary) or bad_resets or bad_errors:
            raise ValueError("Pause window lacks healthy reset/error-free DataFlash evidence")
        if any(r["FS"] != 0 for r in samples) or len({r["PI"] for r in samples}) != 1:
            raise ValueError("EKF fault or primary-lane change at resume")
        if len({(r["OFN"], r["OFE"]) for r in boundary}) != 1:
            raise ValueError("Position reset offset changed at resume")
        windows.append({"kind": pause["kind"], "lowSimS": low, "highSimS": high,
                        "samples": len(samples), "resetEvents": len(bad_resets), "errors": len(bad_errors),
                        "primary": samples[0]["PI"], "faults": 0, "positionResetOffsetsUnchanged": True})
    report = {"schemaVersion": 1, "task": "TASK-129", "status": "PASS", "pymavlink": "2.4.50",
              "rawSha256": sha(incoming), "outboundSha256": sha(outgoing),
              "decodedSha256": sha(read("telemetry.ndjson")), "txEventsSha256": sha(read("tx.ndjson")),
              "validatorSha256": sha(Path(__file__).read_bytes()),
              "observations": len(events), "messages": len(messages), "outgoing": typed_tx,
              "dataflash": dataflash, "ekfWindows": windows}
    (directory / "mavlink-audit.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"PASS: {len(events)} original observations and {len(tx)} outgoing frames")


if __name__ == "__main__":
    main()
