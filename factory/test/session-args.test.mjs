// INV-70: runner sessions start without Yoan's personal ~/.claude/settings.json.
// Contract (proposed by test-author, the task allows "a pure function in factory/lib.mjs"):
//   sessionArgs({ role, prompt, pluginDir, sandboxFile, resume }) -> string[]
//   the argv runSession passes to `claude` (without the binary itself).
//   role: 'test-author' | 'implementer'; resume: a session id for a continued session, or undefined for a new one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as lib from '../lib.mjs';

const FACTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLUGIN_DIR = '/Users/yoandimitrov/.invoicely/plugin';
const SANDBOX_FILE = '/Users/yoandimitrov/projects/invoicely-agents/factory/sandbox.json';
const RESUME_ID = '3f2c9a7e-5b41-4d8e-9c06-1a7d2e4b8f53';
const PROMPT = 'You are test-author for the Linear task INV-70. Write the tests.';

function argsFor(role, resume) {
  assert.equal(typeof lib.sessionArgs, 'function', 'factory/lib.mjs must export sessionArgs (INV-70 Agent notes)');
  const args = lib.sessionArgs({ role, prompt: PROMPT, pluginDir: PLUGIN_DIR, sandboxFile: SANDBOX_FILE, resume });
  assert.ok(Array.isArray(args) && args.every((a) => typeof a === 'string'), 'sessionArgs returns an argv of strings');
  return args;
}

function valuesOf(args, flag) {
  const out = [];
  args.forEach((a, i) => {
    if (a === flag) out.push(args[i + 1]);
    else if (a.startsWith(`${flag}=`)) out.push(a.slice(flag.length + 1));
  });
  return out;
}

const SESSIONS = [
  ['test-author', 'new', undefined],
  ['test-author', 'continued', RESUME_ID],
  ['implementer', 'new', undefined],
  ['implementer', 'continued', RESUME_ID],
];

// INV-70 check 1: every runner session (test-author and implementer, new and continued) starts with --setting-sources project,local.
for (const [role, kind, resume] of SESSIONS) {
  test(`check 1: a ${kind} ${role} session starts with --setting-sources project,local, without the user settings`, () => {
    const args = argsFor(role, resume);
    assert.deepEqual(valuesOf(args, '--setting-sources'), ['project,local']); // check 1: exactly once, exactly "project,local"
  });
}

// INV-70 check 2: the test checks the arguments, including this flag, --agent, --settings with the sandbox and --plugin-dir.
for (const [role, kind, resume] of SESSIONS) {
  test(`check 2: a ${kind} ${role} session gets --agent ${role}, --settings with the sandbox and --plugin-dir`, () => {
    const args = argsFor(role, resume);
    const agent = valuesOf(args, '--agent');
    assert.equal(agent.length, 1, '--agent once'); // check 2
    assert.match(agent[0], new RegExp(`^(invoicely-agents:)?${role}$`)); // check 2: the role's agent from the invoicely-agents plugin
    assert.deepEqual(valuesOf(args, '--settings'), [SANDBOX_FILE]); // check 2: --settings with the sandbox
    assert.deepEqual(valuesOf(args, '--plugin-dir'), [PLUGIN_DIR]); // check 2: --plugin-dir
  });
}

// INV-70 check 1 ("new and continued"): a continued session resumes its own session id, a new one does not resume.
test('check 1: a continued session resumes the given session id and a new one resumes nothing, both with project,local', () => {
  const continued = argsFor('implementer', RESUME_ID);
  assert.deepEqual(valuesOf(continued, '--resume'), [RESUME_ID]); // check 1: continued session
  assert.deepEqual(valuesOf(continued, '--setting-sources'), ['project,local']); // check 1
  const fresh = argsFor('implementer', undefined);
  assert.deepEqual(valuesOf(fresh, '--resume'), []); // check 1: new session
  assert.ok(!fresh.includes('--continue'), 'a new session does not continue an old one');
});

// INV-70 check 1: runSession in factory/factory.mjs launches every session with these arguments, not a hand-built list.
test('check 1: runSession in factory.mjs builds its claude arguments with sessionArgs from lib.mjs', () => {
  const src = fs.readFileSync(path.join(FACTORY, 'factory.mjs'), 'utf8');
  assert.ok(/import\s*\{[^}]*\bsessionArgs\b[^}]*\}\s*from\s*['"]\.\/lib\.mjs['"]/.test(src), 'factory.mjs imports sessionArgs from ./lib.mjs'); // check 1
  assert.ok(/\bsessionArgs\s*\(/.test(src), 'factory.mjs calls sessionArgs'); // check 1
});
