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

test('untested batch selection stays bounded and reports overflow', () => {
  const ids = db.getProxyIdsToTest(null, 1001);
  assert.equal(ids.length, 1001);
  assert.equal(new Set(ids).size, 1001);
  assert.equal(db.getProxyIdsToTest(null, 5000).length, 1001);
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
