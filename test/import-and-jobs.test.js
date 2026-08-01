import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-test-'));
const db = await import('../src/db.js');
const { processImportQueue } = await import('../src/services/scheduler.js');

db.initDb();

function proxy(id, alive = false) {
  const seq = Number(id.slice(1));
  return {
    id, ip: `11.${Math.floor(seq / 250)}.${seq % 250}.1`, port: 8000 + (seq % 1000),
    protocol: 'http', alive, source: 'test', tags: [], createdAt: new Date(2025, 0, 1, 0, 0, seq % 60).toISOString(),
  };
}

test('filtered durable selection snapshots at most 1000 failed proxies', () => {
  for (let index = 0; index < 1001; index++) db.upsertProxy(proxy(`p${index}`));
  const selected = db.getProxyIdsByFilters({ alive: 'false' }, 1000);
  assert.equal(selected.ids.length, 1000);
  assert.equal(selected.truncated, true);
  const job = db.createTestJob('snapshot-job', selected.ids);
  assert.equal(job.total, 1000);
  db.upsertProxy({ ...proxy(selected.ids[0], true), id: selected.ids[0] });
  assert.equal(db.getTestJob('snapshot-job').total, 1000);
});

test('untested batch selection honours an explicit limit', () => {
  const ids = db.getProxyIdsToTest(null, 500);
  assert.equal(ids.length, 500);
  assert.equal(new Set(ids).size, 500);
});

test('limit 0 selects every untested proxy, past the old 1000 ceiling', () => {
  const all = db.getProxyIdsToTest(null, 0);
  assert.equal(all.length, 1001);
  assert.equal(new Set(all).size, 1001);
  const filtered = db.getProxyIdsByFilters({}, 0);
  assert.equal(filtered.ids.length, 1001);
  assert.equal(filtered.truncated, false);
});

test('canceling a running job drops its pending items and sticks', () => {
  const job = db.createTestJob('cancel-job', db.getProxyIdsToTest(null, 0), 'untested');
  assert.equal(job.total, 1001);
  const claimed = db.claimTestJobItems('cancel-job', 5);
  assert.equal(claimed.length, 5);
  assert.equal(db.getTestJob('cancel-job').status, 'running');

  const canceled = db.cancelTestJob('cancel-job');
  assert.equal(canceled.status, 'canceled');
  assert.notEqual(db.getNextTestJob()?.id, 'cancel-job');

  // The batch already in flight still reports, and must not revive the job.
  db.completeTestJobItems('cancel-job', claimed.map(id => ({ id, alive: true })));
  db.finalizeTestJob('cancel-job');
  const after = db.getTestJob('cancel-job');
  assert.equal(after.status, 'canceled');
  assert.equal(after.completed, 5);
  assert.equal(db.claimTestJobItems('cancel-job', 5).length, 0);
  assert.equal(db.getTestJob('cancel-job').status, 'canceled');
});

test('filtered selection honours protocol and search filters across pages', () => {
  db.upsertProxy({ id: 'socks-1', ip: '9.9.9.9', port: 1080, protocol: 'socks5', alive: false, source: 'test', tags: [] });
  const socks = db.getProxyIdsByFilters({ protocol: 'socks5', alive: 'false' }, 1000);
  assert.deepEqual(socks.ids, ['socks-1']);
  assert.equal(socks.truncated, false);
  assert.deepEqual(db.getProxyIdsByFilters({ search: '9.9.9.9' }, 1000).ids, ['socks-1']);
  assert.deepEqual(db.getProxyIdsByFilters({ alive: 'true' }, 1000).ids.length, 1);
});

test('a queued import is processed and stamped with its provenance', async () => {
  db.enqueueImport('paste-e2e', [{
    index: 0, text: '198.51.100.9:3128\nsocks5://203.0.113.7:1080', lineCount: 2,
    protocol: 'http', skipDuplicates: true, autoClassify: false, groupName: 'manual-batch',
  }]);

  await processImportQueue();

  const pasted = db.listProxies({ search: '198.51.100.9' }).proxies[0];
  assert.ok(pasted, '粘贴导入的代理已入库');
  assert.equal(pasted.protocol, 'http');
  assert.equal(pasted.source, 'import');
  assert.equal(pasted.group_name, 'manual-batch');

  const socks = db.listProxies({ search: '203.0.113.7' }).proxies[0];
  assert.ok(socks, '同一批次里的 socks5 行也被解析');
  assert.equal(socks.protocol, 'socks5');

  assert.equal(db.getImportTask('paste-e2e').status, 'done');
  assert.equal(db.getImportTaskState('paste-e2e').terminal, true);
});

