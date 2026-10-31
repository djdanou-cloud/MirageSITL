"""Regenerate TASK-037/150 wire oracles and the pinned field catalog.

python scripts/generate-mavlink-fixtures.py --source /path/to/mavlink --work /tmp/mavgen
Requires pymavlink 2.4.50. Source and generated Python stay outside the repository.
--check compares every output without modifying it. No runtime downloads.
"""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import subprocess

import pymavlink
from pymavlink.generator import mavgen, mavparse

ROOT = pathlib.Path(__file__).resolve().parent.parent
COMMIT = '2e2b6af99084e4fde9bb304c84bb9253a1a98b6f'
IDS = [0, 1, 20, 21, 22, 23, 24, 27, 30, 32, 33, 36,
       37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 51,
       70, 73, 74, 75, 76, 77, 82, 83, 84, 85, 86, 87,
       93, 105, 107, 113, 147, 193, 253]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=pathlib.Path, required=True)
parser.add_argument('--work', type=pathlib.Path, required=True)
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
source = args.source.resolve()
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip() == COMMIT
assert not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=source, text=True).strip()
assert pymavlink.__version__ == '2.4.50'
args.work.mkdir(parents=True, exist_ok=True)
output = str(args.work.resolve() / 'ardupilotmega')
assert mavgen.mavgen(mavgen.Opts(output, wire_protocol='2.0', language='Python3'),
                     [str(source / 'message_definitions/v1.0/ardupilotmega.xml')])
