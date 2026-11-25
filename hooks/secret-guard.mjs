#!/usr/bin/env node
// PreToolUse hook for every tool (INV-51). Agents have no access to the secrets: the runner's keys and tokens in
// ~/.invoicely, the personal originals of the etalons, and the usual places of credentials on the Mac. On 25.11 a
// probe with the agents' permissions read a fake ~/.invoicely/github-app.pem with Read at the first try.
// Paths in a tool's input and in a Bash command are checked; the runner itself reads these files outside any session.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `secret guard: ${reason}. Agents never read or change secrets; report what you need instead.`,
    },
  }));
  process.exit(0);
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  deny('the hook input could not be read');
}

const home = os.homedir();
const state = process.env.INVOICELY_HOME || path.join(home, '.invoicely');
// Folders and files that hold secrets or personal data.
const SECRET = [
  path.join(state, '.env'), path.join(state, 'github-app.pem'), path.join(state, 'cache'), path.join(state, 'gh-bot'),
  path.join(state, 'originals'), path.join(home, '.ssh'), path.join(home, '.config', 'gh'), path.join(home, '.aws'),
  path.join(home, '.claude', '.credentials.json'), path.join(home, 'Library', 'Keychains'),
];
// Key and env files anywhere; a template like .env.example holds no secret.
const SECRET_FILE = /(^|\/)(\.env(?!\.(example|sample|template)$)(\.[\w.-]+)?|[^/]+\.pem|id_(rsa|ed25519|ecdsa)[^/]*)$/;

const expand = (p) => p.replace(/^~(?=\/|$)/, home).replace(/\$HOME|\$\{HOME\}/g, home).replace(/\$INVOICELY_HOME|\$\{INVOICELY_HOME\}/g, state);
const isSecret = (p) => {
  const full = path.resolve(input.cwd || process.cwd(), expand(p));
  return SECRET.some((s) => full === s || full.startsWith(s + path.sep)) || SECRET_FILE.test(full);
};

const tool = input.tool_name ?? '';
const ti = input.tool_input ?? {};
for (const key of ['file_path', 'path', 'notebook_path']) {
  if (typeof ti[key] === 'string' && isSecret(ti[key])) deny(`${tool} on ${ti[key]}`);
}
if (tool === 'Glob' && typeof ti.pattern === 'string' && isSecret(ti.pattern)) deny(`Glob on ${ti.pattern}`);

if (tool === 'Bash' && typeof ti.command === 'string') {
  const command = expand(ti.command);
  if (/\bsecurity\s+(find|dump|export)-/.test(command)) deny('reading the Keychain');
  for (const s of SECRET) if (command.includes(s)) deny(`a command that touches ${s}`);
  // Relative and bare names: every word that looks like a path is checked against the cwd.
  for (const word of command.split(/[\s'"=<>|;&()]+/)) {
    if (word && /[/.~]/.test(word) && isSecret(word)) deny(`a command that touches ${word}`);
  }
}
process.exit(0);
