"""Generate the DataFlash reader and writer oracle (TASK-178) with pymavlink 2.4.50's mavlogdump.

python3 scripts/generate-dataflash-fixtures.py            # with pymavlink 2.4.50 importable

Reads tests/fixtures/dataflash/sitl-copter.bin, the first 100,011 bytes (a record boundary) of the
ArduCopter V4.8.0-dev (8ab6afde) SITL log captured by the TASK-147 run without a sensor configuration.
MIRAGE_DATAFLASH_SOURCE=/path/to/00000001.BIN recreates the slice from that log (SHA-256 checked).

Writes tests/fixtures/dataflash/reference.json:
  * every record of the slice as mavlogdump --format json prints it (type, timestamp, field values);
  * the units of every message type, resolved here from the log's UNIT, MULT and FMTU records;
  * damaged copies of the slice made by recorded edits, with the records pymavlink loses and the
    byte ranges it skips;
  * a writer sample: fixed MirageSITL records written by packages/dataflash/src/writer.ts (Node),
    with its SHA-256 and pymavlink's reading of it.
Values that JSON cannot hold are strings: 64-bit integers in decimal, NaN and infinities by name,
and FILE.Data (raw bytes in pymavlink) in hex. No runtime downloads.
"""
import hashlib
import json
import math
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

import pymavlink
from pymavlink import DFReader

assert pymavlink.__version__ == '2.4.50', pymavlink.__version__
ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / 'tests/fixtures/dataflash'
SLICE = FIXTURES / 'sitl-copter.bin'
SOURCE_SHA256 = 'e6961ff9069e0b3604ea0e5e7652ae689adc89869b90e073c66556175adbef97'
SOURCE_BYTES = 2076672
SLICE_BYTES = 100011
SLICE_SHA256 = None  # filled from the committed slice; recreating it from the source must reproduce it

source = os.environ.get('MIRAGE_DATAFLASH_SOURCE')
if source:
    data = pathlib.Path(source).read_bytes()
    assert len(data) == SOURCE_BYTES and hashlib.sha256(data).hexdigest() == SOURCE_SHA256, 'unexpected source log'
    if SLICE.exists():
        assert SLICE.read_bytes() == data[:SLICE_BYTES], 'committed slice differs from the source'
    FIXTURES.mkdir(parents=True, exist_ok=True)
    SLICE.write_bytes(data[:SLICE_BYTES])
clean = SLICE.read_bytes()
assert len(clean) == SLICE_BYTES

MAVLOGDUMP = os.environ.get('MIRAGE_MAVLOGDUMP') or shutil.which('mavlogdump.py') or str(pathlib.Path(sys.executable).parent / 'mavlogdump.py')
SKIP = re.compile(r'Skipped (\d+) bad bytes in log at offset (\d+)')


def dump(path):
    """mavlogdump --format json, plus the skipped ranges it reports on stderr."""
    out = subprocess.run([sys.executable, MAVLOGDUMP, '--format', 'json', str(path)], capture_output=True, text=True, check=True)
    rows = [json.loads(line) for line in out.stdout.splitlines() if line.strip()]
    skips = [[int(offset), int(count)] for count, offset in SKIP.findall(out.stderr)]
    return rows, skips


def records(path):
    """The record list pymavlink parses sequentially: (offset, end, type, raw elements)."""
    reader = DFReader.DFReader_binary(str(path))
    result = []
    while True:
        start = reader.offset
        message = reader.recv_msg()
        if message is None:
            return result, reader
        result.append({'start': start, 'end': reader.offset, 'type': message.get_type(), 'message': message})


def special(value):
    if isinstance(value, float) and not math.isfinite(value):
        return 'NaN' if math.isnan(value) else ('Infinity' if value > 0 else '-Infinity')
    return value


