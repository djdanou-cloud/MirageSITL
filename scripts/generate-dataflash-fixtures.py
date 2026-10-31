"""Regenerate the TASK-178 DataFlash reference fixture from a real SITL log.

python -I scripts/generate-dataflash-fixtures.py --log SOURCE.BIN --source ARDUPILOT_CHECKOUT [--check]

Requires pymavlink 2.4.50. SOURCE.BIN is a DataFlash log written by the pinned
native ArduCopter SITL (TASK-127/128 captures keep one in dataflash/). The
reference log keeps, verbatim and in order, every FMT, UNIT, MULT and FMTU
record, the first four records of every other type, and the first GPS record
with a valid week, so it stays small and self-describing. pymavlink's DFReader
decodes it (values, units, timestamps with a zero and a GPS time base); four
damaged copies have bytes changed at offsets chosen here, which are the
expected damaged ranges. --check compares without writing.
"""
import argparse
import base64
import hashlib
import json
import math
import pathlib
import re
import struct
import subprocess
import sys
import tempfile

import pymavlink
from pymavlink import DFReader

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'tests/fixtures/dataflash/reference.json'
COMMIT = '8ab6afde107a91df1b5f60ade8f333cb8a61b190'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--log', type=pathlib.Path, required=True)
parser.add_argument('--source', type=pathlib.Path, required=True)
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
assert pymavlink.__version__ == '2.4.50'
source = args.source.resolve()
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip() == COMMIT

raw = args.log.read_bytes()
FMT_STRUCT = struct.Struct('<BB4s16s64s')
SIZES = {c: struct.calcsize('<' + DFReader.FORMAT_TO_STRUCT[c][0]) for c in DFReader.FORMAT_TO_STRUCT}


def records(data):
    """Record boundaries of an undamaged log: (offset, type, length, name), and the formats."""
    formats = {0x80: (89, 'FMT', 'BBnNZ', ['Type', 'Length', 'Name', 'Format', 'Columns'])}
    offset, out = 0, []
    while offset + 3 <= len(data):
        assert data[offset] == 0xA3 and data[offset + 1] == 0x95, offset
        kind = data[offset + 2]
        length, name = formats[kind][:2]
        if offset + length > len(data):
            break
        if kind == 0x80:
            ftype, flen, fname, fformat, fcolumns = FMT_STRUCT.unpack(data[offset + 3:offset + 89])
            fformat = fformat.split(b'\0')[0].decode()
            assert flen == 3 + sum(SIZES[c] for c in fformat), fname
            formats[ftype] = (flen, fname.split(b'\0')[0].decode(), fformat, fcolumns.split(b'\0')[0].decode().split(','))
        out.append((offset, kind, length, name))
        offset += length
    return out, formats


def field(data, offset, fmt, name):
    """One raw field of a record, unpacked with the format's own layout."""
    _, _, fformat, columns = fmt
    values = struct.unpack('<' + ''.join(DFReader.FORMAT_TO_STRUCT[c][0] for c in fformat), data[offset + 3:offset + fmt[0]])
    return values[columns.index(name)]


every, formats = records(raw)
kept, seen, gps_week = [], {}, False
for offset, kind, length, name in every:
    keep = name in ('FMT', 'UNIT', 'MULT', 'FMTU') or seen.get(name, 0) < 4
    if name == 'GPS' and not gps_week and field(raw, offset, formats[kind], 'GWk') > 0:
        gps_week = keep = True
    if keep:
        kept.append(raw[offset:offset + length])
        seen[name] = seen.get(name, 0) + 1
assert gps_week, 'the log has no GPS record with a valid week'
reference = b''.join(kept)


def jsonable(value):
    if isinstance(value, float):
        if math.isnan(value):
            return 'NaN'
        if math.isinf(value):
            return 'Infinity' if value > 0 else '-Infinity'
        return value
    if isinstance(value, bytes):
        # pymavlink returns FILE's Z field as raw bytes.
        return {'base64': base64.b64encode(value).decode()}
    if isinstance(value, (list, tuple)) or type(value).__name__ == 'array':
        return [jsonable(v) for v in value]
    return value


