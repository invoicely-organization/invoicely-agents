#!/usr/bin/env bash
# test-author works in the product repo, so its cases start from a trimmed copy of it
# (evals/test-author/product-workspace) instead of fixtures/eval-workspace, then add the case's seed/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cp -R "$HERE/../product-workspace/." .
if [ -d "$HERE/seed" ]; then cp -R "$HERE/seed/." .; fi