def encode(rows, parsed):
    """Columnar form of mavlogdump's rows; formats come from pymavlink's own parse of the same file."""
    assert len(rows) == len(parsed)
    names, order, groups = [], [], {}
    for row, record in zip(rows, parsed):
        name = row['meta']['type']
        assert name == record['type']
        fmt = record['message'].fmt
        if name not in groups:
            names.append(name)
            groups[name] = {'format': fmt.format, 'columns': list(row['data'].keys()), 'rows': []}
        group = groups[name]
        assert group['columns'] == list(row['data'].keys()) == fmt.columns and group['format'] == fmt.format
        order.append(names.index(name))
        values = [special(row['meta']['timestamp'])]
        for index, column in enumerate(group['columns']):
            value, char = row['data'][column], fmt.format[index]
            if char in 'qQ':
                value = str(value)
            elif name == 'FILE' and char == 'Z':
                raw = record['message']._elements[index]
                assert isinstance(raw, bytes) and value == raw.decode(errors='backslashreplace')
                value = raw.hex()
            elif char == 'a':
                value = list(value)
            else:
                value = special(value)
            values.append(value)
        group['rows'].append(values)
    return {'names': names, 'order': order, 'groups': groups}


def units(parsed):
    """Units resolved against the final UNIT and MULT tables (not pymavlink's read-time resolution)."""
    unit_table, mult_table, fmtu, formats = {}, {}, {}, {}
    for record in parsed:
        m = record['message']
        if record['type'] == 'FMT':
            formats[m.Name] = (m.Type, m.Format, m.Columns.split(','))
        elif record['type'] == 'UNIT':
            unit_table[chr(m.Id)] = m.Label
        elif record['type'] == 'MULT':
            mult_table[chr(m.Id)] = m.Mult
        elif record['type'] == 'FMTU':
            fmtu[m.FmtType] = (m.UnitIds, m.MultIds)
    result = {}
    for name, (type_id, fmt, columns) in sorted(formats.items()):
        if type_id not in fmtu:
            continue
        unit_ids, mult_ids = fmtu[type_id]
        entry = {}
        for index, column in enumerate(columns):
            unit_id = unit_ids[index] if index < len(unit_ids) else None
            mult_id = mult_ids[index] if index < len(mult_ids) else None
            multiplier = mult_table.get(mult_id) if mult_id is not None else None
            scaled = fmt[index] in 'cCeEL'
            entry[column] = {
                'unit': unit_table.get(unit_id, '') if unit_id is not None else '',
                'multiplier': multiplier,
                'valueScale': 1 if scaled or not multiplier else multiplier,
                'instance': unit_id == '#',
            }
        result[name] = entry
    return result


clean_rows, clean_skips = dump(SLICE)
clean_parsed, clean_reader = records(SLICE)
assert not clean_skips and clean_parsed[-1]['end'] == SLICE_BYTES
clean_encoded = encode(clean_rows, clean_parsed)
starts = [record['start'] for record in clean_parsed]
ends = [record['end'] for record in clean_parsed]
defined = set(clean_reader.formats)
unused_type = next(t for t in range(1, 128) if t not in defined)


def first_at(offset):
    return next(i for i, start in enumerate(starts) if start >= offset)


# Damaged copies: every edit is aligned to a record boundary after the first GPS fix,
# so pymavlink's clock is unchanged and the records it loses are exactly known.
garbage = bytes((17 * i + 5) % 160 for i in range(37))  # no 0xA3 byte
k_insert, k_type, k_zero = first_at(85000), first_at(90000), first_at(95000)
zero_end = starts[k_zero] + 300
k_zero_next = first_at(zero_end)
cut = starts[-1] + 5
cases = [
    {'name': 'inserted-garbage', 'edit': {'kind': 'insert', 'offset': starts[k_insert], 'hex': garbage.hex()},
     'removed': [k_insert, k_insert], 'ranges': [{'start': starts[k_insert], 'end': starts[k_insert] + 37, 'kind': 'skipped'}]},
    {'name': 'unknown-type', 'edit': {'kind': 'set', 'offset': starts[k_type] + 2, 'hex': bytes([unused_type]).hex()},
     'removed': [k_type, k_type + 1], 'ranges': [{'start': starts[k_type], 'end': ends[k_type], 'kind': 'skipped'}]},
    {'name': 'zeroed-block', 'edit': {'kind': 'zero', 'offset': starts[k_zero], 'length': 300},
     'removed': [k_zero, k_zero_next], 'ranges': [{'start': starts[k_zero], 'end': starts[k_zero_next], 'kind': 'skipped'}]},
    {'name': 'cut-tail', 'edit': {'kind': 'cut', 'length': cut},
     'removed': [len(starts) - 1, len(starts)], 'ranges': [{'start': starts[-1], 'end': cut, 'kind': 'truncated'}]},
]


