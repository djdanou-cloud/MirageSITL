# MirageSITL installation on macOS (TASK-152)

English source. [Russian mirror](../ru/install-macos.md).

Phase 1 runs on macOS with an Apple Silicon processor and Chrome. The
installer prepares the launcher folder that the local launcher
([runbook](runbook.md), TASK-151) uses; after it, the launcher, ArduPilot
SITL and the web application run without the network.

## Before you install

* macOS on Apple Silicon.
* Node.js 24 LTS (the repository's `.nvmrc`) and this repository with its
  npm packages installed (`npm ci`).
* The Xcode command line tools (`xcode-select --install`), which bring git,
  clang and Python 3.9 or later.
* A network connection for the installation only, and about 3 GB free.

## Install

```bash
node scripts/install-macos.mjs
```

Options: `--home DIR` chooses the launcher folder (default
`~/Library/Application Support/MirageSITL/launcher`, the launcher's own
default; `MIRAGE_LAUNCHER_HOME` sets both), `--jobs N` the build parallelism,
and `--plan` prints the steps without changing anything. The installer:

1. checks the host: macOS on Apple Silicon, Node.js 24, the Xcode command
   line tools, git and Python 3.9 or later, naming the fix for each missing
   one;
2. creates `venv/` and installs the Python packages of
   `scripts/install/requirements-macos.txt` with `pip --require-hashes`:
   every package is pinned to one version and only files with the listed
   SHA-256 install (pymavlink 2.4.50 and the packages the ArduPilot build
   needs, as TASK-127 used them);
3. fetches ArduPilot at the commit in `scripts/sitl.lock.json` into
   `sources/ardupilot` with the ten submodules the SITL build needs; git
   checks every object against its hash, and the checkout must be clean;
4. builds native ArduCopter SITL with waf into `build/`, admits it as a
   host-native Mach-O64 executable and records it in `catalog.json` with the
   SHA-256 of the executable and of ArduPilot's `copter.parm`;
5. fetches UAVLogViewer at the commit and parser submodule of
   `third_party/uavlogviewer/source.lock.json` into `sources/uavlogviewer` and
   checks its LICENSE hash, then builds the patched offline viewer into
   `uavlogviewer/` with `scripts/build-uavlogviewer.mjs` (TASK-179: the patches
   of `third_party/uavlogviewer/patches/`, the locked npm packages, license
   notices and `build-manifest.json`); a rerun rebuilds it only when its
   manifest no longer matches the patch series or the files on disk;
6. writes `install-manifest.json`: every installed item with its version,
   SHA-256, size and the license of its `config/offline-inventory.json` row.

A rerun checks every step again and skips what is already correct, so an
interrupted installation resumes. Exit 0 means installed, 1 a failed step and
2 a missing host prerequisite.

## First run

```bash
npm run start -w @mirage/launcher
npm run dev
```

The launcher prints the path of its token file, never the token. Open the
application in Chrome at `http://127.0.0.1:5173`, go to the Project tab and,
under "Setup: local launcher and prerequisites", enter the launcher port
(47800 unless `MIRAGE_LAUNCHER_PORT` changes it) and paste the token from the
file. "Check setup" lists each prerequisite (platform, Node.js, storage,
pymavlink, the installation and a compatible SITL build) as OK, Missing or
Needs attention, with what to do. The token stays in that page: it is sent in
the Authorization header only and is not stored. The check also tells apart
a launcher that does not answer and a refused token. The installation check
recomputes the SHA-256 of every file the manifest recorded inside the
launcher folder.

## Verification (TASK-152)

`tests/install-macos.test.ts` checks the host checks, the pinned requirements,
the manifest rules and `--plan`; when `.cache/task-152/home` holds a clean
installation it recomputes every recorded hash and requires every
prerequisite to be OK. `tests/browser/first-run.spec.ts` runs a real launcher
with a fake SITL build and checks the Project tab against it: an unreachable
port, a refused token, each prerequisite with its fix, the token kept out of
the address, storage and page text, 390 px without horizontal scrolling and
no axe violation. The roadmap entry records the clean installation on the
reference Mac.
