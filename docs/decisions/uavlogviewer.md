# UAVLogViewer integration decision

English source. [Russian mirror](../ru/uavlogviewer.md).

TASK-130 (S14), decision D-04 in the [Phase 1 plan](../PHASE1_PLAN.md). This
record identifies the upstream UAVLogViewer, pins it, lists what keeps it from
running offline, and chooses how MirageSITL adds the S14 features. No
replacement viewer is started.

Status: decided (D-04, TASK-130 DONE on 2026-10-28). The pinned build opens
the stakeholder's ArduCopter 4.6.2 DataFlash log in Chromium with all network
access blocked, with no errors. The same check in Chrome on macOS runs on the
M5 as part of TASK-179.

## Identity

| Item | Value |
| --- | --- |
| Repository | `https://github.com/ArduPilot/UAVLogViewer` |
| Pinned commit | `01f9d510b7df31687819a6c87415161041d73ae6` (2026-08-05, latest at pinning) |
| Submodule | `src/tools/parsers/JsDataflashParser` at `d8967f6e4b4415492ea7d9b1adb1a6dc026f2b75` (`https://github.com/Williangalvani/JsDataflashParser`) |
| License | GNU GPL version 3 in `LICENSE` (the parser submodule too). It allows MirageSITL to modify the viewer and bundle it locally; the patches stay in this repository as source |
| Toolchain | Vue 2.7, webpack 5, Cesium, Plotly; upstream builds with Node 20 (`Dockerfile`) |
| Lock | [third_party/uavlogviewer/source.lock.json](../../third_party/uavlogviewer/source.lock.json): commit, submodule, LICENSE and lockfile hashes, build commands, test log |

## What needs the network at the pinned commit

Found by reading the source; the offline smoke test confirms it at run time by
listing every request it blocks.

| Dependency | Where | Effect offline | Phase 1 handling |
| --- | --- | --- | --- |
| Google Analytics (two `gtag` tags) | `index.html` | Requests fail; no functional effect | Patch 1 removes them |
| Font Awesome 5 stylesheet from `use.fontawesome.com` | `index.html` | Icons disappear | Patch 1 bundles the icons locally |
| Google Fonts (Nunito Sans) | `src/App.vue` | A system font is used | Patch 1 removes the request |
| `is-online` probe of public endpoints (`api.ipify.org`, `ipv4.icanhazip.com` in the smoke test) | `src/components/Home.vue` | Returns false, so the viewer opens its offline 3D mode without imagery or terrain | Patch 1 replaces the probe with a setting |
| Map imagery: Esri (default), StatKart, MapTiler with an API key written into the source, Eniro, OpenStreetMap, OpenSeaMap | `src/components/CesiumViewer.vue` | Not available | Offline mode by default; patch 1 removes the provider that carries the embedded key. Online imagery stays an option when connected (S17) |
| Terrain from the same-origin path `/quantized/` | `src/components/CesiumViewer.vue` | Falls back to the ellipsoid | Served locally later if MirageSITL terrain is wanted (TASK-186) |
| IP geolocation (`ipapi.co`, `ipwho.is`) | `src/components/widgets/MagFitTool.vue` | The magnetometer-fit helper cannot locate itself | Patch 1 disables the lookup offline |

The pinned commit no longer uses Cesium ion, so no token is needed; the build
writes `runtime-config.js` with an empty token. The bundled sample is a
telemetry log (`src/assets/vtol.tlog`), not a DataFlash log.

## Code that the S14 features touch

* `src/components/Globals.js` holds the state of exactly one log: messages,
  flight-mode changes, events and parameters.
* `src/components/SideBarFileManager.vue` loads one file into a parsing Web
  Worker. It also opens a log named by `?file=URL`, and it accepts a window
  `message` of type `arrayBuffer` from any origin, without an origin check.
* `src/components/Plotly.vue` draws the plots and their annotations for events,
  mode changes and parameter changes. The parameter changes come from `PARM`
  messages through `src/tools/dataflashDataExtractor.js` and
  `src/tools/paramseeker.js`.
* `src/components/widgets/CesiumSettingsWidget.vue` compares trajectory sources
  inside the one loaded log.

There is no plugin or extension API, and no support for two logs at once.

## Decision: extension approach

MirageSITL keeps a **patch series on the pinned upstream commit**. It builds the
patched viewer locally and embeds it in the MirageSITL log view as a page
served from the same machine, which talks to MirageSITL through an
origin-checked message interface. MirageSITL does not maintain a diverging fork
branch and does not start a replacement viewer.

Why:

* Upstream has no extension points, so embedding alone cannot add two-log
  comparison, time shifts or status-coloured parameter markers.
* A patch series keeps every change small and reviewable. It can be reapplied
  to a newer upstream commit, and individual patches can be offered upstream.
* GPL version 3 permits modifying and bundling the viewer locally; the patch
  files are the published source of the changes.

Planned patches, stored in `third_party/uavlogviewer/patches/` and applied by
the TASK-179 build:

