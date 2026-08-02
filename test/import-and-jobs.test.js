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
  const prefix = id.charCodeAt(0) % 200;
  return {
    id, ip: `11.${prefix}.${Math.floor(seq / 250)}.${(seq % 250) + 1}`, port: 8000 + (seq % 1000),
    protocol: 'http', alive, source: 'test', tags: [], createdAt: new Date(2025, 0, 1, 0, 0, seq % 60).toISOString(),
  };
}

test('filtered durable selection materializes every match without a 1000-proxy limit', () => {
  for (let index = 0; index < 1001; index++) db.upsertProxy(proxy(`p${index}`));
  const job = db.createTestSelectionJob('snapshot-job', { mode: 'filtered', scope: 'filtered', filters: { alive: 'false' } });
  let prepared;
  do prepared = db.materializeTestJobSelection(job.id, 125); while (!prepared.done);

  const snapshot = db.getTestJob(job.id);
  assert.equal(snapshot.total, 1001);
  assert.equal(snapshot.selectionStatus, 'done');
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS count FROM test_job_items WHERE job_id = ?').get(job.id).count, 1001);
  db.upsertProxy({ ...proxy('p0', true), id: 'p0' });
  assert.equal(db.getTestJob('snapshot-job').total, 1001);
  db.getDb().prepare('DELETE FROM test_jobs WHERE id = ?').run(job.id);
});

test('all untested selection has no 1000-proxy limit', () => {
  for (let index = 0; index < 1001; index++) db.upsertProxy(proxy(`u${index}`, null));
  const job = db.createTestSelectionJob('untested-job', { mode: 'untested', scope: 'untested' });
  let prepared;
  do prepared = db.materializeTestJobSelection(job.id, 137); while (!prepared.done);
  assert.equal(db.getTestJob(job.id).total, 1001);
  assert.equal(new Set(db.getAllUntestedProxyIds()).size, 1001);
  db.getDb().prepare('DELETE FROM test_jobs WHERE id = ?').run(job.id);
});

test('selected selection materializes every requested proxy before testing starts', () => {
  const ids = [];
  for (let index = 0; index < 1001; index++) {
    const id = `z${index}`;
    ids.push(id);
    db.upsertProxy(proxy(id, null));
  }

  const job = db.createTestSelectionJob('selected-job', { mode: 'selected', scope: 'selected', ids });
  let prepared = db.materializeTestJobSelection(job.id, 500);
  assert.equal(prepared.done, false);
  assert.equal(db.getTestJob(job.id).materialized, 500);
  assert.equal(db.getTestJob(job.id).selectionStatus, 'pending');

  prepared = db.materializeTestJobSelection(job.id, 500);
  assert.equal(prepared.done, false);
  assert.equal(db.getTestJob(job.id).materialized, 1000);

  prepared = db.materializeTestJobSelection(job.id, 500);
  assert.equal(prepared.done, true);
  assert.equal(db.getTestJob(job.id).materialized, 1001);
  assert.equal(db.getTestJob(job.id).total, 1001);
  assert.equal(db.getTestJob(job.id).selectionStatus, 'done');
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS count FROM test_job_items WHERE job_id = ?').get(job.id).count, 1001);
  db.getDb().prepare('DELETE FROM test_jobs WHERE id = ?').run(job.id);
});

test('filtered selection honours protocol and search filters across pages', () => {
  db.upsertProxy({ id: 'socks-1', ip: '9.9.9.9', port: 1080, protocol: 'socks5', alive: false, source: 'test', tags: [] });
  const socks = db.getProxyIdsByFilters({ protocol: 'socks5', alive: 'false' }, 1000);
  assert.deepEqual(socks.ids, ['socks-1']);
  assert.equal(socks.truncated, false);
  assert.deepEqual(db.getProxyIdsByFilters({ search: '9.9.9.9' }, 1000).ids, ['socks-1']);
  assert.deepEqual(db.getProxyIdsByFilters({ alive: 'true' }, 1000).ids.length, 1);
});

test('a queued import is processed, stamped, and enrolled for automatic detection', async () => {
  db.setSetting('autoTestEnabled', 'false');
  const queuedBefore = db.countConnectivityQueue().total;
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
  assert.equal(db.countConnectivityQueue().total, queuedBefore + 2);
  const queuedIds = db.getDb().prepare("SELECT proxy_id FROM connectivity_queue WHERE reason = 'bulk_import'").all().map(row => row.proxy_id);
  assert.ok(queuedIds.includes(pasted.id));
  assert.ok(queuedIds.includes(socks.id));
});

