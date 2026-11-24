import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { runHook, tempDir } from './helpers.mjs';

function repoOn(branch) {
  const dir = tempDir('main-guard-repo-');
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir });
  return dir;
}

const onMain = repoOn('main');
const onFeature = repoOn('inv-42-vat-cells');
const bash = (command, cwd = onFeature, agent = 'invoicely-agents:backend-engineer') => runHook('main-guard.mjs', {
  hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, agent_id: 'a1', agent_type: agent, tool_input: { command },
});

test('ordinary work on a task branch passes', () => {
  for (const command of [
    'git status',
    'git commit -m "INV-42: VAT cells for purchases without credit"',
    'git push -u origin inv-42-vat-cells',
    'git push origin HEAD',
    'gh pr create --fill',
    'gh pr view 12',
    'gh api repos/invoicely-organization/invoicely/branches/main/protection',
  ]) assert.equal(bash(command).denied, false, command);
});

test('pushing to main is blocked, explicitly or from the main branch', () => {
  assert.equal(bash('git push origin main').denied, true);
  assert.equal(bash('git push origin HEAD:main').denied, true);
  assert.equal(bash('git push', onMain).denied, true);
  assert.equal(bash('git push origin HEAD', onMain).denied, true);
  assert.equal(bash('pnpm test && git push origin main').denied, true);
});

test('force push and skipped hooks are blocked', () => {
  assert.equal(bash('git push --force origin inv-42-vat-cells').denied, true);
  assert.equal(bash('git push -f').denied, true);
  assert.equal(bash('git push --force-with-lease').denied, true);
  assert.equal(bash('git push origin +inv-42-vat-cells').denied, true);
  assert.equal(bash('git commit --no-verify -m "wip"').denied, true);
});

test('merging, approving and changing protection are blocked', () => {
  assert.equal(bash('gh pr merge 12 --squash').denied, true);
  assert.equal(bash('gh pr review 12 --approve').denied, true);
  assert.equal(bash('gh api -X PUT repos/o/r/pulls/12/merge').denied, true);
  assert.equal(bash('gh api -X DELETE repos/o/r/branches/main/protection').denied, true);
  assert.equal(bash('gh api repos/o/r/rulesets -f name=open').denied, true);
});

test('the main session is guarded too', () => {
  const result = runHook('main-guard.mjs', { tool_name: 'Bash', cwd: onFeature, tool_input: { command: 'gh pr merge 3' } });
  assert.equal(result.denied, true);
  assert.match(result.reason, /Only Yoan/);
});
