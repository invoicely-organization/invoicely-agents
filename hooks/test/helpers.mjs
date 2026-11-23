import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const hooksDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Runs a hook script the way Claude Code does: JSON on stdin, decision on stdout.
export function runHook(script, input, env = {}) {
  const result = spawnSync(process.execPath, [path.join(hooksDir, script)], {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  const out = result.stdout.trim();
  const decision = out ? JSON.parse(out).hookSpecificOutput : undefined;
  return { code: result.status, denied: decision?.permissionDecision === 'deny', reason: decision?.permissionDecisionReason ?? '' };
}

export function tempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function writePolicy(dir, text) {
  const file = path.join(dir, 'role-guard.yaml');
  writeFileSync(file, text);
  return file;
}
