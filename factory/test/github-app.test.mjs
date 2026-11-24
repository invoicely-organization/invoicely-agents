import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { appJwt, credentialAnswer, ghHosts, installationToken, needsRefresh, sessionEnv, writeGhConfig } from '../github-app.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gh-app-'));

test('the app JWT is signed with the key and lives under ten minutes', () => {
  const jwt = appJwt(pem, 5907581, 1_000_000);
  const [header, payload, signature] = jwt.split('.');
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, signature, 'base64url'));
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.iss, '5907581');
  assert.ok(claims.exp - claims.iat <= 600);
});

test('a token is renewed when it is missing or has under ten minutes left', () => {
  const now = Date.parse('2026-11-24T20:00:00Z');
  assert.equal(needsRefresh(null, now), true);
  assert.equal(needsRefresh({ token: 't', expiresAt: '2026-11-24T20:09:00Z' }, now), true);
  assert.equal(needsRefresh({ token: 't', expiresAt: '2026-11-24T20:30:00Z' }, now), false);
});

test('a fresh cached token is reused, a stale one is fetched and cached with mode 600', async () => {
  const dir = tmp();
  const pemFile = path.join(dir, 'key.pem');
  fs.writeFileSync(pemFile, pem);
  const cacheFile = path.join(dir, 'cache', 'token.json');
  const nowMs = Date.parse('2026-11-24T20:00:00Z');
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.match(url, /\/app\/installations\/42\/access_tokens$/);
    assert.equal(init.method, 'POST');
    return { ok: true, json: async () => ({ token: 'ghs_new', expires_at: '2026-11-24T21:00:00Z' }) };
  };
  const args = { appId: 1, installationId: 42, pemFile, cacheFile, fetchImpl, nowMs };
  assert.equal(await installationToken(args), 'ghs_new');
  assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
  assert.equal(await installationToken(args), 'ghs_new');
  assert.equal(calls, 1);
  assert.equal(await installationToken({ ...args, nowMs: Date.parse('2026-11-24T20:55:00Z') }), 'ghs_new');
  assert.equal(calls, 2);
});

test('a refused token request fails with the GitHub message', async () => {
  const dir = tmp();
  const pemFile = path.join(dir, 'key.pem');
  fs.writeFileSync(pemFile, pem);
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) });
  await assert.rejects(
    installationToken({ appId: 1, installationId: 42, pemFile, cacheFile: path.join(dir, 't.json'), fetchImpl }),
    /401 Bad credentials/,
  );
});

test('the git credential helper answers only for https://github.com', () => {
  assert.equal(credentialAnswer('protocol=https\nhost=github.com\n', 'ghs_x'), 'username=x-access-token\npassword=ghs_x\n');
  assert.equal(credentialAnswer('protocol=https\nhost=gitlab.com\n', 'ghs_x'), '');
  assert.equal(credentialAnswer('protocol=http\nhost=github.com\n', 'ghs_x'), '');
});

test('the session env drops Yoan tokens, resets git helpers and sets the bot as author', () => {
  const env = sessionEnv(
    { PATH: '/usr/bin', GH_TOKEN: 'yoan', GITHUB_TOKEN: 'yoan', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'x', GIT_CONFIG_VALUE_0: 'y', GIT_CONFIG_KEY_3: 'z' },
    { slug: 'invoicely-agent-bot', botUserId: 360779810, ghConfigDir: '/state/gh-bot', helperCommand: '!node helper git-credential' },
  );
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GIT_CONFIG_KEY_3, undefined);
  assert.equal(env.GH_CONFIG_DIR, '/state/gh-bot');
  assert.equal(env.GIT_AUTHOR_NAME, 'invoicely-agent-bot[bot]');
  assert.equal(env.GIT_COMMITTER_EMAIL, '360779810+invoicely-agent-bot[bot]@users.noreply.github.com');
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.deepEqual([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0], ['credential.https://github.com.helper', '']);
  assert.deepEqual([env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1], ['credential.https://github.com.helper', '!node helper git-credential']);
  assert.equal(env.PATH, '/usr/bin');
});

test('the gh config holds only the bot token and is rewritten only when it changes', () => {
  const dir = path.join(tmp(), 'gh-bot');
  assert.equal(writeGhConfig(dir, 'ghs_1', 'invoicely-agent-bot'), true);
  assert.equal(writeGhConfig(dir, 'ghs_1', 'invoicely-agent-bot'), false);
  assert.equal(writeGhConfig(dir, 'ghs_2', 'invoicely-agent-bot'), true);
  const file = path.join(dir, 'hosts.yml');
  assert.equal(fs.readFileSync(file, 'utf8'), ghHosts('ghs_2', 'invoicely-agent-bot'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('ghs_1'));
});