def apply(data, edit):
    if edit['kind'] == 'insert':
        return data[:edit['offset']] + bytes.fromhex(edit['hex']) + data[edit['offset']:]
    if edit['kind'] == 'set':
        patch = bytes.fromhex(edit['hex'])
        return data[:edit['offset']] + patch + data[edit['offset'] + len(patch):]
    if edit['kind'] == 'zero':
        return data[:edit['offset']] + bytes(edit['length']) + data[edit['offset'] + edit['length']:]
    if edit['kind'] == 'cut':
        return data[:edit['length']]
    raise ValueError(edit)


with tempfile.TemporaryDirectory() as tmp:
    for case in cases:
        path = pathlib.Path(tmp) / (case['name'] + '.bin')
        path.write_bytes(apply(clean, case['edit']))
        rows, skips = dump(path)
        a, b = case['removed']
        expected = clean_rows[:a] + clean_rows[b:]
        # pymavlink loses exactly the removed records and keeps every other value and time.
        assert json.dumps(rows) == json.dumps(expected), case['name']
        case['pymavlinkSkipped'] = skips
        assert skips == [[r['start'], r['end'] - r['start']] for r in case['ranges'] if r['kind'] == 'skipped'], (case['name'], skips)

    # Writer sample from fixed inputs, each exactly representable in its wire type.
    writer_input = [
        {'kind': 'event', 'timeUs': 1000000, 'event': 'note', 'text': 'MirageSITL experiment start'},
        {'kind': 'truth', 'timeUs': 1002500, 'latitudeDeg': 47.3977419, 'longitudeDeg': 8.5455938, 'altitudeM': 488.25,
         'northM': 1.5, 'eastM': -2.25, 'downM': -10.125, 'northMps': 0.5, 'eastMps': -0.25, 'downMps': -1.75,
         'rollDeg': 2.5, 'pitchDeg': -1.25, 'yawDeg': 359.5, 'rollRateDegS': 10.5, 'pitchRateDegS': -3.75, 'yawRateDegS': 0.0625},
        {'kind': 'motor', 'timeUs': 1002500, 'motor': 0, 'command': 0.5, 'rpm': 7250.5, 'thrustN': 4.875, 'torqueNm': 0.0625,
         'currentA': 6.25, 'voltageV': 15.5},
        {'kind': 'motor', 'timeUs': 1002500, 'motor': 15, 'command': 0.4375, 'rpm': 6900.0, 'thrustN': 4.5, 'torqueNm': -0.0546875,
         'currentA': 5.75, 'voltageV': 15.5},
        {'kind': 'parameter', 'timeUs': 1100000, 'sequence': 1, 'name': 'ATC_RAT_RLL_P', 'requestedValue': 0.1875,
         'previousValue': 0.125, 'confirmedValue': None, 'status': 'requested'},
        {'kind': 'parameter', 'timeUs': 1150000, 'sequence': 1, 'name': 'ATC_RAT_RLL_P', 'requestedValue': 0.1875,
         'previousValue': 0.125, 'confirmedValue': 0.1875, 'status': 'confirmed'},
        {'kind': 'parameter', 'timeUs': 1200000, 'sequence': 2, 'name': 'MOT_SPIN_ARM', 'requestedValue': 0.75,
         'previousValue': None, 'confirmedValue': 0.1, 'status': 'rejected'},
        {'kind': 'event', 'timeUs': 1250000, 'event': 'fault', 'text': 'Motor 3 output fault injected'},
        {'kind': 'event', 'timeUs': 1300000, 'event': 'environment', 'text': 'Wind 5 m/s from 270 deg'},
        {'kind': 'truth', 'timeUs': 1302500, 'latitudeDeg': -33.8688197, 'longitudeDeg': -179.9999999, 'altitudeM': -12.5,
         'northM': 0.0, 'eastM': 0.0, 'downM': 0.0, 'northMps': 0.0, 'eastMps': 0.0, 'downMps': 0.0,
         'rollDeg': -180.0, 'pitchDeg': 90.0, 'yawDeg': 0.0, 'rollRateDegS': 0.0, 'pitchRateDegS': 0.0, 'yawRateDegS': 0.0},
        {'kind': 'event', 'timeUs': 1350000, 'event': 'command', 'text': 'Takeoff to 10 m'},
    ]
    # 0.1 is not exact in float32; the writer stores the float32 value, which is what the input records.
    writer_input[6]['confirmedValue'] = 0.10000000149011612
    inputs = pathlib.Path(tmp) / 'writer-input.json'
    sample = pathlib.Path(tmp) / 'writer-sample.bin'
    inputs.write_text(json.dumps(writer_input))
    program = ("import {readFileSync, writeFileSync} from 'node:fs';"
               "import {writeDataFlash} from './packages/dataflash/src/writer.ts';"
               "writeFileSync(process.argv[2], writeDataFlash(JSON.parse(readFileSync(process.argv[1], 'utf8'))));")
    subprocess.run(['node', '--experimental-transform-types', '--input-type=module', '-e', program, str(inputs), str(sample)],
                   cwd=ROOT, check=True)
    sample_bytes = sample.read_bytes()
    sample_rows, sample_skips = dump(sample)
    sample_parsed, _ = records(sample)
    assert not sample_skips
    sample_encoded = encode(sample_rows, sample_parsed)

