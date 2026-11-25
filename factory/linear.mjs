// Linear for the runner (INV-30). With LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET in ~/.invoicely/.env, the runner
// writes as the "Invoicely Agents" OAuth app (client credentials, app actor), so its comments and mentions reach Yoan's
// phone; with only LINEAR_API_KEY it writes as Yoan, as before. App tokens live 30 days and are cached.
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.linear.app/graphql';
const DAY = 24 * 3600 * 1000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function appToken({ clientId, clientSecret, cacheFile, fetchImpl = fetch, nowMs = Date.now(), fresh = false }) {
  const cached = readJson(cacheFile);
  if (!fresh && cached?.token && Date.parse(cached.expiresAt) - nowMs > DAY) return cached.token;
  const response = await fetchImpl('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'read,write' }).toString(),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(`Linear app token: ${response.status} ${body.error ?? body.message ?? ''}`.trim());
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cacheFile, JSON.stringify({ token: body.access_token, expiresAt: new Date(nowMs + body.expires_in * 1000).toISOString() }), { mode: 0o600 });
  fs.chmodSync(cacheFile, 0o600);
  return body.access_token;
}

// Returns linear(query, variables, { asYoan }) or null when there is no key at all.
export function linearClient({ env, cacheFile, fetchImpl = fetch }) {
  const hasApp = Boolean(env.LINEAR_CLIENT_ID && env.LINEAR_CLIENT_SECRET);
  if (!hasApp && !env.LINEAR_API_KEY) return null;
  const call = async (auth, query, variables) => {
    const response = await fetchImpl(API, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify({ query, variables }) });
    return { status: response.status, json: await response.json() };
  };
  const client = async (query, variables, { asYoan = false } = {}) => {
    let result;
    if (hasApp && !asYoan) {
      const args = { clientId: env.LINEAR_CLIENT_ID, clientSecret: env.LINEAR_CLIENT_SECRET, cacheFile, fetchImpl };
      result = await call(`Bearer ${await appToken(args)}`, query, variables);
      if (result.status === 401) result = await call(`Bearer ${await appToken({ ...args, fresh: true })}`, query, variables);
    } else {
      if (!env.LINEAR_API_KEY) throw new Error('LINEAR_API_KEY is needed to act as Yoan');
      result = await call(env.LINEAR_API_KEY, query, variables);
    }
    if (result.json.errors) throw new Error(JSON.stringify(result.json.errors));
    return result.json.data;
  };
  client.actor = hasApp ? 'app' : 'yoan';
  return client;
}

// A mention that notifies: a link to the user's profile in the comment, as the Linear editor writes it.
export function mention(user) {
  return user?.url ? `[@${user.displayName ?? user.name}](${user.url})` : '';
}
