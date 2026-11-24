#!/usr/bin/env bash
# Prints the agents whose evals must run for the changes between BASE and HEAD.
# A change to an agent or its evals runs that agent; a change to anything every
# run shares (templates, the eval workspace, skills, policies, hooks) runs all.
set -euo pipefail
base="${1:?usage: changed-agents.sh <base-ref>}"
changed="$(git diff --name-only "$base" HEAD)"
if printf '%s\n' "$changed" | grep -qE '^(templates/|fixtures/eval-workspace/|skills/|policies/|hooks/|\.claude-plugin/)'; then
  find agents -maxdepth 1 -name '*.md' | sed -E 's#^agents/(.*)\.md$#\1#' | sort
  exit 0
fi
printf '%s\n' "$changed" | sed -nE 's#^agents/([^/]+)\.md$#\1#p; s#^evals/([^/]+)/.*$#\1#p' | grep -v '^results$' | sort -u || true
