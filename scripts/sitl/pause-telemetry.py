"""TASK-129 stock pymavlink sidecar; wall traffic continues during the physics hold."""
import json
import os
import atexit
import select
import signal
import sys
import time
from pathlib import Path
from pymavlink import mavutil


def emit(value):
    print(json.dumps(value, allow_nan=False), flush=True)


def main():
    port = int(sys.argv[1])
    connection = None
    for _ in range(100):
        try:
            connection = mavutil.mavlink_connection(
                f"tcp:127.0.0.1:{port}", source_system=255, source_component=190,
                dialect="ardupilotmega", retries=0)
            break
        except (OSError, ConnectionError):
            time.sleep(0.1)
    if connection is None:
        raise RuntimeError("Firmware MAVLink connection deadline exceeded")
    connection.logfile_raw = open(sys.argv[2], "wb")
    experiment = len(sys.argv) > 3 and sys.argv[3] == "--ew"
    frames = len(sys.argv) > 3 and sys.argv[3] == "--frames"
    if experiment or frames:
        # Capture exactly the outgoing wire bytes, independently audited later.
        transmitted = open(Path(sys.argv[2]).with_name("tx.raw"), "wb")
        tx_events = open(Path(sys.argv[2]).with_name("tx.ndjson"), "w")
        atexit.register(tx_events.close)
        atexit.register(transmitted.close)
        original_write = connection.write

        def write_wire(data):
            transmitted.write(data)
            tx_events.write(json.dumps({"wallMonotonicS": time.monotonic(), "hex": bytes(data).hex()}) + "\n")
            return original_write(data)

        # mavutil replaces its MAVLink encoder on the first v2 heartbeat;
        # instrument the connection, which survives that negotiated upgrade.
        connection.write = write_wire
    atexit.register(connection.logfile_raw.close)
    signal.signal(signal.SIGTERM, terminate)
    last_send = 0
    latest_sim_s = 0
    last_send_sim_s = -1
    configured = False
    # Parameter names the driver asked to read back; their PARAM_VALUE replies are forwarded.
    requested = set()
    command_buffer = ""
    while True:
        ready, _, _ = select.select([connection.fd, sys.stdin], [], [], 0.001)
        if sys.stdin in ready:
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk:
                return
            command_buffer += chunk.decode("utf-8")
        while "\n" in command_buffer:
            line, command_buffer = command_buffer.split("\n", 1)
            request = json.loads(line)
            kind = request["kind"]
            if kind == "mode":
                connection.mav.set_mode_send(1, 1, request["mode"])
            elif kind in ("arm", "takeoff", "land"):
                command = {"arm": 400, "takeoff": 22, "land": 21}[kind]
                params = [1, 0, 0, 0, 0, 0, 0] if kind == "arm" else [0, 0, 0, 0, 0, 0, 10 if kind == "takeoff" else 0]
                connection.mav.command_long_send(1, 1, command, 0, *params)
            elif kind == "set-parameter":
                requested.add(request["name"])
                connection.mav.param_set_send(1, 1, request["name"].encode(), request["value"], 9)
            elif frames and kind == "motor-test":
                connection.mav.command_long_send(1, 1, mavutil.mavlink.MAV_CMD_DO_MOTOR_TEST,
                                                 0, request["sequence"], 1, request["pwmUs"],
                                                 request["durationS"], 1, 0, 0)
            elif experiment and kind == "gps":
                g = request["gps"]
                connection.mav.gps_input_send(
                    request["timeUs"], 0, 0, request["weekMs"], 2300, g["fixType"],
                    round(g["latitudeRad"] * 180 / 3.141592653589793 * 1e7),
                    round(g["longitudeRad"] * 180 / 3.141592653589793 * 1e7),
                    g["altitudeMslM"], g["hdop"], g["vdop"], g["vnMps"], g["veMps"], g["vdMps"],
                    0.2, 0.5, 0.8, g["satellites"])
            elif experiment and kind == "compass":
                for compass in (1, 2, 3):
                    for axis, value in zip("XYZ", request["offsetsMilliGauss"]):
                        connection.mav.param_set_send(1, 1, f"SIM_MAG{compass}_OFS_{axis}".encode(), value, 9)
            elif experiment and kind == "parameters":
                connection.mav.param_request_list_send(1, 1)
            elif kind == "read-parameters":
                for name in request["names"]:
                    requested.add(name)
                    connection.mav.param_request_read_send(1, 1, name.encode(), -1)
            elif experiment and kind == "flush":
                emit({"flushed": True})
            else:
                raise ValueError("Unknown driver command")
        for _ in range(256):
            message = connection.recv_match(blocking=False)
            if message is None:
                break
            if message.get_srcSystem() != 1 or message.get_srcComponent() != 1:
                continue
            kind = message.get_type()
            if kind == "HIGHRES_IMU":
                latest_sim_s = max(latest_sim_s, message.time_usec / 1e6)
            if kind in ("HEARTBEAT", "EKF_STATUS_REPORT", "GLOBAL_POSITION_INT", "LOCAL_POSITION_NED", "STATUSTEXT", "COMMAND_ACK", "EXTENDED_SYS_STATE", "HIGHRES_IMU", "RAW_IMU", "GPS_RAW_INT", "SYSTEM_TIME", "RC_CHANNELS") or kind == "PARAM_VALUE" and (experiment or message.param_id in requested):
                emit({"message": message.to_dict(), "wireHex": message.get_msgbuf().hex()})
            if kind == "HEARTBEAT" and not configured:
                connection.mav.request_data_stream_send(1, 1, 0, 10, 1)
                for msgid in (0, 193, 33, 245, 2, 65):
                    connection.mav.command_long_send(1, 1, 511, 0, msgid, 200000, 0, 0, 0, 0, 0)
                # set_message_interval truncates microseconds to milliseconds;
                # 2500 us becomes 2 ms and is rejected by the 400 Hz loop cap.
                for msgid, interval in ((105, 3000), (24, 50000)):
                    connection.mav.command_long_send(1, 1, 511, 0, msgid, interval, 0, 0, 0, 0, 0)
                configured = True
        if time.monotonic() - last_send > 0.2 or latest_sim_s - last_send_sim_s > 0.2:
            connection.mav.heartbeat_send(6, 8, 0, 0, 0)
            connection.mav.rc_channels_override_send(1, 1, 1500, 1500, 1000, 1500, 1500, 1500, 1500, 1500)
            last_send = time.monotonic()
            last_send_sim_s = latest_sim_s


def terminate(_signal, _frame):
    raise SystemExit(0)


if __name__ == "__main__":
    main()
