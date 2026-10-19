"""Independent pymavlink 2.4.50 sensor wire oracle, not flight measurements."""
import hashlib
import importlib.metadata
import inspect
import json
from pathlib import Path
from pymavlink.dialects.v20 import ardupilotmega as dialect

assert importlib.metadata.version("pymavlink") == "2.4.50"
mav = dialect.MAVLink(None, srcSystem=1, srcComponent=1)
mav.seq = 23
messages = [
    dialect.MAVLink_highres_imu_message(30000000, 0, 0, -9.80665, 0, 0, 0,
                                      0.2, 0, 0.4, 1013.25, 0, 0, 20, 63),
    dialect.MAVLink_gps_raw_int_message(30000000, 3, -353629380, 1491650850,
                                      584000, 100, 100, 0, 0, 12),
    dialect.MAVLink_raw_imu_message(30000000, 0, 0, -1000, 0, 0, 0, 200, 0, 400),
]
module = Path(inspect.getfile(dialect))
result = {"generator": "pymavlink 2.4.50 ardupilotmega v20", "kind": "synthetic-wire-oracle",
          "generatedModuleSha256": hashlib.sha256(module.read_bytes()).hexdigest(),
          "generatorScriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          "frames": [{"id": m.get_msgId(), "crcExtra": m.crc_extra,
                      "length": m.unpacker.size, "timeS": 30,
                      "hex": m.pack(mav).hex()} for m in messages]}
Path(__file__).with_name("warmup-sensors.json").write_text(json.dumps(result, indent=2) + "\n")
