import assert from 'node:assert/strict';
import test from 'node:test';

import { extractSupportedProxyLines } from '../src/services/subscription.js';
import { parseProxyLine } from '../src/utils/helpers.js';

function legacyVmessUri() {
  const uuid = '11111111-2222-3333-4444-555555555555';
  const payload = Buffer.from(`auto:${uuid}@node.example.com:16617`).toString('base64');
  return `vmess://${payload}?tfo=1&remark=${encodeURIComponent('日本-优化')}&alterId=0&obfs=websocket&path=%2Fws&obfsParam=cdn.example.com`;
}

test('legacy Shadowrocket VMess URI preserves websocket settings', () => {
  const parsed = parseProxyLine(legacyVmessUri());
  assert.equal(parsed.protocol, 'vmess');
  assert.equal(parsed.username, '11111111-2222-3333-4444-555555555555');
  assert.equal(parsed.ip, 'node.example.com');
  assert.equal(parsed.port, 16617);
  assert.equal(parsed.name, '日本-优化');
  assert.deepEqual(parsed.extra, {
    security: 'auto', net: 'ws', type: 'none', host: 'cdn.example.com', path: '/ws',
    tls: '', sni: 'cdn.example.com', alterId: 0, tfo: true,
  });
});

test('base64 subscription containing status text and legacy VMess nodes is importable', () => {
  const uri = legacyVmessUri();
  const subscription = Buffer.from(`STATUS=traffic info\r\n${uri}\r\n`).toString('base64');
  assert.deepEqual(extractSupportedProxyLines(subscription), [uri]);
});
