#!/usr/bin/env bash
# The reviewer works in the product repo, so its workspace holds only this case's
# brief, diff and changed files. bg-vat comes from the plugin, not the workspace.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cp -R "$HERE/seed/." .
