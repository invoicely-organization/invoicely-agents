#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
bash "$HERE/../../../fixtures/eval-workspace/seed.sh"
cp -R "$HERE/seed/." .