| Patch | Purpose | Upstream files it changes |
| --- | --- | --- |
| 0 Compatibility | Tolerate `CMD` messages without a `Frame` field (logs from older firmware), so mission extraction no longer aborts the remaining extraction steps | `src/tools/dataflashDataExtractor.js` |
| 1 Offline | Remove analytics and web fonts, bundle the icons, replace the online probe with a setting, remove the provider with the embedded key, disable IP geolocation offline | `index.html`, `src/App.vue`, `src/components/Home.vue`, `src/components/CesiumViewer.vue`, `src/components/widgets/MagFitTool.vue`, `package.json` |
| 2 Message interface | Replace the unchecked `message` listener with an origin-checked API: load a log with its name and context, load a second log, set a time shift, add parameter-change markers with requested, confirmed or rejected status, show the experiment context | `src/components/SideBarFileManager.vue`, `src/components/Home.vue`, a new `src/mirage/bridge.js` |
| 3 Two logs | Keep one dataset per log, parse the second log in its own worker, draw each log's traces in a distinct style on common axes, side by side or overlaid, with a manual time shift; select two intervals of one log | `src/components/Globals.js`, `src/components/SideBarFileManager.vue`, `src/components/Plotly.vue`, `src/components/PlotSetup.vue`, `src/components/Sidebar.vue` |
| 4 Markers and context | Colour parameter-change annotations by status; show aircraft and component versions, environment and parameter differences, marking missing context as unknown | `src/components/Plotly.vue`, `src/components/Sidebar.vue`, a new `src/mirage/ContextPanel.vue` |

## Adapter route for MirageSITL experiments

MirageSITL experiments reach the viewer as DataFlash, which its parser already
reads:

* The ArduPilot DataFlash log captured for each experiment (TASK-164) opens as
  is.
* MirageSITL's own recordings are written as DataFlash by the TASK-178 writer.

The experiment context (profile and component versions, environment, and
parameter history with request status) travels through the message interface of
patch 2, not inside the log. An external log without that context shows it as
unknown; parameter history that the log does not contain is never invented.

## Evidence

* `git clone` of the repository at `01f9d510`, with the parser submodule at
  `d8967f6e`.
* `npm ci --ignore-scripts` with Node 24.22.1: exit 0, 2,595 packages. Then
  `npx patch-package`: exit 0; the plotly.js patch, written for 2.12.1, applies
  to the resolved 2.24.2 with a version warning only.
* `npm run build` with Node 24.22.1 and an empty Cesium token: exit 0 in 80 s,
  webpack 5.88.0 with 3 size warnings. The output has 1,106 files and
  48,133,342 bytes, digest
  `6920d29f33963293ffb8956fc9468b9170d5c20c3bd2a78ee38251c1e2df55ca` (SHA-256
  of sorted `path<TAB>sha256` lines, as the check computes it).
* Offline smoke test in Chromium 153.0.8010.12 (the preinstalled browser, given
  through `CHROMIUM_PATH`), with every request outside the loopback server
  aborted, exit 1, FAIL:

  ```bash
  CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/check-uavlogviewer.mjs --source .cache/task-130/UAVLogViewer --dist .cache/task-130/UAVLogViewer/dist --log .cache/task-130/logs/pymavlink-test.BIN
  ```

  * The viewer listed 148 message types and decoded samples for 9 of them
    (`ATT` 24, `AHR2` 23, `POS` 23, `GPS` 5, `CMD` 12, `MSG` 6, `NKQ1` 24,
    `NKQ2` 24, `PARM` 809) with no network.
  * It raised `TypeError: Cannot read properties of undefined (reading '0')`
    twice in `extractMission`. That code reads `CMD.Frame`, a field that
    ArduPlane 3.8 did not log, and the exception skips the remaining
    extraction steps (vehicle type, parameters, attitude, trajectory, text
    messages). Patch 0 addresses it.
  * Aborted requests: `www.googletagmanager.com` (2), `use.fontawesome.com`,
    `fonts.googleapis.com`, `api.ipify.org` and `ipv4.icanhazip.com` (one each),
    all removed by patch 1.
* Older-firmware log: `tests/test.BIN` from pymavlink at `bd0a1b29`, a real
  DataFlash log from ArduPlane V3.8.2-dev on a Pixhawk-family board, 65,536
  bytes, SHA-256
  `a51f040b2ad7f55185c1da5705f226f51469b86562c4ff76d05c99e0e52c2bf4`.
* Current-firmware log, PASS: the stakeholder's own flight log
  `00000144.BIN`, ArduCopter V4.6.2 (`1ebd4d99`) on a MatekH743-bdshot board,
  frame QUAD/X_REV, 31,354,880 bytes, SHA-256
  `95c6e0d3da3f5d100aefb4f44af30418cd60f34a0322dfafb6b3a4170d5ea8f1`. It is
  kept outside the repository. The same command with
  `--log .cache/task-130/logs/user-00000144.BIN` exited 0: 176 message types
  listed, decoded samples for `ATT` (620), `XKQ[0]`, `XKQ[1]`, `XKF4[0]`,
  `XKF4[1]` (about 1,546 each) and `PARM` (1,554), vehicle detected as
  `quadcopterx`, no exception, in 2.8 s. The same five online origins were
  aborted without effect. A follow-up run plotted `ATT.Roll` and `ATT.DesRoll`
  offline.

## Remaining

* **Chrome on macOS.** TASK-179 runs the same check in Chrome on the reference
  M5 (decision A-01) when it bundles the patched viewer, for example with
  `CHROMIUM_PATH` pointing at the Chrome binary.
* **Older logs.** Logs from firmware that did not record `CMD.Frame` fail until
  patch 0 lands in TASK-179.
