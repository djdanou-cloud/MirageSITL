# UAVLogViewer integration decision

English source. [Russian mirror](../ru/uavlogviewer.md).

TASK-130 (S14), decision D-04 in the [Phase 1 plan](../PHASE1_PLAN.md). This
record identifies the upstream UAVLogViewer, pins it, lists what keeps it from
running offline, and chooses how MirageSITL adds the S14 features. No
replacement viewer is started.

Status: decided (D-04, TASK-130 DONE on 2026-10-28). The pinned build opens
the stakeholder's ArduCopter 4.6.2 DataFlash log in Chromium with all network
access blocked, with no errors. TASK-179 (DONE on 2026-11-05) applies
patches 0000–0002, builds the viewer reproducibly and embeds it in the Analysis
tab; on the reference M5 it opens DataFlash logs with no network request in
Google Chrome 156.

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

The patches are stored in `third_party/uavlogviewer/patches/` and applied in
name order by the TASK-179 build. Patches 0–2 exist (TASK-179); the rest of
patch 2 and patches 3–4 belong to TASK-180 and TASK-181:

| Patch | Purpose | Upstream files it changes |
| --- | --- | --- |
| 0 Compatibility (`0000-compatibility.patch`, TASK-179) | Tolerate `CMD` messages without a `Frame` field (logs from older firmware), so mission extraction no longer aborts the remaining extraction steps. Register the parser submodule's own worker listener only when that module is the worker: imported by the viewer's worker it parsed every log a second time and threw `TypeError` on every `loadType` request (first seen with native SITL logs, whose position opens the 3D view). Take `_COMMIT_` and `_BUILDDATE_` from `UAVLOGVIEWER_COMMIT` and `SOURCE_DATE_EPOCH`, so the build is reproducible outside a git checkout | `src/tools/dataflashDataExtractor.js`, `src/tools/parsers/parser.worker.js`, `src/tools/parsers/JsDataflashParser/parser.js`, `build/webpack.prod.conf.js` |
| 1 Offline (`0001-offline.patch`, TASK-179) | Remove analytics and the web font, bundle the Font Awesome 5.2.0 icon font from the npm package `@fortawesome/fontawesome-free` (added to `package.json` and `package-lock.json` with its registry integrity hash; the font rule of the webpack configuration gets `type: 'javascript/auto'` and `esModule: false` so the CSS references the real font files), replace the online probe with the setting `?online=1` (off by default), remove the MapTiler provider with the embedded key, disable IP geolocation unless online | `index.html`, `src/main.js`, `src/App.vue`, `src/components/Home.vue`, `src/components/CesiumViewer.vue`, `src/components/widgets/MagFitTool.vue`, `build/webpack.base.conf.js`, `package.json`, `package-lock.json` |
| 2 Message interface (`0002-message-interface.patch`, TASK-179 part) | Replace the unchecked `message` listener with an origin-checked API (protocol 1, below): load a log with its name; report ready, accepted, rejected with a reason, and parsed with the number of message types. `?file=` opens same-origin URLs only. Context, a second log, a time shift and parameter-change markers follow in TASK-180 and TASK-181 | `src/components/SideBarFileManager.vue`, a new `src/mirage/bridge.js` |
| 3 Two logs | Keep one dataset per log, parse the second log in its own worker, draw each log's traces in a distinct style on common axes, side by side or overlaid, with a manual time shift; select two intervals of one log | `src/components/Globals.js`, `src/components/SideBarFileManager.vue`, `src/components/Plotly.vue`, `src/components/PlotSetup.vue`, `src/components/Sidebar.vue` |
| 4 Markers and context | Colour parameter-change annotations by status; show aircraft and component versions, environment and parameter differences, marking missing context as unknown | `src/components/Plotly.vue`, `src/components/Sidebar.vue`, a new `src/mirage/ContextPanel.vue` |

## Offline build and embedding (TASK-179)

`node scripts/build-uavlogviewer.mjs [--source DIR] [--out DIR] [--work DIR]`
checks the source checkout against the lock (by default the TASK-152 checkout
in `<launcher home>/sources/uavlogviewer`), copies it into a fresh work folder,
applies the patches with `git apply`, runs `npm ci --ignore-scripts` (npm
verifies every integrity hash of the lockfile), the upstream `patch-package`
step and `npm run build` with an empty Cesium token, `UAVLOGVIEWER_COMMIT` and
`SOURCE_DATE_EPOCH` set to the upstream commit time. The output folder (default
`<launcher home>/uavlogviewer`) holds the built viewer, `licenses/` (the GPL-3.0
texts of the viewer and the parser, the patches, a README naming the
corresponding source, and `THIRD-PARTY-NOTICES.txt` with the license of each of
the 958 production npm packages) and `build-manifest.json` (commit, patch
hashes, toolchain and the output digest by the TASK-130 rule, excluding the
manifest itself). `scripts/install-macos.mjs` runs it in step 5 and skips it
when the manifest still matches the patch series and the files on disk. The
lock records the reproduced build under `patchedBuild`. Only the build uses
the network (the npm registry).

