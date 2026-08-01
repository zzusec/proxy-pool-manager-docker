import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-connectivity-test-'));
const db = await import('../src/db.js');
const { applyTestResult } = await import('../src/services/connectivity.js');
db.initDb();

function add(id, port) {
  const proxy = {
    id,
    ip: '198.51.100.20',
    port,
    protocol: 'http',
    alive: null,
    source: 'test',
    tags: [],
  };
  db.createProxyAndEnqueue(proxy, 'test');
  return db.getProxyById(id);
}

test('definitive failures always delete, even with an obsolete disabled setting', () => {
  db.setSetting('autoDeleteDead', 'false');
  const failures = [
    { id: 'dead-direct', port: 8101, outcome: 'dead', error: 'ECONNREFUSED' },
    { id: 'tunnel-direct', port: 8102, outcome: 'tunnel_error', error: 'sing-box rejected the endpoint' },
  ];

  for (const failure of failures) {
    const proxy = add(failure.id, failure.port);
    const result = applyTestResult(proxy, { id: proxy.id, alive: false, outcome: failure.outcome, error: failure.error }, db.proxyEndpointKey(proxy));
    assert.equal(result.deleted, true);
    assert.equal(db.getProxyById(proxy.id), undefined);
    assert.equal(db.getDb().prepare('SELECT 1 FROM connectivity_queue WHERE proxy_id = ?').get(proxy.id), undefined);
  }
});

test('unsupported and inconclusive results remain in the pool', () => {
  const retained = [
    { id: 'unsupported', port: 8103, outcome: 'unsupported_protocol', error: '检测器不支持协议' },
    { id: 'missing-result', port: 8104, outcome: 'inconclusive', error: '检测未返回结果' },
    { id: 'target-502', port: 8105, outcome: 'inconclusive', error: 'HTTP 502 from target' },
  ];

  for (const item of retained) {
    const proxy = add(item.id, item.port);
    const result = applyTestResult(proxy, { id: proxy.id, alive: null, outcome: item.outcome, error: item.error }, db.proxyEndpointKey(proxy));
    const stored = db.getProxyById(proxy.id);
    assert.equal(result.deleted, false);
    assert.ok(stored);
    assert.equal(stored.alive, null);
    assert.equal(stored.last_test_outcome, item.outcome);
    assert.equal(stored.last_test_error, item.error);
    assert.equal(db.getDb().prepare('SELECT 1 FROM connectivity_queue WHERE proxy_id = ?').get(proxy.id), undefined);
  }
});

test('a stale failure cannot delete an endpoint edited during detection', () => {
  const original = add('edited-during-test', 8106);
  const oldKey = db.proxyEndpointKey(original);
  const edited = db.resetProxyConnectivityAndEnqueue({ ...original, port: 9106 }, 'endpoint_edit');

  const result = applyTestResult(original, { id: original.id, alive: false, outcome: 'dead', error: 'old endpoint failed' }, oldKey);
  assert.equal(result.superseded, true);
  assert.ok(db.getProxyById(original.id));
  assert.equal(db.getProxyById(original.id).port, 9106);
  assert.equal(db.getDb().prepare('SELECT status FROM connectivity_queue WHERE proxy_id = ?').get(original.id).status, 'pending');
  assert.equal(db.proxyEndpointKey(edited), db.proxyEndpointKey(db.getProxyById(original.id)));
});
