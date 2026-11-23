// Reads policies/role-guard.yaml and decides whether an agent may write a path.
// The file uses a small, strict subset of YAML on purpose: an agent name on its own
// line, then "allow:" and "deny:" with JSON-style lists of quoted globs. Anything
// else is an error, and the guard then refuses every subagent write (fail closed).
import { readFileSync } from 'node:fs';

export function parsePolicy(text) {
  const policy = {};
  let current = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const agent = line.match(/^([A-Za-z0-9_-]+):$/);
    if (agent) {
      current = agent[1];
      if (policy[current]) throw new Error(`line ${index + 1}: agent "${current}" appears twice`);
      policy[current] = { allow: [], deny: [] };
      return;
    }
    const list = line.match(/^\s+(allow|deny):\s*(\[.*\])$/);
    if (list && current) {
      const globs = JSON.parse(list[2]);
      if (!Array.isArray(globs) || !globs.every((g) => typeof g === 'string' && g.length > 0)) {
        throw new Error(`line ${index + 1}: ${list[1]} must be a list of non-empty strings`);
      }
      policy[current][list[1]] = globs;
      return;
    }
    throw new Error(`line ${index + 1}: cannot read "${trimmed}"`);
  });
  return policy;
}

export function loadPolicy(file) {
  return parsePolicy(readFileSync(file, 'utf8'));
}

// "**/" matches any number of folders, "**" anything, "*" anything within one folder.
export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      const folder = glob[i + 2] === '/';
      source += folder ? '(?:.*/)?' : '.*';
      i += folder ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function matches(globs, relPath) {
  return globs.find((glob) => globToRegExp(glob).test(relPath));
}

// Agent names from plugins arrive as "plugin:agent"; the policy uses the bare name.
export function bareAgentName(agentType) {
  return agentType.includes(':') ? agentType.slice(agentType.lastIndexOf(':') + 1) : agentType;
}

export function decideWrite(policy, agent, relPath) {
  const entry = policy[agent];
  if (!entry) {
    return { allowed: false, reason: `agent "${agent}" has no entry in policies/role-guard.yaml, so it may not write anything` };
  }
  const denied = matches(entry.deny, relPath);
  if (denied) return { allowed: false, reason: `${relPath} matches deny "${denied}" for ${agent}` };
  if (matches(entry.allow, relPath)) return { allowed: true };
  const allowed = entry.allow.length > 0 ? entry.allow.join(', ') : 'nothing';
  return { allowed: false, reason: `${relPath} is outside the paths ${agent} may write (${allowed})` };
}
