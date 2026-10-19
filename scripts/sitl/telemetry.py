"""Pinned pymavlink I/O sidecar. Commands come from the owned Node driver."""
import json
import atexit
import select
import signal
import sys
import time
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
    atexit.register(connection.logfile_raw.close)
    signal.signal(signal.SIGTERM, terminate)
    last_send = 0
    configured = False
    while True:
        ready, _, _ = select.select([connection.fd, sys.stdin], [], [], 0.001)
        if sys.stdin in ready:
            line = sys.stdin.readline()
            if not line:
                return
            request = json.loads(line)
            kind = request["kind"]
            if kind == "mode":
                connection.mav.set_mode_send(1, 1, request["mode"])
            elif kind in ("arm", "takeoff", "land"):
                command = {"arm": 400, "takeoff": 22, "land": 21}[kind]
                params = [1, 0, 0, 0, 0, 0, 0] if kind == "arm" else [0, 0, 0, 0, 0, 0, 10 if kind == "takeoff" else 0]
                connection.mav.command_long_send(1, 1, command, 0, *params)
            else:
                raise ValueError("Unknown driver command")
        for _ in range(256):
            message = connection.recv_match(blocking=False)
            if message is None:
                break
            if message.get_srcSystem() != 1 or message.get_srcComponent() != 1:
                continue
            kind = message.get_type()
            if kind in ("HEARTBEAT", "EKF_STATUS_REPORT", "GLOBAL_POSITION_INT", "LOCAL_POSITION_NED", "STATUSTEXT", "COMMAND_ACK", "EXTENDED_SYS_STATE", "HIGHRES_IMU", "RAW_IMU", "GPS_RAW_INT"):
                emit({"message": message.to_dict(), "wireHex": message.get_msgbuf().hex()})
            if kind == "HEARTBEAT" and not configured:
                connection.mav.request_data_stream_send(1, 1, 0, 10, 1)
                for msgid in (0, 193, 33, 245):
                    connection.mav.command_long_send(1, 1, 511, 0, msgid, 200000, 0, 0, 0, 0, 0)
                # set_message_interval truncates microseconds to milliseconds;
                # 2500 us becomes 2 ms and is rejected by the 400 Hz loop cap.
                for msgid, interval in ((105, 3000), (24, 50000)):
                    connection.mav.command_long_send(1, 1, 511, 0, msgid, interval, 0, 0, 0, 0, 0)
                configured = True
        if time.monotonic() - last_send > 0.2:
            connection.mav.heartbeat_send(6, 8, 0, 0, 0)
            connection.mav.rc_channels_override_send(1, 1, 1500, 1500, 1000, 1500, 1500, 1500, 1500, 1500)
            last_send = time.monotonic()


def terminate(_signal, _frame):
    raise SystemExit(0)


if __name__ == "__main__":
    main()
