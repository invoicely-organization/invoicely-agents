#!/usr/bin/env node
// GitHub App identity for agent sessions: commits, pushes and PRs go out as invoicely-agent-bot[bot], not as Yoan.
// The private key stays in ~/.invoicely/github-app.pem. Installation tokens live one hour; they are cached
// in ~/.invoicely/cache and renewed ten minutes before they expire, so long sessions keep working.
//
//   node github-app.mjs check                 mint a token and list the repos the App can reach (prints no secret)
//   node github-app.mjs git-credential get    git credential helper, answers for https://github.com only
//   node github-app.mjs git-credential --token-file <file> get   the same with a token the runner wrote (INV-57)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export function appJwt(pem, appId, nowSeconds = Math.floor(Date.now() / 1000)) {
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) })}`;
  return `${unsigned}.${crypto.createSign('RSA-SHA256').update(unsigned).sign(pem, 'base64url')}`;
}

export function needsRefresh(cached, nowMs = Date.now(), marginMs = 10 * 60 * 1000) {
  if (!cached?.token || !cached.expiresAt) return true;
  return Date.parse(cached.expiresAt) - nowMs < marginMs;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function installationToken({ appId, installationId, pemFile, cacheFile, fetchImpl = fetch, nowMs = Date.now() }) {
  const cached = readJson(cacheFile);
  if (!needsRefresh(cached, nowMs)) return cached.token;
  const jwt = appJwt(fs.readFileSync(pemFile, 'utf8'), appId, Math.floor(nowMs / 1000));
  const response = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`GitHub App token: ${response.status} ${body.message}`);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cacheFile, JSON.stringify({ token: body.token, expiresAt: body.expires_at }), { mode: 0o600 });
  fs.chmodSync(cacheFile, 0o600);
  return body.token;
}

// git sends key=value lines on stdin; only https://github.com gets an answer, everything else is left to git.
export function credentialAnswer(input, token) {
  const fields = {};
  for (const line of input.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  if (fields.protocol !== 'https' || fields.host !== 'github.com') return '';
  return `username=x-access-token\npassword=${token}\n`;
}

export function botIdentity({ slug, botUserId }) {
  const name = `${slug}[bot]`;
  return { name, email: `${botUserId}+${name}@users.noreply.github.com` };
}

// The environment of an agent session that acts as the bot. Yoan's tokens are removed, the credential helpers
// from his git config are reset (an empty helper clears the list) and only the App helper is left.
export function sessionEnv(baseEnv, { slug, botUserId, ghConfigDir, helperCommand }) {
  const env = { ...baseEnv };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[key];
  env.GH_CONFIG_DIR = ghConfigDir;
  env.GH_PROMPT_DISABLED = '1';
  env.GH_NO_UPDATE_NOTIFIER = '1';
  for (const key of Object.keys(env)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
  const id = botIdentity({ slug, botUserId });
  env.GIT_AUTHOR_NAME = id.name;
  env.GIT_COMMITTER_NAME = id.name;
  env.GIT_AUTHOR_EMAIL = id.email;
  env.GIT_COMMITTER_EMAIL = id.email;
  env.GIT_CONFIG_COUNT = '2';
  env.GIT_CONFIG_KEY_0 = 'credential.https://github.com.helper';
  env.GIT_CONFIG_VALUE_0 = '';
  env.GIT_CONFIG_KEY_1 = 'credential.https://github.com.helper';
  env.GIT_CONFIG_VALUE_1 = helperCommand;
  return env;
}

// gh gets its own config dir with only the bot token in it, so it never falls back to Yoan's login.
// A PATH wrapper would not do: the session's shell runs ~/.zshrc, which puts /usr/local/bin first.
// The runner rewrites the file while the session runs, so gh always sees a token that is still valid.
export function ghHosts(token, slug) {
  const user = `${slug}[bot]`;
  return [
    'github.com:',
    '    git_protocol: https',
    `    user: ${user}`,
    `    oauth_token: ${token}`,
    '    users:',
    `        ${user}:`,
    `            oauth_token: ${token}`,
    '',
  ].join('\n');
}

export function writeGhConfig(dir, token, slug) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'hosts.yml');
  const next = ghHosts(token, slug);
  let current = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    // first write
  }
  if (current === next) return false;
  fs.writeFileSync(`${file}.tmp`, next, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return true;
}

export function stateDir() {
  return process.env.INVOICELY_HOME || path.join(os.homedir(), '.invoicely');
}

export function appSettings(state = stateDir()) {
  const app = readJson(path.join(state, 'config.json'))?.githubApp;
  if (!app?.appId || !app?.installationId || !app?.slug || !app?.botUserId) return null;
  return { ...app, pemFile: path.join(state, 'github-app.pem'), cacheFile: path.join(state, 'cache', 'github-app-token.json') };
}

// A file only the session's own token is in, written by the runner and readable by the session (INV-57).
export function writeTokenFile(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, token, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

async function cli(args) {
  const [command] = args;
  // In an agent session the helper runs inside the sandbox, which does not let it read ~/.invoicely: it answers
  // with the one-hour token the runner put in the session's folder, and never touches the App key (INV-57).
  const tokenAt = args.indexOf('--token-file');
  if (command === 'git-credential' && tokenAt >= 0) {
    const input = fs.readFileSync(0, 'utf8');
    if (args.at(-1) === 'get') process.stdout.write(credentialAnswer(input, fs.readFileSync(args[tokenAt + 1], 'utf8').trim()));
    return;
  }
  const operation = args[1];
  const app = appSettings();
  if (!app) throw new Error('githubApp is not set in ~/.invoicely/config.json');
  if (command === 'check') {
    const token = await installationToken(app);
    const response = await fetch('https://api.github.com/installation/repositories', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`${response.status} ${body.message}`);
    console.log(`${app.slug}[bot] reaches: ${body.repositories.map((r) => r.full_name).join(', ')}`);
    return;
  }
  if (command === 'git-credential') {
    const input = fs.readFileSync(0, 'utf8');
    if (operation === 'get') process.stdout.write(credentialAnswer(input, await installationToken(app)));
    return; // store and erase: nothing is kept
  }
  throw new Error('usage: github-app.mjs check | git-credential [--token-file <file>] <get|store|erase>');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  cli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`github-app: ${error.message}\n`);
    process.exit(1);
  });
}