test('deleting by filter removes every match and refuses an empty filter', () => {
  db.upsertProxy({ id: 'del-dead-1', ip: '198.51.100.11', port: 8001, protocol: 'http', alive: false, source: 'test', tags: [] });
  db.upsertProxy({ id: 'del-dead-2', ip: '198.51.100.12', port: 8002, protocol: 'http', alive: false, source: 'test', tags: [] });
  db.upsertProxy({ id: 'del-live-1', ip: '198.51.100.13', port: 8003, protocol: 'http', alive: true, source: 'test', tags: [] });

  const liveBefore = db.countProxies({ alive: 'true' });
  const deleted = db.deleteProxiesByFilters({ alive: 'false' });

  assert.ok(deleted >= 2, '所有失效代理都被删除');
  assert.equal(db.countProxies({ alive: 'false' }), 0);
  assert.equal(db.countProxies({ alive: 'true' }), liveBefore, '存活的代理不受影响');
  assert.ok(db.getProxyById('del-live-1'));

  assert.throws(() => db.deleteProxiesByFilters({}), /筛选条件/, '空筛选必须被拒绝，避免清空整个池子');
});

test('SIP002 / Shadowsocks 2022 links with query params are importable', async () => {
  const { parseProxyLine } = await import('../src/utils/helpers.js');

  // Plain-text userinfo (SS2022), a query string and a hostname instead of an IP.
  const ss2022 = 'ss://2022-blake3-aes-256-gcm:MgLHTy%2B7NF1MmLJFM7qWr0hKAruhggUavjQkQ2wq4L4%3D:yXaOPXuXYY6XKF%2BnTuUFKz5UAo%2B%2BrveJTmBuod79ft0%3D@gg.example.tech:10010?type=tcp#%E5%85%AC%E7%9B%8A';
  const parsed = parseProxyLine(ss2022);
  assert.equal(parsed.protocol, 'ss');
  assert.equal(parsed.ip, 'gg.example.tech');
  assert.equal(parsed.port, 10010);
  assert.equal(parsed.username, '2022-blake3-aes-256-gcm');
  assert.ok(parsed.password.includes(':'), 'SS2022 的双段密钥不能被截断');
  assert.equal(parsed.name, '公益');

  // Classic base64 userinfo still works, with and without a query string.
  const classic = 'ss://' + Buffer.from('aes-256-gcm:secretpass').toString('base64') + '@1.2.3.4:8388#node';
  const classicParsed = parseProxyLine(classic);
  assert.equal(classicParsed.username, 'aes-256-gcm');
  assert.equal(classicParsed.password, 'secretpass');
  assert.equal(classicParsed.ip, '1.2.3.4');

  const legacy = 'ss://' + Buffer.from('aes-128-gcm:pw@5.6.7.8:443').toString('base64') + '#old';
  const legacyParsed = parseProxyLine(legacy);
  assert.equal(legacyParsed.ip, '5.6.7.8');
  assert.equal(legacyParsed.port, 443);
});

test('a broken batch is retired as inconclusive instead of killing the job', () => {
  const ids = [];
  for (let index = 0; index < 10; index++) {
    const id = `batch-fail-${index}`;
    db.upsertProxy({ id, ip: `198.51.100.${100 + index}`, port: 8100 + index, protocol: 'http', source: 'test', tags: [] });
    ids.push(id);
  }
  const job = db.createTestJob('failing-batch-job', ids, 'untested');
  assert.equal(job.total, 10);
  const claimed = db.claimTestJobItems('failing-batch-job', 3);
  db.failTestJobItems('failing-batch-job', claimed, '模拟批次异常');

  const after = db.getTestJob('failing-batch-job');
  assert.equal(after.completed, 3);
  assert.equal(after.inconclusive, 3);
  // Items remain, so the job keeps running rather than being marked done/error.
  assert.equal(db.finalizeTestJob('failing-batch-job').status, 'running');
  // Retiring the same batch twice must not inflate the counters.
  db.failTestJobItems('failing-batch-job', claimed, '重复调用');
  assert.equal(db.getTestJob('failing-batch-job').completed, 3);
  assert.equal(db.claimTestJobItems('failing-batch-job', 10).length, 7);
});
