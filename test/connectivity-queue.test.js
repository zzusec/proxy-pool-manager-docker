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

test('confirmed failures auto-delete but inconclusive results remain', () => {
  db.setSetting('autoDeleteDead', 'true');
  const dead = add('dead-auto', 8101);
  const deadResult = applyTestResult(dead, { id: dead.id, alive: false, outcome: 'dead', error: 'ECONNREFUSED' }, db.proxyEndpointKey(dead));
  assert.equal(deadResult.deleted, true);
  assert.equal(db.getProxyById(dead.id), undefined);

  const unclear = add('unclear', 8102);
  const unclearResult = applyTestResult(unclear, { id: unclear.id, alive: null, outcome: 'inconclusive', error: 'HTTP 502 from target' }, db.proxyEndpointKey(unclear));
  assert.equal(unclearResult.deleted, false);
  assert.ok(db.getProxyById(unclear.id));
  assert.equal(db.getProxyById(unclear.id).last_test_outcome, 'inconclusive');
});

test('auto-delete can be disabled without changing queue completion', () => {
  db.setSetting('autoDeleteDead', 'false');
  const proxy = add('dead-retained', 8103);
  const result = applyTestResult(proxy, { id: proxy.id, alive: false, outcome: 'dead', error: 'timeout' }, db.proxyEndpointKey(proxy));
  assert.equal(result.deleted, false);
  assert.equal(db.getProxyById(proxy.id).alive, false);
  assert.equal(db.getDb().prepare('SELECT 1 FROM connectivity_queue WHERE proxy_id = ?').get(proxy.id), undefined);
});

test('a stale failure cannot delete an endpoint edited during detection', () => {
  db.setSetting('autoDeleteDead', 'true');
  const original = add('edited-during-test', 8104);
  const oldKey = db.proxyEndpointKey(original);
  const edited = db.resetProxyConnectivityAndEnqueue({ ...original, port: 9104 }, 'endpoint_edit');

  const result = applyTestResult(original, { id: original.id, alive: false, outcome: 'dead', error: 'old endpoint failed' }, oldKey);
  assert.equal(result.superseded, true);
  assert.ok(db.getProxyById(original.id));
  assert.equal(db.getProxyById(original.id).port, 9104);
  assert.equal(db.getDb().prepare('SELECT status FROM connectivity_queue WHERE proxy_id = ?').get(original.id).status, 'pending');
  assert.equal(db.proxyEndpointKey(edited), db.proxyEndpointKey(db.getProxyById(original.id)));
});
