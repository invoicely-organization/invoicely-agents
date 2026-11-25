#!/usr/bin/env node
// PreToolUse hook for Write, Edit, MultiEdit and NotebookEdit.
// An agent may write only the paths policies/role-guard.yaml gives it. The role is INVOICELY_ROLE, which the runner
// sets for each of its sessions (test-author, implementer), so the whole session and its subagents have that role;
// otherwise the agent_type of a subagent. An interactive session with neither is not limited here.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bareAgentName, decideWrite, loadPolicy, relativeToProject } from './lib/policy.mjs';

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const policyFile = process.env.INVOICELY_ROLE_GUARD_POLICY || path.join(pluginRoot, 'policies', 'role-guard.yaml');

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `role guard: ${reason}. Do not work around this; say in your final report which file you need changed and why (a test that looks wrong goes back to test-author).`,
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

const role = process.env.INVOICELY_ROLE || input.agent_type;
if (!role) process.exit(0);
const agent = bareAgentName(role);

const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (typeof target !== 'string' || target === '') deny(`${agent} tried to write without a file path`);

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const relPath = relativeToProject(projectDir, target);
if (relPath === '' || relPath.startsWith('../') || relPath === '..' || path.isAbsolute(relPath)) {
  deny(`${target} is outside the project`);
}

let policy;
try {
  policy = loadPolicy(policyFile);
} catch (error) {
  deny(`policies/role-guard.yaml cannot be read (${error.message}), so no subagent may write`);
}

const decision = decideWrite(policy, agent, relPath);
if (!decision.allowed) deny(decision.reason);
process.exit(0);