# pymavlink's reading of the writer sample carries the inputs unchanged.
STATUS = {'requested': 0, 'confirmed': 1, 'rejected': 2}
EVENT = {'note': 0, 'environment': 1, 'fault': 2, 'command': 3}
mirage = [row for row in sample_rows if row['meta']['type'].startswith('MS')]
assert len(mirage) == len(writer_input)
for row, record in zip(mirage, writer_input):
    data = row['data']
    assert data['TimeUS'] == record['timeUs'] and row['meta']['timestamp'] == record['timeUs'] * 0.000001
    if record['kind'] == 'truth':
        expected = [record[k] for k in ['latitudeDeg', 'longitudeDeg', 'altitudeM', 'northM', 'eastM', 'downM', 'northMps', 'eastMps',
                                         'downMps', 'rollDeg', 'pitchDeg', 'yawDeg', 'rollRateDegS', 'pitchRateDegS', 'yawRateDegS']]
        assert row['meta']['type'] == 'MSTR' and list(data.values())[1:] == expected
    elif record['kind'] == 'motor':
        expected = [record[k] for k in ['motor', 'command', 'rpm', 'thrustN', 'torqueNm', 'currentA', 'voltageV']]
        assert row['meta']['type'] == 'MSMO' and list(data.values())[1:] == expected
    elif record['kind'] == 'event':
        assert row['meta']['type'] == 'MSEV' and data['Kind'] == EVENT[record['event']] and data['Text'] == record['text']
    else:
        def wire(value):
            return 'NaN' if value is None else value
        got = [special(data[k]) for k in ['Seq', 'Name', 'Req', 'Old', 'Act', 'Stat']]
        assert row['meta']['type'] == 'MSPC' and got == [record['sequence'], record['name'], record['requestedValue'],
                                                         wire(record['previousValue']), wire(record['confirmedValue']), STATUS[record['status']]]

reference = {
    'schemaVersion': 1,
    'provenance': ('pymavlink 2.4.50 mavlogdump.py --format json; the slice is the first 100,011 bytes of an ArduCopter V4.8.0-dev '
                   '(8ab6afde) SITL DataFlash log from the TASK-147 run without a sensor configuration; synthetic SITL data, not a measurement.'),
    'pymavlink': pymavlink.__version__,
    'source': {'sha256': SOURCE_SHA256, 'bytes': SOURCE_BYTES},
    'slice': {'file': SLICE.name, 'sha256': hashlib.sha256(clean).hexdigest(), 'bytes': len(clean), 'records': len(clean_rows)},
    'records': clean_encoded,
    'units': units(clean_parsed),
    'damaged': cases,
    'writer': {'input': writer_input, 'sha256': hashlib.sha256(sample_bytes).hexdigest(), 'bytes': len(sample_bytes),
               'records': sample_encoded, 'units': units(sample_parsed)},
}
text = json.dumps(reference, separators=(',', ':'), allow_nan=False)
(FIXTURES / 'reference.json').write_text(text + '\n')
print(f"{len(clean_rows)} records, {len(clean_encoded['names'])} types, {len(cases)} damaged cases, writer sample {len(sample_bytes)} bytes")
