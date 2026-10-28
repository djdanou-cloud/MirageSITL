# Offline dependency and terrain inventory

English source. [Russian mirror](../ru/offline-inventory.md).

TASK-131 (S01, S17). After installation, the Phase 1 workflow must run offline
(S01), and terrain is limited to existing local data, with Israel as the focus
(S17). This guide lists what Phase 1 needs after installation, which data
sources exist, and what is missing. It adds no provider and downloads nothing.

## Files and the check

| File | Contents |
| --- | --- |
| `config/offline-inventory.json` | Dependency rows, the listed network origins, the npm license policy and the scanned directories |
| `data/terrain/inventory.json` | Terrain, imagery and land-cover sources, and the coverage gaps |
| `scripts/check-offline.mjs` | The check; it reads local files only |

```bash
node scripts/check-offline.mjs
npm run build
node scripts/check-offline.mjs --dist apps/web/dist
```

The check prints a JSON summary and exits 0 on PASS and 1 on FAIL. It fails
when:

* a scanned file or the built bundle names a network origin that
  `networkOrigins` does not list;
* a runtime (non-development) npm package in `package-lock.json` declares a
  license outside `npm.allowedLicenses`, or no license;
* an inventoried file is missing or its bytes or SHA-256 differ;
* an unresolved or restricted license, a pending dependency, or a terrain
  source that is not ready names no decision or task that resolves it;
* a category, terrain kind, readiness value or required field is unknown or
  missing;
* `--dist` names a bundle directory that does not exist.

The scan covers `apps`, `packages`, `services`, `scripts`, `config`, `data`
and `native` (TypeScript, JavaScript, HTML, JSON, Python and shell files) and
skips `node_modules`, `dist`, `target`, `.cache` and `.git`. The check sees
only origins written literally as `scheme://host[:port]`. URLs assembled at
run time from configuration, such as `VITE_MIRAGE_TILESET_URL`, are not visible
to it; TASK-186 governs those sources.

`tests/offline-inventory.test.ts` runs the check on the repository and on
small synthetic roots that break each rule, including a synthetic bundle.

## Network origin uses

| Use | Meaning |
| --- | --- |
| `loopback` | The local machine only: the bridge, preview servers and Worker checks |
| `identifier` | A schema or namespace identifier that is never fetched |
| `documentation-link` | A citation or documentation link in comments, data manifests or bundled libraries |
| `install-time` | Fetched while installing or building: pinned source clones and package registries |
| `manual-data-preparation` | Fetched only when an operator runs a data-preparation script by hand |
| `online-optional` | An online service that is never an offline source and never a ready source without keys and a deployment |

The inventory file names every listed origin itself, so the check does not
scan it; the summary's `unusedOrigins` lists origins that no scanned file names.
On 2026-10-28 the repository scan found 23 of the 27 listed origins: 5
loopback, 4 identifiers, 7 documentation links, 2 install-time, 4 manual data
preparation and 1 online-optional (`https://tile.googleapis.com`, behind the
optional tiles worker). The built bundle adds the other 4, all inside bundled
libraries: the identifier `http://www.w3.org` and the documentation links
`https://react.dev`, `https://docs.pmnd.rs` and `https://www.shadertoy.com`.
With `--dist apps/web/dist`, all 27 are named and none is unused.

## Dependencies after installation

| Item | Version | Installation downloads it | License status | Phase 1 status | Resolved by |
| --- | --- | --- | --- | --- | --- |
| Web application, Workers and loopback bridge | Repository commit | No (built locally) | Not applicable (project-owned) | Ready | — |
| 38 runtime npm packages | `package-lock.json` | Yes (`npm ci`) | Reviewed: MIT 29, BSD-3-Clause 5, ISC 2, Apache-2.0 2 | Ready | Checked per package |
| Development npm packages | `package-lock.json` | Yes (`npm ci`) | Not applicable (not shipped) | Ready | — |
| Node.js | 24 LTS | Yes | Reviewed (MIT) | Ready | — |
| Rust toolchain with wasm32 | 1.97.0 | Yes (rustup) | Reviewed (MIT or Apache-2.0) | Ready | — |
| BET WebAssembly artifacts | Built from `native/bet` | No (built locally) | Not applicable (project-owned) | Ready | — |
| Rapier contact WebAssembly | Rapier `b716d375` | Yes (source clone and crates) | Reviewed (Apache-2.0) | Ready | — |
| ArduPilot ArduCopter source | `8ab6afde` | Yes (source clone and submodules) | Restricted (GPL-3.0-or-later) | Pending | D-01, D-02 |
| ArduPilot build prerequisites on macOS | Not pinned | Yes | Unresolved | Pending | D-02 (TASK-127) |
| pymavlink | 2.4.50 | Yes | Reviewed (LGPL-3.0, unmodified tool) | Ready | — |
| MAVLink message definitions | `2e2b6af9` | No (subset in the repository) | Reviewed (MIT) | Ready | — |
| ArduPilot parameter metadata | Generated from the selected source | No | Restricted (GPL-3.0-or-later) | Pending | TASK-159, D-02 |
| UAVLogViewer | Not selected | Yes | Unresolved | Pending | D-04 (TASK-130) |
| Chrome on macOS | Not selected | Yes | Not applicable | Pending | D-08 (TASK-132) |
| World Magnetic Model coefficients | WMM2025 | No | Unresolved | Pending | TASK-148 |
| UIUC propeller database | README of 2022-06-27 | No (provided offline) | Unresolved (no explicit license) | Ready | D-06 (TASK-133) |
| JSBSim WebAssembly | `570e8115` | Yes | Reviewed (LGPL-2.1) | Not needed in Phase 1 | — |
| ArduPilot browser WebAssembly | `native/ardupilot/toolchain.lock.json` | Yes | Restricted (GPL-3.0-or-later) | Not needed in Phase 1 | TASK-045 |
| Geodata pipeline environment | `scripts/geodata/setup-wsl.sh` | No (manual setup) | Unresolved | Not needed in Phase 1 | D-09 |
| FLIR ADAS thermal sample | ADAS v2 | No (manual, after the agreement) | Restricted | Not needed in Phase 1 | Dataset agreement review |

