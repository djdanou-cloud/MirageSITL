# WorldCover coverage and manual region downloads

English source. [Russian mirror](../ru/worldcover-data.md).

## Current geographic boundary

MirageSITL's current terrain classification coverage for **ESA WorldCover 2021
v200 is restricted exclusively to Israel**. This is the project geographic
scope specified by the operator, not a limitation of the global source dataset.
Regions outside Israel require deliberate acquisition and integration before
they can be included in supported classification coverage. Source tiles crossing
a national boundary do not extend the supported region into neighboring countries.

This boundary does not establish that production ingestion is complete. TASK-069
has synthetic mapping tests; real GeoTIFF decoding, local dataset registration
and real-coordinate validation remain separate requirements. Missing data must
retain its synthetic/unavailable label. WorldCover supplies land classes, not
ground elevation, measured temperature or camera calibration.

## Supplied Israel tiles: TASK-069 handoff

On 2026-10-17 the operator supplied three files for repository storage:
`ESA_WorldCover_10m_2021_v200_N27E033_Map.tif`,
`ESA_WorldCover_10m_2021_v200_N30E033_Map.tif` and
`ESA_WorldCover_10m_2021_v200_N33E033_Map.tif`.
They are stored unchanged in `data/worldcover/2021-v200/israel/`, with a
[staging inventory](../../data/worldcover/2021-v200/israel/inventory.json)
recording exact bytes, SHA-256 hashes, product source URLs, license and
attribution. Together they contain 90,313,215 bytes. Repository copies match
the operator's source files; publisher checksums and raster content have not
been independently validated. The receipt date is not an inferred acquisition
date. This inventory is a handoff record, not the runtime `DataManifest`.

The operator explicitly authorized storing these three binary files in Git.
The outside-checkout recommendation below continues to apply to future bulk
downloads. Tile storage does not extend supported coverage outside Israel.

**Implementation is deferred at the operator's request.** When subsequently
authorized to start TASK-069, the developer should:

1. Read TASK-069, its dependencies and the current material-map contracts.
   Verify inventory hashes after checkout and inspect raster metadata, coordinate
   reference system, bounds, category codes, missing-data values and resolution.
2. Implement the missing GeoTIFF decoder and adapt the real layers to
   `packages/thermal/src/data-manifest.ts` and `material-map.ts`, preserving
   source identity, hashes, license and attribution. The inventory is not an
   automatically loaded runtime manifest.
3. Add independent known-coordinate, tile-boundary and missing-data checks;
   retain the existing synthetic regressions and Israel-only coverage boundary.
4. Obtain a suitable OpenStreetMap extract separately if road/building overlays
   are required; these WorldCover files do not supply those vector features.
5. Run affected tests and documentation gates, update both languages, and
   record real-data evidence before changing acceptance status.

No decoder, application wiring, raster validation or TASK-069 implementation
was started as part of this handoff. Production terrain collision and thermal
validation remain separate tasks.

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
download job. No dataset is fetched by this documentation change. Keep large
rasters outside the Git checkout. The examples use a user-owned data directory;
choose a sufficiently sized external disk instead when needed.

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
synthetic labels for unavailable regions. Downloading files does not implement
the missing decoder, register them automatically or enable terrain collision.

Extend the documented Israel-only coverage only after the new region has been
integrated and validated, updating this guide and its Russian mirror together.
The bounded application tile planner remains bounded; manual global acquisition
does not remove its limits or enable automatic global prefetch. R2 persistence
still requires its own reviewed policy and deployment configuration (TASK-064).