test('a queued import enqueues the imported proxies into a visible test job', async () => {
  db.setSetting('autoTestEnabled', 'false');
  const jobsBefore = new Set(db.getDb().prepare('SELECT id FROM test_jobs').all().map(r => r.id));
  db.enqueueImport('testjob-e2e', [{
    index: 0, text: '198.51.100.21:8080\n198.51.100.22:8080', lineCount: 2,
    protocol: 'http', skipDuplicates: true, autoClassify: false,
  }]);

  await processImportQueue();

  const p1 = db.listProxies({ search: '198.51.100.21' }).proxies[0];
  const p2 = db.listProxies({ search: '198.51.100.22' }).proxies[0];
  assert.ok(p1 && p2, '导入的代理已入库');

  const jobsAfter = db.getDb().prepare('SELECT id FROM test_jobs').all().map(r => r.id);
  const newJobId = jobsAfter.find(id => !jobsBefore.has(id));
  assert.ok(newJobId, '导入完成后应新建一个检测任务（加入检测列表）');

  let prepared;
  do prepared = db.materializeTestJobSelection(newJobId, 50); while (!prepared.done);
  const items = db.getDb().prepare('SELECT proxy_id FROM test_job_items WHERE job_id = ?').all(newJobId).map(r => r.proxy_id);
  assert.ok(items.includes(p1.id), '检测任务应包含本次导入的代理 1');
  assert.ok(items.includes(p2.id), '检测任务应包含本次导入的代理 2');

  db.getDb().prepare('DELETE FROM test_jobs WHERE id = ?').run(newJobId);
});

test('a queued Base64 Loon subscription imports complete VLESS nodes only', async () => {
  db.setSetting('autoTestEnabled', 'false');
  const line = 'Loon WS=vless,loon.example.com,443,"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",transport=ws,path=/ws,host=edge.example.com,over-tls=true,skip-cert-verify=false,tls-name=edge.example.com,udp=true';
  const complete = Buffer.from(`${line}\n`);
  const truncated = Buffer.from('truncated=vless,broken.example.com,443,"unfinished');
  const encoded = Buffer.concat([complete, truncated])
    .toString('base64')
    .replace(/=+$/, '');
  const queuedBefore = db.countConnectivityQueue().total;

  db.enqueueImport('loon-base64-e2e', [{
    index: 0,
    text: `${encoded.slice(0, 60)}\n${encoded.slice(60)}`,
    lineCount: 1,
    workType: 'resolve_input',
    protocol: 'http',
    skipDuplicates: true,
    autoClassify: false,
    groupName: 'loon-subscription',
  }]);

  await processImportQueue();

  const imported = db.listProxies({ search: 'loon.example.com' }).proxies;
  assert.equal(imported.length, 1);
  assert.equal(imported[0].protocol, 'vless');
  assert.equal(imported[0].port, 443);
  assert.equal(imported[0].username, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(imported[0].notes, 'Loon WS');
  assert.equal(imported[0].group_name, 'loon-subscription');
  assert.deepEqual(imported[0].extra, {
    network: 'ws',
    security: 'tls',
    sni: 'edge.example.com',
    flow: '',
    path: '/ws',
    host: 'edge.example.com',
    skipCertVerify: false,
    udp: true,
  });
  assert.equal(db.listProxies({ search: 'broken.example.com' }).proxies.length, 0);
  assert.deepEqual(db.getImportTask('loon-base64-e2e'), {
    taskId: 'loon-base64-e2e',
    imported: 1,
    duplicates: 0,
    errors: 0,
    status: 'done',
  });
  assert.equal(db.countConnectivityQueue().total, queuedBefore + 1);
  assert.equal(db.getDb().prepare('SELECT reason FROM connectivity_queue WHERE proxy_id = ?').get(imported[0].id).reason, 'bulk_import');
});

test('new proxies queue once while metadata updates do not create duplicate work', () => {
  const item = proxy('q1', null);
  const created = db.createProxyAndEnqueue(item, 'test_create');
  assert.equal(created.inserted, true);
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS count FROM connectivity_queue WHERE proxy_id = ?').get(item.id).count, 1);

  db.upsertProxy({ ...db.getProxyById(item.id), country: 'US', ipType: 'datacenter' });
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS count FROM connectivity_queue WHERE proxy_id = ?').get(item.id).count, 1);

  const changed = { ...db.getProxyById(item.id), port: item.port + 1 };
  db.resetProxyConnectivityAndEnqueue(changed, 'endpoint_edit');
  const queued = db.getDb().prepare('SELECT status, reason FROM connectivity_queue WHERE proxy_id = ?').get(item.id);
  assert.equal(queued.status, 'pending');
  assert.equal(queued.reason, 'endpoint_edit');
  assert.equal(db.getProxyById(item.id).last_check_at, null);
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
  const ss2022 = 'ss://2022-blake3-aes-256-gcm:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY%3D:ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA%3D@gg.example.com:10010?type=tcp#%E5%85%AC%E7%9B%8A';
  const parsed = parseProxyLine(ss2022);
  assert.equal(parsed.protocol, 'ss');
  assert.equal(parsed.ip, 'gg.example.com');
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
