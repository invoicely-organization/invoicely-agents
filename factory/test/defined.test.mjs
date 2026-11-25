import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Every function the runner calls by name is defined or imported in factory.mjs. On 25.11 a function lost while
// moving code (guardViolations) stopped INV-69 after its first session: node --check does not see it, and no other
// test runs the runner's steps.
const FACTORY = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'factory.mjs');
const BUILTIN = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'super',
  'Date', 'Error', 'Set', 'Map', 'Promise', 'Number', 'String', 'Boolean', 'Object', 'Array', 'RegExp', 'Symbol',
  'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent',
]);

export function undefinedCalls(source) {
  const code = source
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''")
    .replace(/\/\/.*$/gm, '');
  const defined = new Set();
  const names = (list) => list.split(',').map((p) => p.replace(/[{}[\].\s]|=.*$/gs, '').split(':').pop()).filter(Boolean);
  for (const [, name] of code.matchAll(/(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) defined.add(name);
  for (const [, name] of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(name);
  for (const [, list] of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) names(list).forEach((n) => defined.add(n));
  for (const [, list] of code.matchAll(/import\s*\{([^}]*)\}\s*from/g)) list.split(',').map((n) => n.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach((n) => defined.add(n));
  for (const [, name] of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) defined.add(name);
  for (const [, list] of code.matchAll(/\(([^()]*)\)\s*=>/g)) names(list).forEach((n) => defined.add(n));
  for (const [, name] of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) defined.add(name);
  for (const [, list] of code.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)) names(list).forEach((n) => defined.add(n));
  const called = new Set([...code.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
  return [...called].filter((name) => !defined.has(name) && !BUILTIN.has(name)).sort();
}

test('every function the runner calls by name is defined or imported', () => {
  assert.deepEqual(undefinedCalls(fs.readFileSync(FACTORY, 'utf8')), []);
});

test('the check finds a call to a function that is not there', () => {
  const source = fs.readFileSync(FACTORY, 'utf8').replace(/function guardViolations\(/, 'function guardViolationsGone(');
  assert.deepEqual(undefinedCalls(source), ['guardViolations']);
});
