import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Every function the runner calls by name is defined or imported in factory.mjs. On 25.11 a function lost while
// moving code (guardViolations) stopped INV-69 after its first session: node --check does not see it, and no other
// test runs the runner's steps.
// Limit: names are collected for the whole file, not per scope, so a lost function that shares its name with a
// parameter or a local somewhere else is not found. A real parser would close that gap; this repo has no dependencies.
const FACTORY = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'factory.mjs');
const BUILTIN = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'super',
  'Date', 'Error', 'Set', 'Map', 'Promise', 'Number', 'String', 'Boolean', 'Object', 'Array', 'RegExp', 'Symbol',
  'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent',
]);

// The code without comments, string text, template text and regex literals, but with every ${...} expression of a
// template kept, nested templates included.
function codeOnly(src) {
  let out = '';
  let i = 0;
  const stack = []; // 'tpl' while in template text, a number (brace depth) while in a ${...} expression
  const lastSignificant = () => out.replace(/\s+$/, '').slice(-1);
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (stack.at(-1) === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); out += '``'; i += 1; continue; }
      if (c === '$' && next === '{') { stack.push(0); out += ' '; i += 2; continue; }
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && next === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
    if (c === '\'' || c === '"') {
      i += 1;
      while (i < src.length && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      out += "''";
      i += 1;
      continue;
    }
    if (c === '`') { stack.push('tpl'); i += 1; continue; }
    if (c === '/' && (!lastSignificant() || '(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant()) || /\breturn$/.test(out.trimEnd()))) {
      let inClass = false;
      i += 1;
      while (i < src.length && (inClass || src[i] !== '/') && src[i] !== '\n') {
        if (src[i] === '\\') i += 1;
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        i += 1;
      }
      i += 1;
      while (/[a-z]/.test(src[i] ?? '')) i += 1;
      out += '/r/';
      continue;
    }
    if (typeof stack.at(-1) === 'number') {
      if (c === '{') stack[stack.length - 1] += 1;
      if (c === '}') {
        if (stack.at(-1) === 0) { stack.pop(); out += ' '; i += 1; continue; }
        stack[stack.length - 1] -= 1;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

function undefinedCalls(source) {
  const code = codeOnly(source);
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

test('the check finds a lost function, also when it is called only inside ${...} of a template', () => {
  const source = fs.readFileSync(FACTORY, 'utf8');
  assert.deepEqual(undefinedCalls(source.replace(/function guardViolations\(/, 'function guardViolationsGone(')), ['guardViolations']);
  // cleanupSummary is imported and called only inside template expressions (`... ${cleanupSummary(plan, done)}`).
  assert.deepEqual(undefinedCalls(source.replace(/cleanupSummary, /, '')), ['cleanupSummary']);
  assert.deepEqual(undefinedCalls('const a = `x ${b(`y ${lost(1)}`)} z`; function b() {}'), ['lost']);
});

test('strings, comments and regex literals are not code', () => {
  assert.deepEqual(undefinedCalls("const s = 'Bash(git status:*)'; // call(1)\nconst r = /^[\"']|x(y)/g; /* nope() */"), []);
});
