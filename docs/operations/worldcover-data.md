# WorldCover coverage and manual region downloads

English source. [Russian mirror](../ru/worldcover-data.md).

## Current geographic boundary

MirageSITL's current terrain classification coverage for **ESA WorldCover 2021
v200 is restricted exclusively to Israel**. This is the project geographic
scope specified by the operator, not a limitation of the global source dataset.
Regions outside Israel require deliberate acquisition and integration before
they can be included in supported classification coverage. Source tiles crossing
a national boundary do not extend the supported region into neighboring countries.

TASK-069 (DONE) decodes the three supplied Israel tiles in windows and validates
real coordinates through `MaterialMap` (see below). Application wiring, a
runtime `DataManifest` loaded from local files and OpenStreetMap overlays remain
open. Missing data must retain its synthetic/unavailable label. WorldCover
supplies land classes, not ground elevation, measured temperature or camera
calibration.

## Supplied Israel tiles and windowed GeoTIFF decoder (TASK-069)

Three operator-supplied tiles are stored unchanged in
`data/worldcover/2021-v200/israel/`:
`ESA_WorldCover_10m_2021_v200_N27E033_Map.tif`,
`ESA_WorldCover_10m_2021_v200_N30E033_Map.tif` and
`ESA_WorldCover_10m_2021_v200_N33E033_Map.tif`.
The [staging inventory](../../data/worldcover/2021-v200/israel/inventory.json)
records exact bytes (90,313,215 bytes total), SHA-256 hashes, product source
URLs, license, attribution and verification flags
(`copyHashesMatchOriginals: true`, `rasterDecodingPerformed: true`,
`coordinateValidationPerformed: true`, `publisherChecksumVerified: false`,
`runtimeManifestRegistered: false`). The receipt date is not an inferred
acquisition date, and this staging inventory is not the runtime `DataManifest`.

The operator explicitly authorized storing these three binary files in Git.
The outside-checkout recommendation below continues to apply to future bulk
downloads. Tile storage does not extend supported coverage outside Israel.

`packages/thermal/src/geotiff.ts` reads these tiles in windows:

* It parses the first IFD once and accepts only the WorldCover profile:
  classic TIFF, single-band uint8, tiled 1024 x 1024, DEFLATE without a
  predictor, EPSG:4326 PixelIsArea, square 1/12000 deg pixels, a north-west
  tie point and GDAL no-data 0.
* It decodes only the internal tiles a requested window touches, at most
  4096 x 4096 pixels, so the 1.3 GB full raster is never materialized. File
  reads and zlib inflation are injected, so Node and browser callers supply
  their own.
* `windowForBounds` snaps a geographic box outward to whole pixels.
  `assertIsraelCoverage` refuses boxes outside 29.4–33.4 N, 34.2–35.95 E, an
  Israel-enclosing box that does not certify borders.

A decoded window becomes a `WorldCoverRaster`; its `DatasetEntry` carries
the window bounds, the tile's inventory SHA-256, the CC BY 4.0 license and
the ESA attribution. `tests/worldcover-geotiff.test.ts` checks:

* tile bytes and hashes against the inventory, and the georeferencing of all
  three tiles;
* known coordinates through `MaterialMap`: the Mediterranean off Tel Aviv,
  the Dead Sea, Lake Kinneret and the Gulf of Eilat are water (80); central
  Tel Aviv is built-up (50); Makhtesh Ramon is bare (60); the Jezreel and
  Hula valleys are cropland (40). Each is the majority class (≥ 70%) of a
  roughly 150 m window;
* the 30 N seam: a boundary point belongs to N27E033 row 0, and a point
  outside every loaded window is synthetic;
* exact reassembly across internal tile edges on a generated TIFF, and
  rejection of LZW, predictors, projected CRSs, BigTIFF and stripped layouts.

Publisher checksums remain unverified, and the staging inventory is not a
runtime manifest. Remaining work: loading windows inside the application, an
OpenStreetMap extract for road and building overlays, live terrain-collision
session wiring (collision chunk to Rapier contact coupling is implemented in
TASK-065) and measured thermal validation.

## Global source and rights

