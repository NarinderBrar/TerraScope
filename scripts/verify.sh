#!/usr/bin/env bash
#
# Run every check that does not need network access, and fail on the first
# problem.
#
# The GPU parity run is the one that matters most and the one most likely to be
# skipped, so it is not optional and not behind a flag. It needs a Chrome
# binary; override with CHROME=/path/to/chrome if it is not at the default.
#
#   ./scripts/verify.sh
#
# Exits non-zero if anything fails, so it is usable in CI as-is.

set -euo pipefail

cd "$(dirname "$0")/.."

PY="${PYTHON:-services/raster/.venv/bin/python}"
export PYTHONPATH=services/raster

step() {
  printf '\n\033[1m==> %s\033[0m\n' "$1"
}

if [[ ! -x "$PY" ]]; then
  echo "python not found at $PY; set PYTHON=/path/to/python" >&2
  exit 1
fi

step "Python: offline tests (network tests excluded)"
"$PY" -m pytest tests -q -p no:cacheprovider -m "not network"

step "TypeScript: contracts"
(cd packages/contracts && npx tsc --noEmit)

step "TypeScript: web"
npm run --silent typecheck

step "Web: unit and JS/Python parity tests"
npm test --silent

step "WebGPU: parity in a real browser"
# This compiles both WGSL shaders and compares GPU output against the Python
# reference on a real WebGPU implementation. Skipping it is how a 16-binding
# layout that cannot run on any conformant device shipped in the first place.
npm run --silent test:gpu

printf '\n\033[1;32mAll checks passed.\033[0m\n'
printf 'Network integration tests are not included; run them with:\n'
printf '  PYTHONPATH=services/raster %s -m pytest tests -m network\n' "$PY"
