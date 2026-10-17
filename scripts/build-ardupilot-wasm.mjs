// Builds ArduCopter for ArduPilot's upstream `wasm` board (TASK-045) on a POSIX
// build host and writes a hash manifest for packages/autopilot/src/wasm-loader.ts.
//
// The build runs where waf works: directly on Linux, or inside a WSL
// distribution when invoked from Windows (MIRAGE_WSL_DISTRO). Paths in
// MIRAGE_ARDUPILOT_SOURCE, MIRAGE_EMSDK_DIR, MIRAGE_ARDUPILOT_VENV and --out are
// paths on the build host. The source must be the pinned commit and emcc the
// pinned version; anything missing exits 2 (BLOCKED_EXTERNAL), a failed build 1.
//
//   node scripts/build-ardupilot-wasm.mjs --out ~/mirage/build-wasm --artifacts DIR
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMemoryImport, REQUIRED_ARDUPILOT_EXPORTS } from "../packages/autopilot/src/wasm-loader.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

class Blocked extends Error {}

/** Runs a bash script on the build host and returns stdout. */
function host(script, env = process.env) {
  const distro = env.MIRAGE_WSL_DISTRO;
  if (process.platform === "win32") {
    if (!distro) throw new Blocked("Windows needs MIRAGE_WSL_DISTRO: ArduPilot waf requires a POSIX build host");
    return execFileSync("wsl.exe", ["-d", distro, "--exec", "/bin/bash", "-c", script], { encoding: "utf8", maxBuffer: 1 << 26 });
  }
  return execFileSync("/bin/bash", ["-c", script], { encoding: "utf8", maxBuffer: 1 << 26 });
}

export function buildPlan(env = process.env, out) {
  const source = env.MIRAGE_ARDUPILOT_SOURCE, emsdk = env.MIRAGE_EMSDK_DIR;
  if (!source || !emsdk || !out) throw new Blocked("MIRAGE_ARDUPILOT_SOURCE, MIRAGE_EMSDK_DIR and --out are required");
  const venv = env.MIRAGE_ARDUPILOT_VENV ? `. ${quote(env.MIRAGE_ARDUPILOT_VENV)}/bin/activate && ` : "";
  const toolchain = `export EMSDK=${quote(emsdk)} EM_CONFIG=${quote(emsdk)}/.emscripten && ` +
    `export PATH="$EMSDK/upstream/emscripten:$PATH" && ${venv}cd ${quote(source)}`;
  return { source, emsdk, out, toolchain };
}

export function buildArdupilotWasm(env = process.env, args = process.argv.slice(2)) {
  const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const out = option("--out"), artifacts = option("--artifacts");
  if (!artifacts) throw new Blocked("--artifacts DIR (local output directory) is required");
  const lock = JSON.parse(readFileSync(join(root, "native/ardupilot/toolchain.lock.json"), "utf8"));
  const plan = buildPlan(env, out);
  const commit = host(`${plan.toolchain} && git rev-parse HEAD`, env).trim();
  if (commit !== lock.ardupilot.commit) throw new Blocked(`ArduPilot source is at ${commit}, expected ${lock.ardupilot.commit}`);
  const version = /\b(\d+\.\d+\.\d+)\b/.exec(host(`${plan.toolchain} && emcc --version | head -1`, env))?.[1];
  if (version !== lock.emsdk.version) throw new Blocked(`emcc ${version ?? "missing"}, expected ${lock.emsdk.version}`);
  host(`${plan.toolchain} && rm -rf ${quote(out)} && ./waf configure --board wasm --out ${quote(out)} >/dev/null && ./waf --out ${quote(out)} copter`, env);
  const local = resolve(artifacts);
  mkdirSync(local, { recursive: true });
  const bin = `${out}/wasm/bin`;
  if (process.platform === "win32") host(`cp ${quote(bin)}/arducopter.js ${quote(bin)}/arducopter.wasm "$(wslpath -a ${quote(local)})"/`, env);
  else for (const f of ["arducopter.js", "arducopter.wasm"]) copyFileSync(`${bin}/${f}`, join(local, f));
  const wasm = readFileSync(join(local, "arducopter.wasm")), glue = readFileSync(join(local, "arducopter.js"));
  const memory = readMemoryImport(wasm);
  if (!memory || memory.maximumPages === null) throw new Error("Built module has no bounded memory import");
  const manifest = {
    schemaVersion: 1,
    firmware: "ArduCopter",
    board: "wasm",
    sourceCommit: commit,
    emscriptenVersion: version,
    module: { file: "arducopter.wasm", sha256: sha(wasm), bytes: wasm.length },
    glue: { file: "arducopter.js", sha256: sha(glue), bytes: glue.length },
    requiredExports: [...REQUIRED_ARDUPILOT_EXPORTS],
    memory: { shared: true, initialPages: memory.initialPages, maximumPages: memory.maximumPages },
    license: "GPL-3.0-or-later",
    distribution: "local-only-pending-gpl-review",
  };
  writeFileSync(join(local, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const m = buildArdupilotWasm();
    console.log(`ArduPilot WASM built: ${m.module.file} ${m.module.sha256} (${m.module.bytes} B), ${m.glue.file} ${m.glue.sha256}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof Blocked ? 2 : 1;
  }
}