def decode(data, zero_time_base=True):
    with tempfile.NamedTemporaryFile(suffix='.BIN') as f:
        f.write(data)
        f.flush()
        r = DFReader.DFReader_binary(f.name, zero_time_base=zero_time_base)
        timebase = r.clock.timebase if r.clock is not None else None
        out = []
        while True:
            m = r.recv_msg()
            if m is None:
                break
            try:
                values = {c: jsonable(getattr(m, c)) for c in m._fieldnames}
            except TypeError:
                raise SystemExit('message %s has a raw bytes field' % m.get_type())
            out.append({'type': m.get_type(), 'timestampS': m._timestamp, 'values': values})
        units = {}
        for fmt in r.formats.values():
            if fmt.units is not None:
                units[fmt.name] = {c: fmt.get_unit(c) for c in fmt.columns}
        return out, units, timebase


messages, units, _ = decode(reference)
_, _, gps_timebase = decode(reference, zero_time_base=False)
bounds, defined = records(reference)
# Damage: (description, bytes, expected [start, end) ranges and reasons).
damaged = []
k = len(bounds) // 2
start, _, length, _ = bounds[k]
flip = bytearray(reference)
flip[start] ^= 0xFF
damaged.append({'id': 'bad-header', 'ranges': [[start, start + length, 'bad-header']], 'bytes': bytes(flip)})
unknown = bytearray(reference)
unused = next(t for t in range(1, 256) if t not in defined)
start2, _, length2, _ = bounds[k + 1]
unknown[start2 + 2] = unused
damaged.append({'id': 'unknown-type', 'ranges': [[start2, start2 + length2, 'unknown-type']], 'bytes': bytes(unknown)})
start3 = bounds[k + 2][0]
inserted = reference[:start3] + b'\x00\x11\x22\x33\x44\x55\x66' + reference[start3:]
damaged.append({'id': 'garbage', 'ranges': [[start3, start3 + 7, 'bad-header']], 'bytes': inserted})
last, _, last_length, _ = bounds[-1]
truncated = reference[:last + last_length // 2]
damaged.append({'id': 'truncated', 'ranges': [[last, last + last_length // 2, 'truncated']], 'bytes': truncated})
for case in damaged:
    decoded, _, _ = decode(case['bytes'])
    case['pymavlinkMessages'] = len(decoded)
    case['base64'] = base64.b64encode(case.pop('bytes')).decode()

# Every log message name the pinned ArduPilot source defines, so MirageSITL names never collide.
names = set()
pattern = re.compile(r'"([A-Z][A-Z0-9]{2,3})"\s*,\s*"[a-zA-Z#]*"\s*,\s*"[A-Za-z0-9_,]+"')
for path in list(source.glob('libraries/**/*.h')) + list(source.glob('libraries/**/*.cpp')) + list(source.glob('ArduCopter/*.cpp')):
    names.update(pattern.findall(path.read_text(errors='ignore')))
names.update(n for _, _, _, n in every)

document = {
    'schemaVersion': 1,
    'provenance': 'Records copied verbatim from a DataFlash log of the pinned native ArduCopter SITL '
                  '(commit %s, synthetic aircraft); decoded by pymavlink %s DFReader. Protocol oracle, not a measurement.' % (COMMIT, pymavlink.__version__),
    'sourceLogSha256': hashlib.sha256(raw).hexdigest(),
    'selection': 'Every FMT, UNIT, MULT and FMTU record; the first four records of every other type; GPS records until the first with GWk > 0',
    'referenceSha256': hashlib.sha256(reference).hexdigest(),
    'referenceBase64': base64.b64encode(reference).decode(),
    'gpsTimeBaseS': gps_timebase,
    'units': units,
    'messages': messages,
    'damaged': damaged,
    'ardupilotLogNames': sorted(names),
}
text = json.dumps(document, indent=1, sort_keys=True) + '\n'
if args.check:
    if OUTPUT.read_text() != text:
        sys.exit('reference.json differs from the regenerated fixture')
else:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(text)
print('%d records kept of %d, %d bytes, %d messages, %d damaged copies, %d ArduPilot names; check=%s'
      % (len(bounds), len(every), len(reference), len(messages), len(damaged), len(names), args.check))
