import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { appToken, linearClient, mention } from '../linear.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'linear-')), 'token.json');
const ok = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });

test('the app token comes from client credentials with Basic auth, is cached with mode 600 and renewed a day before it ends', async () => {
  const cacheFile = tmp();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return ok({ access_token: `lin_oauth_${calls.length}`, expires_in: 30 * 24 * 3600 });
  };
  const now = Date.parse('2026-11-24T20:00:00Z');
  const args = { clientId: 'id', clientSecret: 'secret', cacheFile, fetchImpl, nowMs: now };
  assert.equal(await appToken(args), 'lin_oauth_1');
  assert.equal(calls[0].url, 'https://api.linear.app/oauth/token');
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
  assert.match(calls[0].init.body, /grant_type=client_credentials/);
  assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
  assert.equal(await appToken({ ...args, nowMs: now + 28 * 24 * 3600 * 1000 }), 'lin_oauth_1');
  assert.equal(await appToken({ ...args, nowMs: now + 29.5 * 24 * 3600 * 1000 }), 'lin_oauth_2');
});

test('the client writes as the app when it has client credentials, as Yoan otherwise, and retries once on 401', async () => {
  const seen = [];
  let first = true;
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/oauth/token')) return ok({ access_token: 'lin_oauth_x', expires_in: 3600 * 24 * 30 });
    seen.push(init.headers.Authorization);
    if (first && init.headers.Authorization.startsWith('Bearer')) { first = false; return ok({ errors: [{ message: 'expired' }] }, 401); }
    return ok({ data: { viewer: { name: 'x' } } });
  };
  const app = linearClient({ env: { LINEAR_CLIENT_ID: 'a', LINEAR_CLIENT_SECRET: 'b', LINEAR_API_KEY: 'lin_api_y' }, cacheFile: tmp(), fetchImpl });
  assert.equal(app.actor, 'app');
  assert.deepEqual(await app('{viewer{name}}'), { viewer: { name: 'x' } });
  assert.deepEqual(seen, ['Bearer lin_oauth_x', 'Bearer lin_oauth_x']);
  await app('{viewer{name}}', {}, { asYoan: true });
  assert.equal(seen.at(-1), 'lin_api_y');
  const yoan = linearClient({ env: { LINEAR_API_KEY: 'lin_api_y' }, cacheFile: tmp(), fetchImpl });
  assert.equal(yoan.actor, 'yoan');
  assert.equal(linearClient({ env: {}, cacheFile: tmp(), fetchImpl }), null);
});

test('a mention is a link to the profile', () => {
  assert.equal(mention({ displayName: 'yoan', url: 'https://linear.app/w/profiles/yoan' }), '[@yoan](https://linear.app/w/profiles/yoan)');
  assert.equal(mention(null), '');
});
