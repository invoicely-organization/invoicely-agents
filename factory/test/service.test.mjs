import assert from 'node:assert/strict';
import { test } from 'node:test';
import { servicePlist } from '../lib.mjs';

test('the launchd plist runs the runner from the repo under caffeinate, keeps it alive and logs to runner.log', () => {
  const plist = servicePlist({
    label: 'com.invoicely.runner', node: '/n/bin/node', script: '/p/invoicely-agents/factory/factory.mjs', cwd: '/p/invoicely-agents',
    logFile: '/h/.invoicely/logs/runner.log', pathEnv: '/n/bin:/usr/bin', home: '/h',
  });
  assert.match(plist, /<string>\/usr\/bin\/caffeinate<\/string>\s*<string>-i<\/string>\s*<string>\/n\/bin\/node<\/string>\s*<string>\/p\/invoicely-agents\/factory\/factory\.mjs<\/string>\s*<string>queue<\/string>\s*<string>run<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>INVOICELY_SERVICE<\/key>\s*<string>1<\/string>/);
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/h\/\.invoicely\/logs\/runner\.log<\/string>/);
  assert.match(plist, /<key>HOME<\/key>\s*<string>\/h<\/string>/);
});

test('values are escaped for XML', () => {
  const plist = servicePlist({ label: 'a&b', node: 'n', script: 's', cwd: '<c>', logFile: 'l', pathEnv: 'p', home: 'h' });
  assert.match(plist, /<string>a&amp;b<\/string>/);
  assert.match(plist, /<string>&lt;c&gt;<\/string>/);
});
