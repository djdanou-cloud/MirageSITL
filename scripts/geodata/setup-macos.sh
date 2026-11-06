#!/usr/bin/env bash
# TASK-186 terrain toolchain for macOS on Apple Silicon, installed in user space (no sudo, no Homebrew).
#
#   bash scripts/geodata/setup-macos.sh
#
# Installs, under $MIRAGE_GEO_HOME (default ~/.mirage-geo):
#   * micromamba and an environment "mirage-geo" with GDAL, PROJ and the Python packages
#     build_terrain.py uses (numpy, pyproj, pydelatin, quantized-mesh-encoder);
#   * the EGM2008 2.5' geoid grid (us_nga_egm08_25.tif) in the PROJ data dir.
# Re-running is safe: finished steps are skipped. The versions are those of setup-wsl.sh, which also
# prepares the buildings; this one prepares the terrain only. The solved conda packages are recorded
# as an explicit lock in $GEO_HOME.
set -euo pipefail

GEO_HOME="${MIRAGE_GEO_HOME:-$HOME/.mirage-geo}"
MAMBA_VERSION="2.9.0-0"
ENV_NAME="mirage-geo"
mkdir -p "$GEO_HOME/bin"
export MAMBA_ROOT_PREFIX="$GEO_HOME/mamba"

if [ ! -x "$GEO_HOME/bin/micromamba" ]; then
  echo "== micromamba $MAMBA_VERSION"
  curl -fsSL "https://github.com/mamba-org/micromamba-releases/releases/download/${MAMBA_VERSION}/micromamba-osx-arm64" -o "$GEO_HOME/bin/micromamba"
  chmod +x "$GEO_HOME/bin/micromamba"
fi
MM="$GEO_HOME/bin/micromamba"

if [ ! -d "$MAMBA_ROOT_PREFIX/envs/$ENV_NAME" ]; then
  echo "== conda-forge environment $ENV_NAME"
  "$MM" create -y -n "$ENV_NAME" -c conda-forge --strict-channel-priority python=3.12 gdal numpy pyproj pip
  # Record the solved package set; reinstall with: micromamba create -n NAME --file <lock>.
  "$MM" env export -n "$ENV_NAME" --explicit > "$GEO_HOME/mirage-geo.lock.txt"
fi
"$MM" run -n "$ENV_NAME" python -m pip install --quiet --disable-pip-version-check \
  "pydelatin==0.4.0" "quantized-mesh-encoder==0.5.0"

PROJ_DIR="$MAMBA_ROOT_PREFIX/envs/$ENV_NAME/share/proj"
if [ ! -f "$PROJ_DIR/us_nga_egm08_25.tif" ]; then
  echo "== EGM2008 geoid grid"
  curl -fsSL https://cdn.proj.org/us_nga_egm08_25.tif -o "$PROJ_DIR/us_nga_egm08_25.tif.part"
  mv "$PROJ_DIR/us_nga_egm08_25.tif.part" "$PROJ_DIR/us_nga_egm08_25.tif"
fi

"$MM" run -n "$ENV_NAME" python -I -c "from osgeo import gdal; import pydelatin, quantized_mesh_encoder, numpy, pyproj; print('GDAL', gdal.__version__, 'PROJ', pyproj.proj_version_str)"