The full global classification dataset is hosted in the public Amazon Web
Services (AWS) S3 bucket at `s3://esa-worldcover/v200/2021/map/`.
The [official ESA download guide](https://esa-worldcover.org/en/data-access)
documents this prefix. Its files are 3 by 3 degree tiles in Cloud Optimized
GeoTIFF format, a georeferenced raster format suitable for partial reads.
Tile names identify their southwest corner; for example, `N48E009` starts at
48 degrees north and 9 degrees east. Select every tile intersecting the desired
region; a country's borders generally do not follow tile edges.

WorldCover is distributed under Creative Commons Attribution 4.0. Preserve the
dataset citation and required acknowledgement from the
[official dataset repository](https://github.com/ESA-WorldCover/esa-worldcover-datasets).
Follow the existing [terrain licensing policy](../decisions/terrain-licensing.md)
for any later cache or redistribution configuration. These WorldCover download
instructions grant no permissions for Google tiles or other providers.

## Human operator procedure

These are manual operator commands, not an application startup step or an agent
download job. Keep large rasters outside the Git checkout. The examples use a
user-owned data directory; choose a sufficiently sized external disk instead
when needed.

### 1. Prepare the machine and install AWS CLI v2

Prerequisites: a supported Windows or macOS machine, Internet access to the
public bucket, write access to the destination and enough disk space for the
selected files plus decoding intermediates. Global acquisition is much larger
than an Israel subset; inspect the inventory before committing disk or bandwidth.
The system-wide installers below require administrator approval. Follow the
[official AWS installation guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
for supported systems or an alternative installation method.

Windows PowerShell:

```powershell
msiexec.exe /i https://awscli.amazonaws.com/AWSCLIV2.msi
```

Complete the installer, open a fresh PowerShell window, then run:

```powershell
aws --version
$worldcoverDir = Join-Path $env:USERPROFILE 'MirageData/WorldCover/v200/2021/map'
New-Item -ItemType Directory -Force -Path $worldcoverDir | Out-Null
```

macOS Terminal (zsh):

```zsh
curl -fL "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "$TMPDIR/AWSCLIV2.pkg"
sudo installer -pkg "$TMPDIR/AWSCLIV2.pkg" -target /
aws --version
worldcover_dir="$HOME/MirageData/WorldCover/v200/2021/map"
mkdir -p "$worldcover_dir"
```

Confirm that the version output starts with `aws-cli/2`. If `aws` is not found,
reopen the terminal and check the installation's executable search path.
Every bucket command below uses **`--no-sign-request`**: this open bucket accepts
anonymous requests, so no AWS account, access keys or `aws configure` step is
needed. This flag does not disable HTTPS certificate verification.

### 2. Select additional tiles

Define the new region's latitude/longitude bounds and select intersecting tiles
using the official product grid linked from the ESA download guide. The following
example selects `N48E009`, outside the current Israel scope. Replace the tile ID
with a reviewed tile for your intended region. Listing retrieves metadata only.

Windows PowerShell:

```powershell
$worldcoverTile = 'N48E009'
$worldcoverName = "ESA_WorldCover_10m_2021_v200_${worldcoverTile}_Map.tif"
aws s3 ls "s3://esa-worldcover/v200/2021/map/$worldcoverName" --no-sign-request
aws s3 cp "s3://esa-worldcover/v200/2021/map/$worldcoverName" "$worldcoverDir/" --no-sign-request --dryrun
```

macOS Terminal (zsh):

```zsh
worldcover_tile='N48E009'
worldcover_name="ESA_WorldCover_10m_2021_v200_${worldcover_tile}_Map.tif"
aws s3 ls "s3://esa-worldcover/v200/2021/map/$worldcover_name" --no-sign-request
aws s3 cp "s3://esa-worldcover/v200/2021/map/$worldcover_name" "$worldcover_dir/" --no-sign-request --dryrun
```

Confirm the listed object exists and its size fits the available space. Then
download it; repeat selection and copying for each additional tile.

Windows PowerShell:

```powershell
aws s3 cp "s3://esa-worldcover/v200/2021/map/$worldcoverName" "$worldcoverDir/" --no-sign-request
Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $worldcoverDir $worldcoverName)
```

macOS Terminal (zsh):

```zsh
aws s3 cp "s3://esa-worldcover/v200/2021/map/$worldcover_name" "$worldcover_dir/" --no-sign-request
shasum -a 256 "$worldcover_dir/$worldcover_name"
```

### 3. Optional: download the entire global map dataset

Use this alternative only when the operator intentionally needs global files.
It downloads the complete `map/` prefix for 2021 v200, not other years or
ancillary products elsewhere in the bucket. First list the object count and
total bytes, then preview pending transfers. A dry run transfers no raster data.
The summary command lists all objects remotely, so it can take time.

Windows PowerShell:

```powershell
aws s3 ls "s3://esa-worldcover/v200/2021/map/" --recursive --summarize --no-sign-request | Select-Object -Last 2
aws s3 sync "s3://esa-worldcover/v200/2021/map/" "$worldcoverDir/" --no-sign-request --dryrun
```

macOS Terminal (zsh):

```zsh
aws s3 ls "s3://esa-worldcover/v200/2021/map/" --recursive --summarize --no-sign-request | tail -n 2
aws s3 sync "s3://esa-worldcover/v200/2021/map/" "$worldcover_dir/" --no-sign-request --dryrun
```

After reviewing capacity and the preview, execute the transfer:

Windows PowerShell:

```powershell
aws s3 sync "s3://esa-worldcover/v200/2021/map/" "$worldcoverDir/" --no-sign-request
```

macOS Terminal (zsh):

```zsh
aws s3 sync "s3://esa-worldcover/v200/2021/map/" "$worldcover_dir/" --no-sign-request
```

Keep the same destination when rerunning an interrupted sync. It skips files
that its comparison considers unchanged; an incomplete object can be downloaded
again rather than resumed at its last byte. Sync is not a cryptographic integrity
audit. Save per-file SHA-256 hashes for the accepted inventory and compare with
trusted published checksums when supplied. See the
[AWS sync reference](https://docs.aws.amazon.com/cli/latest/reference/s3/sync.html)
for comparison rules and the anonymous-request flag.

### 4. Register and validate the new region

Keep a record of the source prefix, tile IDs, acquisition date, version, exact
hashes, license, attribution and geographic bounds. Decode the rasters and supply
their manifest to the TASK-069 material mapping path; the relevant contracts are
`packages/thermal/src/data-manifest.ts` and `packages/thermal/src/material-map.ts`.
Check known coordinates, tile seams and missing-data behavior, and preserve
synthetic labels for unavailable regions. Downloading files does not register them
automatically or enable terrain collision; decode windows with
`packages/thermal/src/geotiff.ts`.

Extend the documented Israel-only coverage only after the new region has been
integrated and validated, updating this guide and its Russian mirror together.
The bounded application tile planner remains bounded; manual global acquisition
does not remove its limits or enable automatic global prefetch. R2 persistence
still requires its own reviewed policy and deployment configuration (TASK-064).
