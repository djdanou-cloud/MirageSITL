"""Generate independent MAVLink goldens and the codec's message table using the pinned official generator.

MIRAGE_MAVLINK_SOURCE=/path/to/mavlink MIRAGE_MAVGEN_OUTPUT=/path/to/output-prefix python3 scripts/generate-mavlink-fixtures.py

The source checkout (pinned commit, clean) and the generated Python module live outside the repository;
the defaults are /workspace/.cache/mirage-mavlink and /workspace/.cache/mirage-mavlink-ardupilotmega.
pymavlink 2.4.50 must be importable. No runtime downloads.

Writes packages/mavlink/dialect.lock.json, packages/mavlink/src/message-table.ts and
tests/fixtures/mavlink/golden.json. TASK-150: the table and the goldens come from ardupilotmega.xml,
which includes common.xml, so EKF_STATUS_REPORT (ArduPilot dialect) is generated like the rest.
"""
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = pathlib.Path(os.environ.get('MIRAGE_MAVLINK_SOURCE', '/workspace/.cache/mirage-mavlink'))
OUTPUT = os.environ.get('MIRAGE_MAVGEN_OUTPUT', '/workspace/.cache/mirage-mavlink-ardupilotmega')
COMMIT = '2e2b6af99084e4fde9bb304c84bb9253a1a98b6f'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip() == COMMIT
assert not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=SOURCE, text=True).strip()
import pymavlink
from pymavlink.generator import mavgen, mavparse
assert pymavlink.__version__ == '2.4.50'
DEFINITIONS = SOURCE / 'message_definitions/v1.0'
DIALECT = DEFINITIONS / 'ardupilotmega.xml'
assert mavgen.mavgen(mavgen.Opts(OUTPUT, wire_protocol='2.0', language='Python3'), [str(DIALECT)])
spec = importlib.util.spec_from_file_location('dialect', OUTPUT + '.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

# Messages the codec supports: the 12 before TASK-150 and the Phase 1 ground-station set.
SUPPORTED = [0, 1, 20, 21, 22, 23, 24, 27, 30, 32, 33, 36, 40, 41, 42, 43, 44, 45, 46, 47, 51, 70, 73, 74, 75, 76, 77,
             84, 85, 86, 87, 93, 105, 107, 113, 147, 193, 253]
# The preallocated high-rate telemetry decoders cover these.
HIGH_RATE = [1, 30, 32, 33, 36, 74, 147]

# Field layouts from the generator's own parser, over every file the dialect includes.
xml_files, pending = [], [DIALECT]
while pending:
    path = pending.pop(0)
    if path in xml_files:
        continue
    xml_files.append(path)
    parsed = mavparse.MAVXML(str(path), wire_protocol_version=mavparse.PROTOCOL_2_0)
    pending.extend(DEFINITIONS / name for name in parsed.include)
layouts = {}
for path in xml_files:
    for message in mavparse.MAVXML(str(path), wire_protocol_version=mavparse.PROTOCOL_2_0).message:
        if message.id in SUPPORTED:
            assert message.id not in layouts, message.id
            base = {f.name for f in message.fields[:message.base_fields()]}
            layouts[message.id] = {
                'id': message.id, 'name': message.name, 'crcExtra': message.crc_extra, 'length': message.wire_length,
                'fields': [{'name': f.name, 'type': f.type, 'offset': f.wire_offset, 'count': f.array_length,
                            'units': (f.units or '').strip('[]'), 'extension': f.name not in base} for f in message.ordered_fields],
            }
assert sorted(layouts) == SUPPORTED, sorted(set(SUPPORTED) - set(layouts))

link = m.MAVLink(None, srcSystem=42, srcComponent=7)
link.seq = 254
# The five frames before TASK-150, unchanged (common messages encode identically under ardupilotmega).
legacy = [
    m.MAVLink_hil_gps_message(0x12345678abcdef01, 3, 123456789, -1799999999, 123450, 120, 230, 500, 300, -400, 50, 12345, 14, 2, 36000),
    m.MAVLink_hil_sensor_message(0x12345678abcdef01, 1, 2, -9.80665, .1, .2, .3, .2, -.1, .4, 1013.25, 12, 123.45, 20, 8191, 2),
    m.MAVLink_hil_actuator_controls_message(0x12345678abcdef01, [i / 16 for i in range(16)], 128, 1),
    m.MAVLink_rc_channels_override_message(1, 1, 1000, 1500, 2000, 65535, 0, 1200, 1800, 1600, 65534, 65535, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700),
    m.MAVLink_hil_gps_message(0, 0, 0, 0, 0, 65535, 65535, 65535, 0, 0, 0, 65535, 255),
]
frames = []
for message in legacy:
    wire = bytes(message.pack(link))
    frames.append({'id': message.get_msgId(), 'hex': wire.hex(), 'payloadHex': wire[10:10 + wire[1]].hex()})
    link.seq = (link.seq + 1) % 256

SAFE = 2 ** 53 - 1


def pattern(kind, k):
    """A distinct value per field position, spanning signs and magnitudes, exact in its wire type."""
    if kind == 'uint8_t': return (37 * k + 3) % 256
    if kind == 'int8_t': return (37 * k + 3) % 256 - 128
    if kind == 'uint16_t': return (4099 * k + 7) % 65536
    if kind == 'int16_t': return (4099 * k + 7) % 65536 - 32768
    if kind == 'uint32_t': return (2654435761 * k + 11) % 2 ** 32
    if kind == 'int32_t': return (2654435761 * k + 11) % 2 ** 32 - 2 ** 31
    if kind == 'uint64_t': return (1234567890123 * k + 13) % SAFE
    if kind == 'int64_t': return (1234567890123 * k + 13) % SAFE - 2 ** 52
    if kind == 'float': return k * 1.375 - 17.5
    if kind == 'double': return k * 1.0000001 - 3.25
    raise ValueError(kind)


def values_for(layout, style):
    values = {}
    for k, f in enumerate(layout['fields'], start=1):
        if f['type'] == 'char':
            text = f"MIRAGE {layout['name'].lower()} {k}"[: f['count']]
            values[f['name']] = '' if style == 'minimal' else text
        elif f['count']:
            values[f['name']] = [0 if style == 'minimal' else pattern(f['type'], k * 7 + i) for i in range(f['count'])]
        else:
            values[f['name']] = 0 if style == 'minimal' else pattern(f['type'], k)
    if style == 'minimal':
        # Only the first wire field is set, so MAVLink2 truncates every trailing zero byte.
        first = layout['fields'][0]
        if first['type'] == 'char': values[first['name']] = 'M'
        elif first['count']: values[first['name']][0] = 1
        else: values[first['name']] = 1
    return values


message_frames = []
for message_id in SUPPORTED:
    layout = layouts[message_id]
    cls = getattr(m, f"MAVLink_{layout['name'].lower()}_message")
    for style in ['pattern', 'minimal']:
        values = values_for(layout, style)
        message = cls(**{name: (value.encode('ascii') if isinstance(value, str) else value) for name, value in values.items()})
        wire = bytes(message.pack(link))
        # pack() does not advance the sequence; the wire's byte 4 is the sequence it used.
        assert wire[4] == link.seq
        message_frames.append({'id': message_id, 'name': layout['name'], 'style': style, 'sequence': wire[4],
                               'values': values, 'hex': wire.hex()})
        link.seq = (link.seq + 1) % 256

table_lines = ['// Generated by scripts/generate-mavlink-fixtures.py from the pinned MAVLink definitions',
               '// (ardupilotmega.xml and its includes) with pymavlink 2.4.50. Do not edit by hand.',
               "import type { FieldType, MessageLayout } from './codec.ts';", '',
               'function field(name: string, type: FieldType, offset: number, count: number, units: string, extension: boolean) {',
               '  return Object.freeze({ name, type, offset, count, units, extension });', '}',
               'function message(id: number, name: string, crcExtra: number, length: number, fields: MessageLayout["fields"]): MessageLayout {',
               '  return Object.freeze({ id, name, crcExtra, length, fields: Object.freeze(fields) });', '}', '',
               '/** Every message the codec supports, by ascending ID. */',
               'export const MESSAGE_TABLE: readonly MessageLayout[] = Object.freeze([']
for message_id in SUPPORTED:
    layout = layouts[message_id]
    table_lines.append(f"  message({layout['id']}, {json.dumps(layout['name'])}, {layout['crcExtra']}, {layout['length']}, [")
    for f in layout['fields']:
        table_lines.append(f"    field({json.dumps(f['name'])}, {json.dumps(f['type'])}, {f['offset']}, {f['count']}, {json.dumps(f['units'])}, {'true' if f['extension'] else 'false'}),")
    table_lines.append('  ]),')
table_lines.append(']);')
table_lines.append(f'/** The high-rate telemetry messages with preallocated decoders (TASK-150). */')
table_lines.append(f'export const HIGH_RATE_MESSAGES: readonly number[] = Object.freeze({json.dumps(HIGH_RATE)});')
(ROOT / 'packages/mavlink/src/message-table.ts').write_text('\n'.join(table_lines) + '\n')

files = {str(p.relative_to(SOURCE)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(xml_files) + [SOURCE / 'COPYING']}
generator_files = {name: hashlib.sha256((pathlib.Path(pymavlink.__file__).parent / 'generator' / name).read_bytes()).hexdigest()
                   for name in ['mavgen.py', 'mavgen_python.py', 'mavparse.py', 'mavschema.xsd']}
lock = {'generatorFilesSha256': generator_files, 'schemaVersion': 2, 'repository': 'https://github.com/mavlink/mavlink.git', 'commit': COMMIT,
        'generator': 'pymavlink', 'generatorVersion': pymavlink.__version__, 'wireVersion': 2, 'dialect': 'message_definitions/v1.0/ardupilotmega.xml',
        'filesSha256': files, 'messages': SUPPORTED, 'highRateMessages': HIGH_RATE, 'signing': 'unsupported-reject-signed'}
(ROOT / 'packages/mavlink/dialect.lock.json').write_text(json.dumps(lock, indent=2) + '\n')
(ROOT / 'tests/fixtures/mavlink/golden.json').write_text(json.dumps({
    'schemaVersion': 2, 'provenance': 'Official pymavlink 2.4.50 generator with pinned ardupilotmega XML and its includes; no simulator-derived goldens.',
    'sourceCommit': COMMIT, 'systemId': 42, 'componentId': 7, 'frames': frames, 'messageFrames': message_frames}, indent=2) + '\n')
