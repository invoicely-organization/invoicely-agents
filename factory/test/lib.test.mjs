import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, fillTemplate, findPrUrl, isLimitText, parseLimitReset, parseOutcome, parseResult, retryAt, sessionDirName } from '../lib.mjs';

test('the usage limit message gives the next reset in local time', () => {
  const now = new Date(2026, 10, 24, 2, 40);
  const reset = parseLimitReset("You've hit your 5-hour limit · resets 3:20am (Europe/Sofia)", now);
  assert.deepEqual([reset.getDate(), reset.getHours(), reset.getMinutes()], [24, 3, 20]);
  const nextDay = parseLimitReset('You have hit your weekly limit · resets 1pm', new Date(2026, 10, 24, 15, 0));
  assert.deepEqual([nextDay.getDate(), nextDay.getHours()], [25, 13]);
  assert.equal(parseLimitReset('all good'), null);
});

test('every way Claude says the Max limit counts as the limit, also without a reset time (25.11: "Credit balance is too low")', () => {
  assert.equal(isLimitText('Credit balance is too low'), true);
  assert.equal(isLimitText("You've hit your 5-hour limit · resets 3:20am"), true);
  assert.equal(isLimitText('API Error: 529 {"type":"overloaded_error"}'), true);
  assert.equal(isLimitText('TypeError: x is undefined'), false);
  assert.equal(isLimitText('Added a rate limit to /login'), false);
  const now = new Date(2026, 10, 25, 14, 0);
  assert.equal(retryAt('Credit balance is too low', now).getTime(), now.getTime() + 60 * 60 * 1000);
});

test('a session ends with a RESULT line; the text before it is its report', () => {
  assert.deepEqual(parseOutcome('Wrote 3 tests.\nAll fail as expected.\nRESULT: DONE'), { kind: 'DONE', report: 'Wrote 3 tests.\nAll fail as expected.' });
  assert.equal(parseOutcome('x.test.ts:12 expects euros\n\n**RESULT:** TEST_WRONG\n').kind, 'TEST_WRONG');
  assert.equal(parseOutcome('The test is right.\nRESULT: KEEP').kind, 'KEEP');
  assert.equal(parseOutcome('RESULT: DONE\nmore lines\nand more\nand more\nand more\nand more').kind, null, 'only the last lines count');
});

test('a run is classified by what it left behind', () => {
  assert.equal(classify({ isError: true, text: "You've hit your 5-hour limit · resets 3:20am" }), 'limit');
  assert.equal(classify({ isError: true, text: 'Credit balance is too low' }), 'limit');
  assert.equal(classify({ isError: true, text: 'API Error: 500' }), 'error');
  assert.equal(classify({ isError: false, text: 'Done.\nRESULT: DONE' }), 'done');
  assert.equal(classify({ isError: false, text: 'Bad test.\nRESULT: TEST_WRONG' }), 'test_wrong');
  assert.equal(classify({ isError: false, text: 'May I write here?\nRESULT: QUESTION' }), 'question');
  assert.equal(classify({ isError: false, text: 'Stopped without a result line' }), 'question', 'nothing is lost: Yoan sees it');
  assert.equal(classify({ isError: false, text: 'Добавих rate limit на /login (429) и overloaded сигнатури.\nRESULT: DONE' }), 'done', 'a finished report is not the limit');
  assert.equal(findPrUrl('see (https://github.com/o/r/pull/12).'), 'https://github.com/o/r/pull/12');
});

test('the JSON result is read, and plain text counts as an error', () => {
  const json = parseResult('noise\n{"type":"result","result":"done\\nRESULT: DONE","is_error":false,"session_id":"s1","total_cost_usd":1.5,"num_turns":12}\n');
  assert.equal(json.sessionId, 's1');
  assert.equal(json.costUsd, 1.5);
  assert.equal(json.isError, false);
  const text = parseResult("You've hit your 5-hour limit · resets 3:20am");
  assert.equal(text.isError, true);
  assert.match(text.text, /limit/);
});

test('templates and session folders', () => {
  assert.equal(fillTemplate('{ISSUE} on {BRANCH} {OTHER}', { ISSUE: 'INV-31', BRANCH: 'inv-31-reviewer' }), 'INV-31 on inv-31-reviewer {OTHER}');
  assert.equal(sessionDirName('/Users/yoan/projects/invoicely/.claude/worktrees/inv-70-x'), '-Users-yoan-projects-invoicely--claude-worktrees-inv-70-x');
});
