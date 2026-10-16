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
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const artifacts = [];
for (const { variant, targetFeatures, rustflags } of VARIANTS) {
  const targetDir = join(nativeDir, 'target', `wasm-${variant}`);
  execFileSync('cargo', ['build', '--release', '-p', 'mirage-bet', '--target', 'wasm32-unknown-unknown', '--locked'], {
    cwd: nativeDir, stdio: 'inherit',
    // RUSTFLAGS replaces (not extends) any caller setting, so each variant's codegen is fully specified.
    env: { ...process.env, CARGO_TARGET_DIR: targetDir, RUSTFLAGS: rustflags },
  });
  const file = `mirage_bet.${variant}.wasm`;
  copyFileSync(join(targetDir, 'wasm32-unknown-unknown', 'release', 'mirage_bet.wasm'), join(out, file));
  const bytes = readFileSync(join(out, file));
  artifacts.push({ variant, file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength, targetFeatures });
}
// Read the ABI version from the scalar artifact itself rather than restating it here.
const scalar = readFileSync(join(out, 'mirage_bet.scalar.wasm'));
const { instance } = await WebAssembly.instantiate(scalar, {});
const abiVersion = instance.exports.bet_abi_version();
const manifest = { schemaVersion: 1, crate: 'mirage-bet', abiVersion, toolchain, artifacts };
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`build-wasm: ${artifacts.map(a => `${a.variant} ${a.bytes} B ${a.sha256.slice(0, 12)}`).join(', ')}; ABI ${abiVersion}; ${toolchain}; ${relative(root, out)}`);
