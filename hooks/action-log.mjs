#!/usr/bin/env node
// PostToolUse hook: one line per tool call of every agent, so that what an agent did can be read back later.
// Short and without secrets: the tool, the file or command it touched (cut to 300 characters, tokens and
// passwords replaced), who called it and whether it failed. One file a day in ~/.invoicely/audit (INV-39).
// It never blocks an agent: any error is swallowed.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const SECRET = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|lin_(?:api|oauth)_[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9._~+/-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$))/g;
const ASSIGNED = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi;

export function redact(text) {
  return String(text ?? '').replace(SECRET, '<redacted>').replace(ASSIGNED, '$1=<redacted>');
}

export function describe(tool, input = {}) {
  const pick = input.file_path ?? input.notebook_path ?? input.command ?? input.pattern ?? input.url ?? input.query
    ?? (input.subagent_type ? `${input.subagent_type}: ${input.description ?? ''}` : null)
    ?? Object.values(input).find((v) => typeof v === 'string') ?? '';
  return redact(pick).replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function failed(response) {
  if (!response || typeof response !== 'object') return false;
  return response.is_error === true || response.success === false || (typeof response.error === 'string' && response.error !== '');
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const dir = process.env.INVOICELY_ACTION_LOG_DIR || path.join(process.env.INVOICELY_HOME || path.join(homedir(), '.invoicely'), 'audit');
  const now = new Date();
  const line = {
    ts: now.toISOString(),
    session: input.session_id ?? null,
    agent: input.agent_type ?? 'main',
    tool: input.tool_name ?? '?',
    target: describe(input.tool_name, input.tool_input),
    failed: failed(input.tool_response),
    cwd: input.cwd ?? null,
  };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(path.join(dir, `${now.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    main();
  } catch {
    // the log must never stop an agent
  }
  process.exit(0);
}
