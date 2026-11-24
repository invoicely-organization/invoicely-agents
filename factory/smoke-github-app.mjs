#!/usr/bin/env node
// Smoke test on the Mac: a session env as the bot can read with gh, authenticate a push (dry run) and commits as the bot.
// Prints no secret. Run from a worktree of invoicely-agents: node factory/smoke-github-app.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appSettings, installationToken, sessionEnv, stateDir, writeGhConfig } from './github-app.mjs';

const app = appSettings();
if (!app) throw new Error('githubApp is not set in ~/.invoicely/config.json');
const ghConfigDir = path.join(stateDir(), 'gh-bot');
writeGhConfig(ghConfigDir, await installationToken(app), app.slug);
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'github-app.mjs');
const env = sessionEnv(process.env, { ...app, ghConfigDir, helperCommand: `!'${process.execPath}' '${script}' git-credential` });

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { env, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`.replace(/gh[sopu]_[A-Za-z0-9]+/g, '<token>').trim();
  console.log(`$ ${cmd} ${args.join(' ')}\n  exit ${r.status}: ${out.split('\n').slice(0, 4).join(' | ')}`);
  return r.status;
};

let failed = 0;
failed += run('gh', ['api', '/installation/repositories', '--jq', '[.repositories[].full_name] | join(", ")']) !== 0;
failed += run('gh', ['pr', 'list', '-R', 'invoicely-organization/invoicely-agents', '--limit', '1']) !== 0;
failed += run('git', ['var', 'GIT_AUTHOR_IDENT']) !== 0;
failed += run('git', ['push', '--dry-run', 'origin', 'HEAD:refs/heads/smoke-bot-dry-run']) !== 0;
process.exit(failed ? 1 : 0);
