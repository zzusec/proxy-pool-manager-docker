import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-inspection-test-'));
const db = await import('../src/db.js');
const { applyTestResult } = await import('../src/services/connectivity.js');
db.initDb();

let addSequence = 0;
function add(id, protocol = 'http') {
  addSequence++;
  db.upsertProxy({ id, ip: id === 'hy2' ? 'example.com' : `8.8.8.${addSequence}`, port: protocol === 'socks5' ? 1080 : 443, protocol, source: 'test', tags: [] });
}

test('full inspection snapshots all proxies and preserves source results', () => {
  add('http');
  add('hy2', 'hysteria2');
  const job = db.createFullInspectionJob('full-job');
  assert.equal(job.kind, 'full_inspection');
  assert.equal(job.scope, 'all_current');
  assert.equal(job.total, 0);
  assert.equal(job.selectionStatus, 'pending');
  const prepared = db.materializeTestJobSelection(job.id, 100);
  assert.equal(prepared.done, true);
  assert.equal(db.getTestJob(job.id).total, 2);

  add('later');
  const claimed = db.claimFullInspectionItems(job.id, 10);
  assert.equal(claimed.length, 2);
  assert.equal(claimed.some(item => item.proxy_id === 'later'), false);

  db.upsertInspectionResult({ jobId: job.id, proxyId: 'http', source: 'testisp', status: 'success', queriedIp: '8.8.8.8', httpStatus: 200, normalized: { ipType: 'datacenter' }, response: { isp: { type: 'Datacenter' } } });
  db.upsertInspectionResult({ jobId: job.id, proxyId: 'http', source: 'ispinfo', status: 'success', observedIp: '1.1.1.1', httpStatus: 200, normalized: { isDatacenter: true }, response: { ip: '1.1.1.1' } });
  db.completeFullInspectionItems(job.id, [
    { proxyId: 'http', outcome: 'alive', exitIp: '1.1.1.1', responseTime: 10, testispStatus: 'success', ispinfoStatus: 'success' },
    { proxyId: 'hy2', outcome: 'unsupported_config', message: 'missing password', testispStatus: 'no_data', ispinfoStatus: 'skipped_unsupported' },
  ]);
  const done = db.finalizeTestJob(job.id);
  assert.equal(done.status, 'done');
  assert.equal(done.completed, 2);
  assert.equal(done.alive, 1);
  assert.equal(done.unsupported, 1);
  assert.equal(done.testispSuccess, 1);
  assert.equal(done.ispinfoSuccess, 1);
  assert.equal(done.ispinfoSkipped, 1);

  const detail = db.listFullInspectionItems(job.id, 50, 0);
  const http = detail.items.find(item => item.proxyId === 'http');
  assert.equal(http.sources.testisp.data.ipType, 'datacenter');
  assert.equal(http.sources.ispinfo.observedIp, '1.1.1.1');
});

test('full inspection persists an inconclusive fallback when a worker omits outcome', () => {
  add('missing-outcome');
  const job = db.createFullInspectionJob('missing-outcome-job');
  db.materializeTestJobSelection(job.id, 100);
  const claimed = db.claimFullInspectionItems(job.id, 100);

  db.completeFullInspectionItems(job.id, claimed.map(item => ({
    proxyId: item.proxy_id,
    outcome: item.proxy_id === 'missing-outcome' ? undefined : 'alive',
    testispStatus: 'success',
    ispinfoStatus: 'success',
    ipdataStatus: 'success',
  })));

  const detail = db.listFullInspectionItems(job.id, 100, 0);
  const item = detail.items.find(entry => entry.proxyId === 'missing-outcome');
  assert.equal(item.outcome, 'inconclusive');
  assert.equal(db.finalizeTestJob(job.id).status, 'done');
});

test('full inspection deletion obeys the endpoint snapshot', () => {
  const proxy = {
    id: 'inspection-stale',
    ip: '198.51.100.30',
    port: 8201,
    protocol: 'http',
    alive: null,
    source: 'test',
    tags: [],
  };
  db.createProxyAndEnqueue(proxy, 'full_inspection_test');
  const original = db.getProxyById(proxy.id);
  const expectedEndpointKey = db.proxyEndpointKey(original);
  const job = db.createFullInspectionJob('stale-endpoint-job');
  db.materializeTestJobSelection(job.id, 100);
  const claimed = db.claimFullInspectionItems(job.id, 100);
  assert.ok(claimed.some(item => item.proxy_id === proxy.id));

  db.resetProxyConnectivityAndEnqueue({ ...original, port: 9201 }, 'endpoint_edit');
  const applied = applyTestResult(original, {
    id: original.id,
    alive: false,
    outcome: 'dead',
    error: 'old endpoint failed',
  }, expectedEndpointKey);

  assert.equal(applied.superseded, true);
  assert.equal(db.getProxyById(proxy.id).port, 9201);
  assert.equal(db.getDb().prepare('SELECT status FROM connectivity_queue WHERE proxy_id = ?').get(proxy.id).status, 'pending');

  db.completeFullInspectionItems(job.id, claimed.map(item => ({
    proxyId: item.proxy_id,
    outcome: item.proxy_id === proxy.id ? applied.outcome : 'alive',
    testispStatus: 'success',
    ispinfoStatus: 'success',
    ipdataStatus: 'success',
  })));
  assert.equal(db.listFullInspectionItems(job.id, 100, 0).items.find(item => item.proxyId === proxy.id).outcome, 'superseded');
});
