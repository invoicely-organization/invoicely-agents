#!/usr/bin/env bash
# Prepares an eval workspace that looks like this repo: templates, sample agents,
# a sample eval case, the bg-vat skill and the role guard policy.
# Called from a case's fixture.sh; the current directory is the run's workspace.
set -euo pipefail
SEED="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SEED/../.." && pwd)"
cp -R "$SEED/files/." .
# Sample eval cases are stored as *.tmpl so that the eval runner does not pick them up as cases of this repo.
find evals -name "*.tmpl" -type f | while read -r f; do mv "$f" "${f%.tmpl}"; done
mkdir -p templates .claude-plugin fixtures/eval-workspace
cp "$ROOT/templates/"*.md templates/
cp "$ROOT/.claude-plugin/plugin.json" .claude-plugin/
cp "$SEED/seed.sh" fixtures/eval-workspace/
