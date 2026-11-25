#!/usr/bin/env node
// PreToolUse hook for every tool (INV-51). Agents have no access to the secrets: the runner's keys and tokens in
// ~/.invoicely, the personal originals of the etalons, and the usual places of credentials on the Mac. On 25.11 a
// probe with the agents' permissions read a fake ~/.invoicely/github-app.pem with Read at the first try.
// Paths in a tool's input and in a Bash command are checked; the runner itself reads these files outside any session.
import { existsSync, readFileSync } from 'node:fs';
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
// The Mac's file system ignores case: ~/.INVOICELY/.ENV is the same file as ~/.invoicely/.env.
const fold = (p) => (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p);
// Folders and files that hold secrets or personal data.
const SECRET = [
  path.join(state, '.env'), path.join(state, 'github-app.pem'), path.join(state, 'cache'), path.join(state, 'gh-bot'),
  path.join(state, 'originals'), path.join(home, '.ssh'), path.join(home, '.config', 'gh'), path.join(home, '.aws'),
  path.join(home, '.claude', '.credentials.json'), path.join(home, 'Library', 'Keychains'),
].map(fold);
// Key and env files anywhere; a template like .env.example holds no secret.
const SECRET_FILE = /(^|\/)(\.env(?!\.(example|sample|template)$)(\.[\w.-]+)?|[^/]+\.pem|id_(rsa|ed25519|ecdsa)[^/]*)$/i;

const expand = (p) => p.replace(/^~(?=\/|$)/, home).replace(/\$HOME|\$\{HOME\}/g, home).replace(/\$INVOICELY_HOME|\$\{INVOICELY_HOME\}/g, state);
const resolve = (p) => path.resolve(input.cwd || process.cwd(), expand(p));

// Why a path is off limits: it is a secret, lies inside one, or holds one (a Grep, a listing or a diff of a folder
// above a secret prints it). null when it is fine.
function offLimits(p) {
  const full = fold(resolve(p));
  for (const s of SECRET) {
    if (full === s || full.startsWith(s + path.sep)) return `${p} is a secret`;
    if (s.startsWith(full.endsWith(path.sep) ? full : full + path.sep)) return `${p} holds ${s}`;
  }
  return SECRET_FILE.test(full) ? `${p} is a key or env file` : null;
}

const tool = input.tool_name ?? '';
const ti = input.tool_input ?? {};
for (const key of ['file_path', 'path', 'notebook_path']) {
  const why = typeof ti[key] === 'string' && offLimits(ti[key]);
  if (why) deny(`${tool}: ${why}`);
}
// A glob reaches everything under the part before its first wildcard.
const globRoot = (pattern) => {
  const at = pattern.search(/[*?[{]/);
  return at < 0 ? pattern : path.dirname(pattern.slice(0, at) + 'x');
};
for (const [key, value] of [['pattern', tool === 'Glob' ? ti.pattern : null], ['glob', ti.glob]]) {
  if (typeof value !== 'string') continue;
  const why = offLimits(value) ?? offLimits(globRoot(value));
  if (why) deny(`${tool} ${key}: ${why}`);
}

if (tool === 'Bash' && typeof ti.command === 'string') {
  // The text of a commit message, a PR title or body is not a path: "Read / Grep" in a title must pass.
  const command = expand(ti.command.replace(/(^|\s)(-m|--message|--title|--body)(\s+|=)("[^"]*"|'[^']*')/g, '$1$2 MESSAGE'));
  if (/\bsecurity\s+(find|dump|export)-/.test(command)) deny('reading the Keychain');
  for (const s of SECRET) if (fold(command).includes(s)) deny(`a command that touches ${s}`);
  // A path put together in code ($HOME + "/.invoicely/.env") still names its part under home.
  for (const s of SECRET) {
    const tail = path.relative(fold(home), s);
    const named = new RegExp(`(^|[/'"\\s~])${tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[/'"\\s;)])`);
    if (tail && !tail.startsWith('..') && named.test(fold(command))) deny(`a command that names ${tail}`);
  }
  // Every word that looks like a path is checked against the cwd. A key or env file only counts when it exists,
  // so that a commit message about ".env" passes; folders of secrets and the folders above them always count.
  for (const word of command.split(/[\s'"=<>|;&()]+/)) {
    if (!word || !/[/.~]/.test(word)) continue;
    const why = offLimits(word);
    if (why && (!why.endsWith('is a key or env file') || existsSync(resolve(word)))) deny(`a command where ${why}`);
  }
}
process.exit(0);
