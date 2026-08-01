import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-inspection-test-'));
const db = await import('../src/db.js');
db.initDb();

function add(id, protocol = 'http') {
  db.upsertProxy({ id, ip: id === 'hy2' ? 'example.com' : '8.8.8.8', port: protocol === 'socks5' ? 1080 : 443, protocol, source: 'test', tags: [] });
}

test('full inspection snapshots all proxies and preserves source results', () => {
  add('http');
  add('hy2', 'hysteria2');
  const job = db.createFullInspectionJob('full-job');
  assert.equal(job.kind, 'full_inspection');
  assert.equal(job.scope, 'all_current');
  assert.equal(job.total, 2);

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

test('an item with no verdict is recorded instead of failing the whole batch', () => {
  // Regression: an auto-deleted proxy left outcome undefined, which SQLite bound
  // as NULL and rejected — taking the entire job down with a NOT NULL error.
  add('nulled');
  const job = db.createFullInspectionJob('null-outcome-job');
  db.claimFullInspectionItems(job.id, 50);
  db.completeFullInspectionItems(job.id, [{ proxyId: 'nulled', outcome: undefined, message: '代理已被自动删除' }]);
  const item = db.listFullInspectionItems(job.id, 50, 0).items.find(entry => entry.proxyId === 'nulled');
  assert.equal(item.outcome, 'inconclusive');
  assert.equal(db.getTestJob(job.id).inconclusive >= 1, true);
});

test('a failed job resumes from where it stopped', () => {
  const job = db.createFullInspectionJob('resume-job');
  const claimed = db.claimFullInspectionItems(job.id, 1);
  assert.equal(claimed.length, 1);
  db.finalizeTestJob(job.id, '模拟崩溃');
  assert.equal(db.getTestJob(job.id).status, 'error');
  assert.equal(db.getNextTestJob()?.id === 'resume-job', false);

  const resumed = db.resumeTestJob('resume-job');
  assert.equal(resumed.status, 'pending');
  assert.equal(resumed.error, null);
  // The item claimed when it crashed is queued again, not lost.
  assert.equal(db.claimFullInspectionItems('resume-job', 50).length, resumed.total);
});