spec = importlib.util.spec_from_file_location('dialect', output + '.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
xmls = {}
messages = {}

def visit(name):
    path = source / 'message_definitions/v1.0' / name
    if name in xmls:
        return
    xml = mavparse.MAVXML(str(path), wire_protocol_version='2.0')
    xmls[name] = path
    for message in xml.message:
        messages[message.id] = message
    for included in xml.include:
        visit(included)

visit('ardupilotmega.xml')
link = m.MAVLink(None, srcSystem=42, srcComponent=7)
link.seq = 254
# Preserve the five historical fixtures, including their ordering and exact bytes.
legacy = [
    m.MAVLink_hil_gps_message(0x12345678abcdef01, 3, 123456789, -1799999999, 123450, 120, 230, 500, 300, -400, 50, 12345, 14, 2, 36000),
    m.MAVLink_hil_sensor_message(0x12345678abcdef01, 1, 2, -9.80665, .1, .2, .3, .2, -.1, .4, 1013.25, 12, 123.45, 20, 8191, 2),
    m.MAVLink_hil_actuator_controls_message(0x12345678abcdef01, [i / 16 for i in range(16)], 128, 1),
    m.MAVLink_rc_channels_override_message(1, 1, 1000, 1500, 2000, 65535, 0, 1200, 1800, 1600, 65534, 65535, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700),
    m.MAVLink_hil_gps_message(0, 0, 0, 0, 0, 65535, 65535, 65535, 0, 0, 0, 65535, 255),
]
frames = []

def append(message, values=None, variant=None):
    wire = bytes(message.pack(link))
    frame = {'id': message.get_msgId(), 'hex': wire.hex(),
             'payloadHex': wire[10:10 + wire[1]].hex()}
    if values is not None:
        # JSON uses u64 as two exact unsigned words, not an imprecise JS number.
        frame.update(values=values, variant=variant)
    frames.append(frame)
    link.seq = (link.seq + 1) % 256

for message in legacy:
    append(message)

# Explicit named parameter-helper requests, independent of the runtime builders.
for message_id, kwargs in [
    (21, dict(target_system=1, target_component=0)),
    (20, dict(target_system=1, target_component=1, param_id=b'MOT_THST_EXPO', param_index=-1)),
    (23, dict(target_system=1, target_component=1, param_id=b'ABCDEFGHIJKLMNOP', param_value=12.5, param_type=9)),
]:
    values = {name: (list(value) + [0] * (16 - len(value)) if isinstance(value, bytes) else [value])
              for name, value in kwargs.items()}
    append(m.mavlink_map[message_id](**kwargs), values, 'parameter-builder')

catalog = []
for message_id in IDS:
    message = messages[message_id]
    fields = []
    for field in message.ordered_fields:
        fields.append({'name': field.name, 'type': field.type,
                       'offset': field.wire_offset, 'count': field.array_length or 1,
                       'units': field.units or '1'})
    catalog.append({'id': message_id, 'name': message.name, 'crcExtra': message.crc_extra,
                    'length': message.wire_length, 'minLength': message.wire_min_length,
                    'fields': fields})
    # Nonzero distinct values exercise every field, including extensions and arrays.
    # Also cover zero truncation and signed/unsigned limits independently.
    for variant in ['distinct', 'zero', 'limits']:
        kwargs, values = {}, {}
        for index, field in enumerate(message.fields):
            count = field.array_length or 1
            if field.type == 'char':
                text = (('ABCDEFGHIJKLMNOP' if field.name == 'param_id' else 'Status 123')
                        if variant == 'distinct' else ('Z' * count if variant == 'limits' else ''))[:count]
                kwargs[field.name] = text.encode('ascii')
                values[field.name] = list(text.encode('ascii')) + [0] * (count - len(text))
                continue
            entries = []
            for j in range(count):
                if variant == 'zero':
                    value = 0
                elif field.type in ['float', 'double']:
                    value = (-1 if index % 2 else 1) * (index + 1.25 + j / 8)
                elif field.type == 'uint8_t_mavlink_version':
                    value = 3
                else:
                    signed = field.type.startswith('int')
                    bits = field.type_length * 8
                    value = ((-(2 ** (bits - 1)) if signed else 2 ** bits - 1)
                             if variant == 'limits' else
                             (-((index + j + 1) % (2 ** (bits - 1))) if signed else ((index + j + 1) * 13) % (2 ** bits)))
                entries.append(value)
            kwargs[field.name] = entries if field.array_length else entries[0]
            if field.type in ['uint64_t', 'int64_t']:
                words = []
                for value in entries:
                    unsigned = value % (2 ** 64)
                    words.extend([unsigned & 0xffffffff, unsigned >> 32])
                values[field.name] = words
            else:
                values[field.name] = entries
        cls = m.mavlink_map[message_id]
        append(cls(**kwargs), values, variant)

files = {str(path.relative_to(source)): hashlib.sha256(path.read_bytes()).hexdigest()
         for path in sorted(xmls.values()) + [source / 'COPYING']}
generator_files = {name: hashlib.sha256((pathlib.Path(pymavlink.__file__).parent / 'generator' / name).read_bytes()).hexdigest()
                   for name in ['mavgen.py', 'mavgen_python.py', 'mavparse.py', 'mavschema.xsd']}
lock = {'generatorFilesSha256': generator_files, 'schemaVersion': 1,
        'repository': 'https://github.com/mavlink/mavlink.git', 'commit': COMMIT,
        'generator': 'pymavlink', 'generatorVersion': pymavlink.__version__, 'wireVersion': 2,
        'filesSha256': files, 'messages': IDS, 'definitions': catalog,
        'generatedModuleSha256': hashlib.sha256(pathlib.Path(output + '.py').read_bytes()).hexdigest(),
        'signing': 'unsupported-reject-signed'}
golden = {'schemaVersion': 1,
          'provenance': 'Official pymavlink 2.4.50 generator with pinned ardupilotmega XML; no simulator-derived goldens.',
          'sourceCommit': COMMIT, 'frames': frames}
outputs = {'packages/mavlink/dialect.lock.json': lock, 'tests/fixtures/mavlink/golden.json': golden}
for path, value in outputs.items():
    encoded = json.dumps(value, indent=2) + '\n'
    destination = ROOT / path
    if args.check:
        assert destination.read_text() == encoded, f'Stale generated output: {path}'
    else:
        destination.write_text(encoded)
print(f'{len(IDS)} messages, {len(frames)} independent frames; check={args.check}')
