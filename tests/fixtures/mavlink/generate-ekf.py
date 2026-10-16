"""Generate independent EKF/heartbeat goldens from pinned upstream XML and pymavlink 2.4.50.

PYTHONPATH=/workspace/.cache/mirage-mavgen-2.4.50 python tests/fixtures/mavlink/generate-ekf.py
Generated Python stays outside the repository. No network access is required.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET
import pymavlink
from pymavlink.generator import mavgen
SOURCE = Path('/workspace/.cache/mirage-mavlink')
COMMIT = '2e2b6af99084e4fde9bb304c84bb9253a1a98b6f'
assert pymavlink.__version__ == '2.4.50'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip() == COMMIT
assert not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=SOURCE, text=True).strip()
files = {}
def include(path):
    name = str(path.relative_to(SOURCE))
    if name in files:
        return
    files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    for child in ET.parse(path).getroot().findall('include'):
        include(path.parent / child.text)
include(SOURCE/'message_definitions/v1.0/ardupilotmega.xml')
output = '/workspace/.cache/mirage-ekf-dialect'
assert mavgen.mavgen(mavgen.Opts(output, wire_protocol='2.0', language='Python3'), [str(SOURCE/'message_definitions/v1.0/ardupilotmega.xml')])
spec = importlib.util.spec_from_file_location('ekf_dialect', output+'.py')
dialect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dialect)
mav = dialect.MAVLink(None, srcSystem=1, srcComponent=1)
mav.seq = 17
messages = [dialect.MAVLink_heartbeat_message(2, 3, 0, 5, 4, 3),
            dialect.MAVLink_ekf_status_report_message(55, .2, .3, .4, .5, .6, .7)]
result = {'generator': 'pymavlink 2.4.50 ardupilotmega v20', 'sourceCommit': COMMIT, 'filesSha256': files,
          'generatorSha256': hashlib.sha256(Path(output+'.py').read_bytes()).hexdigest(),
          'frames': [{'id': m.id, 'hex': m.pack(mav).hex()} for m in messages]}
Path(__file__).with_name('ekf-golden.json').write_text(json.dumps(result, indent=2) + '\n')
