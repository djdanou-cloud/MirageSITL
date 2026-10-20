/** Cold capture provenance, shared by the Node capture host and native driver. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export function parityIdentity(root:string,defaultsText:string) {
  const sha=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex');
  const files=['packages/physics/src/bet-dynamics.ts','packages/physics/src/frame.ts','packages/physics/src/model-manifest.ts',
    'packages/wasm-bet/src/rotor.ts','packages/wasm-bet/src/backend.ts','packages/sensors/src/ideal.ts','packages/sensors/src/geodesy.ts',
    'packages/autopilot/src/wasm-sitl.ts','packages/autopilot/src/wasm-browser.ts','packages/autopilot/src/wasm-loader.ts',
    'packages/autopilot/src/wasm-storage.ts','packages/mavlink/src/codec.ts','native/ardupilot/hal/sitl-state.patch',
    'native/ardupilot/hal/browser_hal.cpp','native/ardupilot/hal/browser_hal.h','native/ardupilot/source.lock.json',
    'native/ardupilot/toolchain.lock.json','native/Cargo.lock','native/rust-toolchain.toml',
    'native/bet/src/bound.rs','native/bet/src/blade.rs','native/bet/src/shaft.rs','native/bet/src/inflow.rs','native/bet/src/polar.rs',
    'native/bet/src/rigid_body.rs','native/bet/src/body_abi.rs','native/bet/src/math.rs','native/bet/src/lib.rs',
    'tests/bet-runtime-fixture.ts','tests/fixtures/rotors/synthetic-bet-suite.json','tests/fixtures/polars/naca6409-neuralfoil.json',
    'tests/support/autopilot-parity.ts','tests/support/parity-mavlink.ts','tests/support/parity-native.ts',
    'tests/support/parity-identity.ts','tests/browser/autopilot-parity-worker.ts','tests/browser/autopilot-parity.spec.ts'];
  const sourceInputs=files.map(file=>({file,sha256:sha(readFileSync(join(root,file)))}));
  const bodyWasmSha256=sha(readFileSync(join(root,'packages/wasm-bet/dist/mirage_bet.scalar.wasm')));
  return {schemaVersion:1,firmwareCommit:'8ab6afde107a91df1b5f60ade8f333cb8a61b190',physicsHz:800,captureStride:8,
    // No stochastic host sensors. Firmware starts fresh with its default seed 1;
    // native libc and WASM libc RNG implementations need not be bit-identical.
    seed:1,airframeSha256:sha(JSON.stringify({sources:sourceInputs.filter(v=>/physics\/|wasm-bet\/|fixtures\/|autopilot-parity\.ts|bet-runtime-fixture/.test(v.file)),bodyWasmSha256})),
    parametersSha256:sha(defaultsText),commandsSha256:sha(readFileSync(join(root,'tests/support/parity-mavlink.ts'))),
    sensorSha256:sha(JSON.stringify(sourceInputs.filter(v=>/sensors\/|wasm-sitl|autopilot-parity\.ts/.test(v.file)))),
    sourceInputs,bodyWasmSha256};
}
