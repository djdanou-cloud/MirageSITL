// Builds the mirage-bet WASM artifacts and their manifest (TASK-017).
//
//   node scripts/build-wasm.mjs [--out packages/wasm-bet/dist]
//
// Variants: `scalar` (baseline, required everywhere) and `simd128`
// (-C target-feature=+simd128, chosen only after feature detection). cargo
// runs inside native/ so native/rust-toolchain.toml pins the toolchain. The
// manifest records each artifact's SHA-256 and size, the ABI version read
// back from the built module, and the toolchain that produced it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withExclusiveLock } from './exclusive-lock.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = join(root, 'native');
const outIndex = process.argv.indexOf('--out');
const out = resolve(root, outIndex >= 0 ? process.argv[outIndex + 1] ?? '' : 'packages/wasm-bet/dist');

const VARIANTS = [
  { variant: 'scalar', targetFeatures: [], rustflags: '' },
  { variant: 'simd128', targetFeatures: ['simd128'], rustflags: '-C target-feature=+simd128' },
];

const toolchain = execFileSync('rustc', ['-V'], { cwd: nativeDir, encoding: 'utf8' }).trim();
mkdirSync(out, { recursive: true });
mkdirSync(join(nativeDir, 'target'), { recursive: true });
const artifacts = [];
let scalar;
for (const { variant, targetFeatures, rustflags } of VARIANTS) {
  const targetDir = join(nativeDir, 'target', `wasm-${variant}`);
  const file = `mirage_bet.${variant}.wasm`;
  const staging = join(out, `${file}.${process.pid}.tmp`);
  // Test files run this in parallel. Cargo holds its lock only while it builds, and every cargo run, even with nothing to do,
  // deletes the target directory's mirage_bet.wasm and puts it back. So one lock covers each run's cargo and its copy.
  withExclusiveLock(`${targetDir}.build-lock`, () => {
    execFileSync('cargo', ['build', '--release', '-p', 'mirage-bet', '--target', 'wasm32-unknown-unknown', '--locked'], {
      cwd: nativeDir, stdio: 'inherit',
      // RUSTFLAGS replaces (not extends) any caller setting, so each variant's codegen is fully specified.
      env: { ...process.env, CARGO_TARGET_DIR: targetDir, RUSTFLAGS: rustflags },
    });
    copyFileSync(join(targetDir, 'wasm32-unknown-unknown', 'release', 'mirage_bet.wasm'), staging);
  });
  // The staged file is this run's own: another run may be replacing the published one.
  const bytes = readFileSync(staging);
  renameSync(staging, join(out, file));
  if (variant === 'scalar') scalar = bytes;
  artifacts.push({ variant, file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength, targetFeatures });
}
// Read the ABI version from the scalar artifact itself rather than restating it here.
const { instance } = await WebAssembly.instantiate(scalar, {});
const abiVersion = instance.exports.bet_abi_version();
const manifest = { schemaVersion: 1, crate: 'mirage-bet', abiVersion, toolchain, artifacts };
// Files read the manifest while other runs publish theirs, so it too appears whole.
const manifestStaging = join(out, `manifest.json.${process.pid}.tmp`);
writeFileSync(manifestStaging, JSON.stringify(manifest, null, 2) + '\n');
renameSync(manifestStaging, join(out, 'manifest.json'));
console.log(`build-wasm: ${artifacts.map(a => `${a.variant} ${a.bytes} B ${a.sha256.slice(0, 12)}`).join(', ')}; ABI ${abiVersion}; ${toolchain}; ${relative(root, out)}`);