## Terrain sources

Imagery, elevation and land cover are separate kinds. A source that needs
data, keys or a deployment is not a ready source.

| Source | Kind | Coverage | Resolution | Readiness | License status |
| --- | --- | --- | --- | --- | --- |
| Synthetic level pad | Synthetic surface | Any location | Analytic plane | Ready | Not applicable |
| ESA WorldCover 2021 v200 | Land cover | Israel only (tiles N27E033, N30E033, N33E033) | 10 m classes | Ready, not wired into the runtime | Reviewed (CC BY 4.0) |
| FABDEM V1-2 | Elevation | The `config/geodata.json` bounding box once prepared | About 30 m | Needs data | Restricted (CC BY-NC-SA 4.0) |
| EGM2008 geoid grid | Geoid | Global | 2.5 arc-minutes | Needs data | Unresolved |
| Overture Maps buildings | Vector features | The bounding box once prepared | Footprints with heights | Needs data | Restricted (ODbL-1.0 or CDLA-Permissive-2.0) |
| OpenStreetMap features | Vector features | The supplied extract | Vector | Needs data | Restricted (ODbL-1.0) |
| Google Photorealistic 3D Tiles | Imagery and mesh | Online only | Provider-defined | Needs keys or deployment | Restricted (Google Maps Platform terms) |
| Quantized-mesh fixture | Test fixture | Synthetic | Zoom 0 to 12 | Test only | Not applicable |
| 3D Tiles fixtures | Test fixture | Synthetic | Fixture geometry | Test only | Not applicable |

The three WorldCover tiles are in the repository and the check verifies their
bytes and SHA-256 on every run. The FABDEM, geoid and building outputs are
prepared by hand with `scripts/geodata/` and kept outside the repository.

## Coverage gaps

The gaps are listed, not filled with new providers:

1. No offline imagery exists for any region. The only imagery source is the
   online Google proxy, which needs keys and a deployment.
2. No elevation data is in the repository. The FABDEM tooling exists, but its
   output is prepared by hand, kept outside the repository and licensed for
   non-commercial use only.
3. WorldCover land cover for Israel is validated but not wired into the
   runtime.
4. No geoid grid is in the repository, so elevation above sea level cannot yet
   be converted to ellipsoidal height offline (TASK-148).
5. Outside the Israel WorldCover tiles and any locally prepared FABDEM area,
   only the synthetic pad is available.

## Decisions this inventory raises

Decision D-09 in the [Phase 1 plan](../PHASE1_PLAN.md) collects the terrain
questions:

* whether FABDEM's non-commercial license fits the stakeholder's use, and
  whether locally prepared FABDEM terrain is the Phase 1 elevation source;
* the EGM2008 geoid grid's license, before TASK-148 stores it;
* whether Phase 1 shows Overture buildings or uses OpenStreetMap features,
  given ODbL share-alike;
* that Google Photorealistic 3D Tiles stay an online-only, not-ready source.

The other open rows wait on decisions the plan already records: D-01 and D-02
(ArduPilot version, macOS build method, and GPL obligations if a prebuilt
binary is ever shipped), D-04 (UAVLogViewer), D-06 (reliance on the UIUC
propeller data) and D-08 (Chrome and macOS versions).

## Maintaining the inventory

* A new network origin needs a row with a use and a reason. A run-time fetch
  from a non-loopback origin is `online-optional` and needs an S01 review.
* A runtime npm package with a new license fails the check until the license
  is reviewed and added to `npm.allowedLicenses`.
* Update a file's bytes and SHA-256 only after verifying the new file against
  its source. Never update them merely to silence the check.
* Update the Russian mirror in the same change.
