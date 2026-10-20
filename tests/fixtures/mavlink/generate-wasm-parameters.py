"""Independent synthetic wire oracle for the local WASM storage diagnostic."""
import hashlib
import importlib.metadata
import inspect
import json
from pathlib import Path
from pymavlink.dialects.v20 import ardupilotmega as dialect

assert importlib.metadata.version("pymavlink") == "2.4.50"
outgoing = dialect.MAVLink(None, srcSystem=255, srcComponent=190)
incoming = dialect.MAVLink(None, srcSystem=1, srcComponent=1)
messages = [
    (outgoing, dialect.MAVLink_param_request_read_message(1, 1, b"WP_SPD", -1)),
    (outgoing, dialect.MAVLink_param_set_message(1, 1, b"WP_SPD", 8.125, 9)),
    (incoming, dialect.MAVLink_param_value_message(b"WP_SPD", 8.125, 9, 1410, 42)),
]
result = {"generator": "pymavlink 2.4.50 ardupilotmega v20", "kind": "synthetic-wire-oracle",
          "generatorScriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          "generatedModuleSha256": hashlib.sha256(Path(inspect.getfile(dialect)).read_bytes()).hexdigest(),
          "frames": []}
for codec, message in messages:
    codec.seq = 10
    result["frames"].append({"id": message.get_msgId(), "crcExtra": message.crc_extra,
                             "length": message.unpacker.size, "hex": message.pack(codec).hex()})
Path(__file__).with_name("wasm-parameters.json").write_text(json.dumps(result, indent=2) + "\n")