The Vite dev and preview servers serve the build at `/uavlogviewer/` from
`MIRAGE_UAVLOGVIEWER_DIR` (default `<launcher home>/uavlogviewer`) to loopback
clients only, for GET and HEAD, with COOP `same-origin`, COEP `require-corp` and
CORP `same-origin`, refusing paths outside the folder. The Analysis tab
(`apps/web/src/analysis/LogViewerHost.tsx`) loads the viewer only when the tab
is first opened, shows the build's commit and patch count with a link to the
license folder, and explains how to install the viewer when no build is
served. A chosen file is refused unless it is a DataFlash binary log (the
`0xA3 0x95` header, at most 512 MiB) and is then transferred to the frame.

Message interface, protocol 1. Both sides accept a message only from the same
origin and the expected window (the viewer: its parent; the host: the frame),
and send with the target origin set to their own origin:

| Direction | Message | Meaning |
| --- | --- | --- |
| Host → viewer | `{ type: "mirage.loadLog", protocol: 1, name, bytes }` | Open `bytes` (an ArrayBuffer, transferred) as a DataFlash log called `name` (1–255 characters, no path separators or control characters) |
| Viewer → host | `{ type: "mirage.ready", protocol: 1 }` | The viewer listens; a log chosen earlier is sent now |
| Viewer → host | `{ type: "mirage.logAccepted", protocol: 1, name, bytes }` | The log was handed to the parser |
| Viewer → host | `{ type: "mirage.logRejected", protocol: 1, reason }` | The message was refused, for example another protocol version |
| Viewer → host | `{ type: "mirage.logParsed", protocol: 1, name, messageTypes }` | Parsing finished with this many message types |

The DJI parser (`src/tools/parsers/djiParser.js`) still requests decryption
keys from `dev.dji.com` when a DJI `.txt` log is opened. Phase 1 opens
ArduPilot logs only; the offline smoke tests never reach that code.

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
* TASK-179 on the reference MacBook Air (Apple M5), macOS 26.6, Node 24.22.1,
  npm 11.19.1, on 2026-10-31:
  * Two builds of the final patch series (the installer run and a separate
    work folder) gave 1,140 files, 52,622,162 bytes, digest
    `62f30cb61d2556b8e03450a32e406b0b16bc9697661a1223621dd80f92873e9c`, each in
    about 50 s with 3 webpack size warnings; each earlier revision of the
    series also built identically twice or three times.
  * The first offline revision drew empty boxes instead of icons: for the
    bundled icon font webpack 5 emitted its own asset next to `url-loader`'s,
    so the CSS pointed at an 84-byte JavaScript stub, and with that fixed it
    printed the URL as `[object Module]`. Patch 0001 therefore sets
    `type: 'javascript/auto'` and `esModule: false` on the font rule of
    `build/webpack.base.conf.js`, and the check and the browser test now
    require the `Font Awesome 5 Free` face to load (the earlier build fails
    that requirement).
  * `node scripts/check-uavlogviewer.mjs` with the installed build PASS for all
    ten native SITL DataFlash logs of TASK-128 (quad, hexa, octa, X8 and the
    16-motor paired configuration, motor test and flight each, 188,416 to
    2,101,248 bytes): 150 to 169 message types listed, 8 or 9 types decoded,
    no exception, no request left the loopback server, the icon font loaded, build identity PASS and
    equal to the locked digest. The viewer labels every one of these logs
    `quadcopterx`; that is its own vehicle classification. Browser: Playwright's
    Chromium 141.0.7390.37. Reports: `.cache/task-179/checks/`.
  * In Google Chrome 156.0.8078.80 on the reference M5 on 2026-11-05 the same
    check PASS for ten native SITL logs (four TASK-127 captures, the TASK-152 quad
    flight and the five TASK-158 flights of 2026-11-04; 168 or 169 message types)
    and for the lock's older-firmware log, 65,536 bytes with its recorded SHA-256,
    ArduPlane V3.8.2-dev, 148 message types, which failed on 2026-10-28 before
    patch 0: no exception, no request left the loopback server, build identity PASS.
  * Before the listener fix of patch 0 the same check failed on the quad log
    with `TypeError: Cannot read properties of undefined (reading 'loadType')`.
  * `tests/browser/log-viewer.spec.ts` passes both cases: the missing-build
    message with its fix and zero axe violations, and with the build served,
    the isolation headers, a refused traversal, a refused non-DataFlash file, a
    refused protocol 2 message, a TASK-178 MirageSITL log and the 16-motor SITL
    reference log opened, with no exception and no request outside loopback.

## Remaining

* **Patches 3 and 4 and the rest of patch 2** (context, a second log, time
  shift, markers) belong to TASK-180 and TASK-181.
* **Accessibility of the embedded viewer.** axe finds seven rule violations
  inside the upstream viewer at 390 px: `aria-command-name` (the icon-only menu
  button), `image-alt` (the GitHub images), `label` (the file input
  `#choosefile`), `landmark-unique`, `link-in-text-block`, `link-name` and
  `listitem`. The shell's 390 px scan in `tests/browser/app-shell.spec.ts`
  covers MirageSITL's own page and excludes the viewer frame; an accessibility
  patch for the viewer is open for the TASK-080 sign-off.
