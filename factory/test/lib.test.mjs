import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, fillTemplate, findPrUrl, inWindow, nextWindowStart, parseLimitReset, parseResult, sessionDirName } from '../lib.mjs';

test('the usage limit message gives the next reset in local time', () => {
  const now = new Date(2026, 10, 24, 2, 40);
  const reset = parseLimitReset("You've hit your 5-hour limit · resets 3:20am (Europe/Sofia)", now);
  assert.deepEqual([reset.getDate(), reset.getHours(), reset.getMinutes()], [24, 3, 20]);
  const nextDay = parseLimitReset('You have hit your weekly limit · resets 1pm', new Date(2026, 10, 24, 15, 0));
  assert.deepEqual([nextDay.getDate(), nextDay.getHours()], [25, 13]);
  assert.equal(parseLimitReset('all good'), null);
});

test('a run is classified by what it left behind', () => {
  assert.equal(classify({ isError: true, text: "You've hit your 5-hour limit · resets 3:20am" }), 'limit');
  assert.equal(classify({ isError: false, text: 'PR: https://github.com/invoicely-organization/invoicely-agents/pull/9' }), 'done');
  assert.equal(classify({ isError: true, text: 'API Error: 500' }), 'error');
  assert.equal(classify({ isError: false, text: 'Blocked. Open question: may I write here?' }), 'needs_answer');
  assert.equal(findPrUrl('see (https://github.com/o/r/pull/12).'), 'https://github.com/o/r/pull/12');
});

test('the night window crosses midnight', () => {
  assert.equal(inWindow(new Date(2026, 10, 24, 23, 0), 22, 8), true);
  assert.equal(inWindow(new Date(2026, 10, 24, 7, 59), 22, 8), true);
  assert.equal(inWindow(new Date(2026, 10, 24, 12, 0), 22, 8), false);
  const start = nextWindowStart(new Date(2026, 10, 24, 12, 0), 22);
  assert.deepEqual([start.getDate(), start.getHours()], [24, 22]);
});

test('the JSON result is read, and plain text counts as an error', () => {
  const json = parseResult('noise\n{"type":"result","result":"done https://github.com/o/r/pull/3","is_error":false,"session_id":"s1","total_cost_usd":1.5,"num_turns":12}\n');
  assert.equal(json.sessionId, 's1');
  assert.equal(json.costUsd, 1.5);
  assert.equal(json.isError, false);
  const text = parseResult("You've hit your 5-hour limit · resets 3:20am");
  assert.equal(text.isError, true);
  assert.match(text.text, /limit/);
});

test('templates and session folders', () => {
  assert.equal(fillTemplate('{ISSUE} on {BRANCH} {OTHER}', { ISSUE: 'INV-31', BRANCH: 'inv-31-reviewer' }), 'INV-31 on inv-31-reviewer {OTHER}');
  assert.equal(sessionDirName('/Users/yoan/projects/ia-wt/inv-31-reviewer'), '-Users-yoan-projects-ia-wt-inv-31-reviewer');
});
