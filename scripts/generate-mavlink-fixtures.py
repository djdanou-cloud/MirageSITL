"""Generate independent MAVLink goldens using the pinned official Python generator.

PYTHONPATH=/workspace/.cache/mirage-mavgen-2.4.50 python3 scripts/generate-mavlink-fixtures.py
Source checkout and generated module live outside the repository. No runtime downloads.
"""
import hashlib
import importlib.util
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = pathlib.Path('/workspace/.cache/mirage-mavlink')
COMMIT = '2e2b6af99084e4fde9bb304c84bb9253a1a98b6f'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip() == COMMIT
assert not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=SOURCE, text=True).strip()
import pymavlink
from pymavlink.generator import mavgen
assert pymavlink.__version__ == '2.4.50'
OUTPUT = '/workspace/.cache/mirage-mavlink-common'
assert mavgen.mavgen(mavgen.Opts(OUTPUT, wire_protocol='2.0', language='Python3'), [str(SOURCE/'message_definitions/v1.0/common.xml')])
spec = importlib.util.spec_from_file_location('dialect', OUTPUT+'.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
link = m.MAVLink(None, srcSystem=42, srcComponent=7)
link.seq = 254
messages = [
 m.MAVLink_hil_gps_message(0x12345678abcdef01,3,123456789,-1799999999,123450,120,230,500,300,-400,50,12345,14,2,36000),
 m.MAVLink_hil_sensor_message(0x12345678abcdef01,1,2,-9.80665,.1,.2,.3,.2,-.1,.4,1013.25,12,123.45,20,8191,2),
 m.MAVLink_hil_actuator_controls_message(0x12345678abcdef01,[i/16 for i in range(16)],128,1),
 m.MAVLink_rc_channels_override_message(1,1,1000,1500,2000,65535,0,1200,1800,1600,65534,65535,1000,1100,1200,1300,1400,1500,1600,1700),
 m.MAVLink_hil_gps_message(0,0,0,0,0,65535,65535,65535,0,0,0,65535,255),
]
frames=[]
for message in messages:
 wire=bytes(message.pack(link))
 frames.append({'id':message.get_msgId(),'hex':wire.hex(),'payloadHex':wire[10:10+wire[1]].hex()})
 link.seq=(link.seq+1)%256
files={str(p.relative_to(SOURCE)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [SOURCE/'message_definitions/v1.0/common.xml',SOURCE/'message_definitions/v1.0/standard.xml',SOURCE/'message_definitions/v1.0/minimal.xml',SOURCE/'COPYING']}
generator_files={name:hashlib.sha256((pathlib.Path(pymavlink.__file__).parent/'generator'/name).read_bytes()).hexdigest() for name in ['mavgen.py','mavgen_python.py','mavparse.py','mavschema.xsd']}
lock={'generatorFilesSha256':generator_files,'schemaVersion':1,'repository':'https://github.com/mavlink/mavlink.git','commit':COMMIT,'generator':'pymavlink','generatorVersion':pymavlink.__version__,'wireVersion':2,'filesSha256':files,'messages':[70,93,107,113],'signing':'unsupported-reject-signed'}
(ROOT/'packages/mavlink/dialect.lock.json').write_text(json.dumps(lock,indent=2)+'\n')
(ROOT/'tests/fixtures/mavlink/golden.json').write_text(json.dumps({'schemaVersion':1,'provenance':'Official pymavlink 2.4.50 generator with pinned common XML; no simulator-derived goldens.','sourceCommit':COMMIT,'frames':frames},indent=2)+'\n')
