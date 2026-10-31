"""TASK-128 independent catalog from a clean, locally pinned ArduPilot checkout.

Invoked through generate.py --frames-only --source PATH [--check]. Does not
rewrite the TASK-041 protocol or TASK-089 sensor/error-ownership catalogs.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    source = args.source.resolve()
    commit = '8ab6afde107a91df1b5f60ade8f333cb8a61b190'
    assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip() == commit
    assert not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=source, text=True).strip()
    paths = ['ArduCopter/version.h', 'libraries/AP_Motors/AP_Motors_Class.h', 'libraries/AP_Motors/AP_MotorsMatrix.h',
             'libraries/AP_Motors/AP_MotorsMatrix.cpp', 'libraries/AP_Scripting/AP_Scripting_config.h',
             'libraries/AP_Scripting/examples/MotorMatrix_dotriaconta_octaquad_x.lua',
             'libraries/AP_Scripting/generator/description/bindings.desc',
             'libraries/SRV_Channel/SRV_Channel.h', 'libraries/SRV_Channel/SRV_Channel_config.h',
             'libraries/SRV_Channel/SRV_Channels.cpp', 'libraries/AP_HAL/board/sitl.h',
             'libraries/SITL/SIM_JSON.h', 'libraries/SITL/SIM_JSON.cpp', 'ArduCopter/motor_test.cpp', 'libraries/AP_Arming/AP_Arming.cpp']
    texts = {path: (source / path).read_text() for path in paths}
    upstream = [{'path': path, 'sha256': hashlib.sha256((source / path).read_bytes()).hexdigest(),
                 'bytes': (source / path).stat().st_size} for path in paths]
    matrix = texts['libraries/AP_Motors/AP_MotorsMatrix.cpp']
    classes = texts['libraries/AP_Motors/AP_Motors_Class.h']
    srv = texts['libraries/SRV_Channel/SRV_Channel.h']
    yaw = {key: int(value) for key, value in re.findall(r'#define AP_MOTORS_MATRIX_YAW_FACTOR_(CW|CCW)\s+(-?\d+)', texts['libraries/AP_Motors/AP_MotorsMatrix.h'])}
    assert yaw == {'CW': -1, 'CCW': 1}
    assert '#define HAL_PROGRAM_SIZE_LIMIT_KB 4096' in texts['libraries/AP_HAL/board/sitl.h']
    assert '#define AP_SCRIPTING_ENABLED (HAL_PROGRAM_SIZE_LIMIT_KB > 1024)' in texts['libraries/AP_Scripting/AP_Scripting_config.h']
    assert '#define AP_MOTORS_MAX_NUM_MOTORS 32' in classes and '#define AP_MOTORS_MAX_NUM_MOTORS 12' in classes
    assert '#define NUM_SERVO_CHANNELS 32' in texts['libraries/SRV_Channel/SRV_Channel_config.h']
    assert 'if (SRV_Channels::have_32_channels())' in texts['libraries/SITL/SIM_JSON.cpp']
    assert 'AP_GROUPINFO_FLAGS("_32_ENABLE", 43' in texts['libraries/SRV_Channel/SRV_Channels.cpp']
    assert 'motor_enabled[i] && _test_order[i] == motor_seq' in matrix
    assert 'cosf(radians(roll_factor_in_degrees + 90))' in matrix
    assert 'normalise_rpy_factors();' in matrix
    bindings = texts['libraries/AP_Scripting/generator/description/bindings.desc']
    assert 'add_motor_raw' in bindings and 'MotorsMatrix' in bindings
    assert 'ARMING_CHECK -> ARMING_SKIPCHK' in texts['libraries/AP_Arming/AP_Arming.cpp']
    assert 'return (checks_to_skip & check_mask) == 0;' in texts['libraries/AP_Arming/AP_Arming.cpp']
    functions = {int(number): int(value) for number, value in re.findall(r'k_motor(\d+)\s*=\s*(\d+)', srv)}
    assert [functions[i] for i in [1, 8, 9, 12, 13, 16, 32]] == [33, 40, 82, 85, 160, 163, 179]
    frames = []
    for name, function, class_name in [('quad-x', 'quad', 'QUAD'), ('hexa-x', 'hexa', 'HEXA'),
                                       ('octo-x', 'octa', 'OCTA'), ('x8', 'octaquad', 'OCTAQUAD')]:
        body = matrix.split(f'bool AP_MotorsMatrix::setup_{function}_matrix(', 1)[1].split('\n#endif', 1)[0]
        case = body.split('case MOTOR_FRAME_TYPE_X:', 1)[1].split('break;', 1)[0]
        rows = re.findall(r'\{\s*(-?[\d.]+)f?,\s*AP_MOTORS_MATRIX_YAW_FACTOR_(CW|CCW),\s*(\d+)\s*\}', case)
        expected = {'quad-x': 4, 'hexa-x': 6, 'octo-x': 8, 'x8': 8}[name]
        assert len(rows) == expected, (name, rows)
        frame_class = int(re.search(r'MOTOR_FRAME_' + class_name + r'\s*=\s*(\d+)', classes)[1])
        motors = [{'motor': i + 1, 'output': i + 1, 'function': functions[i + 1],
                   'azimuthDeg': float(angle), 'spin': direction, 'yawFactor': yaw[direction], 'testOrder': int(order),
                   'heightM': 0.0} for i, (angle, direction, order) in enumerate(rows)]
        if name == 'x8':
            seen = set()
            for motor in motors:
                key = motor['azimuthDeg']
                motor['heightM'] = -0.03 if key not in seen else 0.03
                seen.add(key)
        frames.append({'id': name, 'frameClass': frame_class, 'frameType': 1,
                       'servoPacketChannels': 16, 'kind': 'stock', 'motorCount': len(motors), 'motors': motors,
                       'sourceFunction': f'AP_MotorsMatrix::setup_{function}_matrix / MOTOR_FRAME_TYPE_X'})
    # A declared synthetic 8-arm, 2-motor configuration, using stock Lua bindings.
    # Geometry is an input, not a claim that this custom layout is a built-in frame.
    frame_class = int(re.search(r'MOTOR_FRAME_SCRIPTING_MATRIX\s*=\s*(\d+)', classes)[1])
    assert frame_class == 15
    motors = []
    for level in range(2):
        for arm in range(8):
            number = level * 8 + arm + 1
            motors.append({'motor': number, 'output': number, 'function': functions[number],
                           'azimuthDeg': 22.5 + arm * 45, 'spin': 'CCW' if (arm + level) % 2 == 0 else 'CW', 'yawFactor': (-1) ** (arm + level),
                           'testOrder': number, 'heightM': -0.03 if level == 0 else 0.03})
    frames.append({'id': 'paired-16', 'frameClass': frame_class, 'frameType': 1,
                   'servoPacketChannels': 32, 'kind': 'stock-scripting', 'motorCount': 16,
                   'motors': motors, 'sourceFunction': 'MotorsMatrix:add_motor_raw / MotorsMatrix:init(16)',
                   'geometryProvenance': 'Synthetic eight-arm coaxial pairs, not an upstream built-in frame or a calibrated wake model'})
    for frame in frames:
        frame['positionProvenance'] = 'Synthetic 0.2 m arm radius; X8/paired heights +/-0.03 m are harness inputs, not upstream measured geometry'
        for motor in frame['motors']:
            angle = math.radians(motor['azimuthDeg'])
            motor['positionFrdM'] = [0.2 * math.cos(angle), 0.2 * math.sin(angle), motor['heightM']]
        raw_roll = [-math.sin(math.radians(m['azimuthDeg'])) for m in frame['motors']]
        raw_pitch = [math.cos(math.radians(m['azimuthDeg'])) for m in frame['motors']]
        for i, motor in enumerate(frame['motors']):
            motor['rollFactor'] = 0.5 * raw_roll[i] / max(abs(v) for v in raw_roll)
            motor['pitchFactor'] = 0.5 * raw_pitch[i] / max(abs(v) for v in raw_pitch)
            motor['normalizedYawFactor'] = 0.5 * motor['yawFactor']
    packets = []
    for channels, magic in [(16, 18458), (32, 29569)]:
        values = [1000 + 17 * i for i in range(channels)]
        packets.append({'channels': channels, 'magic': magic, 'pwmUs': values,
                        'hex': struct.pack('<HHI' + str(channels) + 'H', magic, 800, 0x12345678, *values).hex()})
    version = re.search(r'#define THISFIRMWARE "([^"]+)"', texts['ArduCopter/version.h'])[1]
    assert version == 'ArduCopter V4.8.0-dev'
    result = {'schemaVersion': 1, 'ardupilotCommit': commit, 'firmwareVersion': version, 'upstream': upstream,
              'description': 'TASK-128 Phase 1 frame subset; source-derived static X tables and declared synthetic stock-Lua paired-16 geometry',
              'limits': {'sitlProgramSizeLimitKb': 4096, 'scriptingMotorCapacity': 32,
                         'withoutScriptingMotorCapacity': 12, 'sitlServoCapacity': 32,
                         'phase1MaximumMotors': 16, 'servo32EnableParameter': 'SERVO_32_ENABLE',
                         'scriptingEnableParameter': 'SCR_ENABLE', 'allArmingChecksParameter': 'ARMING_SKIPCHK', 'allArmingChecksValue': 0},
              'motorFunctions': [{'motor': i, 'function': functions[i]} for i in range(1, 33)],
              'frames': frames, 'servoPackets': packets}
    destination = Path(__file__).with_name('frames.json')
    encoded = json.dumps(result, indent=2) + '\n'
    if args.check:
        assert destination.read_text() == encoded, 'Stale frame catalog'
    else:
        destination.write_text(encoded)
    print(f'{len(frames)} frame configurations, {sum(f["motorCount"] for f in frames)} motors; check={args.check}')


if __name__ == '__main__':
    main()
