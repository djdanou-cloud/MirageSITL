#!/usr/bin/env bash
# TASK-073 geodata toolchain for WSL/Linux, installed in user space (no sudo).
#
#   bash scripts/geodata/setup-wsl.sh
#
# Installs, under $MIRAGE_GEO_HOME (default ~/.mirage-geo):
#   * micromamba (statically linked) and an environment "mirage-geo" with GDAL,
#     PROJ, PostgreSQL + PostGIS and the Python packages the pipeline uses
#     (overturemaps, pydelatin, quantized-mesh-encoder, numpy, pyproj);
#   * the .NET 8 SDK (dotnet-install.sh) and pg2b3dm as a .NET tool;
#   * the EGM2008 2.5' geoid grid (us_nga_egm08_25.tif) in the PROJ data dir.
# Re-running is safe: finished steps are skipped. Versions are pinned below so
# the pipeline is reproducible; change them deliberately. Conda packages are
# solved by micromamba and recorded as an explicit lock in $GEO_HOME.
set -euo pipefail

GEO_HOME="${MIRAGE_GEO_HOME:-$HOME/.mirage-geo}"
MAMBA_VERSION="2.9.0-0"
PG2B3DM_VERSION="2.27.0"
DOTNET_CHANNEL="8.0"
ENV_NAME="mirage-geo"
mkdir -p "$GEO_HOME/bin"
export MAMBA_ROOT_PREFIX="$GEO_HOME/mamba"

if [ ! -x "$GEO_HOME/bin/micromamba" ]; then
  echo "== micromamba $MAMBA_VERSION"
  curl -fsSL "https://github.com/mamba-org/micromamba-releases/releases/download/${MAMBA_VERSION}/micromamba-linux-64" -o "$GEO_HOME/bin/micromamba"
  chmod +x "$GEO_HOME/bin/micromamba"
fi
MM="$GEO_HOME/bin/micromamba"

if [ ! -d "$MAMBA_ROOT_PREFIX/envs/$ENV_NAME" ]; then
  echo "== conda-forge environment $ENV_NAME"
  "$MM" create -y -n "$ENV_NAME" -c conda-forge --strict-channel-priority \
    python=3.12 gdal postgresql postgis numpy pyproj pip
  # Record the solved package set; reinstall with: micromamba create -n NAME --file <lock>.
  "$MM" env export -n "$ENV_NAME" --explicit > "$GEO_HOME/mirage-geo.lock.txt"
fi
"$MM" run -n "$ENV_NAME" python -m pip install --quiet --disable-pip-version-check \
  "overturemaps==1.0.2" "pydelatin==0.4.0" "quantized-mesh-encoder==0.5.0"

PROJ_DIR="$MAMBA_ROOT_PREFIX/envs/$ENV_NAME/share/proj"
if [ ! -f "$PROJ_DIR/us_nga_egm08_25.tif" ]; then
  echo "== EGM2008 geoid grid"
  curl -fsSL https://cdn.proj.org/us_nga_egm08_25.tif -o "$PROJ_DIR/us_nga_egm08_25.tif.part"
  mv "$PROJ_DIR/us_nga_egm08_25.tif.part" "$PROJ_DIR/us_nga_egm08_25.tif"
fi

DOTNET_ROOT="$GEO_HOME/dotnet"
if [ ! -x "$DOTNET_ROOT/dotnet" ]; then
  echo "== .NET SDK $DOTNET_CHANNEL"
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o "$GEO_HOME/dotnet-install.sh"
  bash "$GEO_HOME/dotnet-install.sh" --channel "$DOTNET_CHANNEL" --install-dir "$DOTNET_ROOT" --no-path
fi
# WSL Ubuntu has no system libicu and installing it needs sudo; the converters do not need culture data.
export DOTNET_ROOT DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
if [ ! -x "$GEO_HOME/tools/pg2b3dm" ]; then
  echo "== pg2b3dm $PG2B3DM_VERSION"
  "$DOTNET_ROOT/dotnet" tool install pg2b3dm --version "$PG2B3DM_VERSION" --tool-path "$GEO_HOME/tools"
fi

echo "== versions"
"$MM" run -n "$ENV_NAME" gdalinfo --version
"$MM" run -n "$ENV_NAME" projinfo 2>&1 | head -1 || true
"$MM" run -n "$ENV_NAME" postgres --version
"$MM" run -n "$ENV_NAME" python -c "import overturemaps, pydelatin, quantized_mesh_encoder; print('python packages ok')"
"$GEO_HOME/tools/pg2b3dm" --version || true
echo "Geodata toolchain ready in $GEO_HOME"
