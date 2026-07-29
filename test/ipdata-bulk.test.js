import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-ipdata-bulk-test-'));
delete process.env.IPDATA_API_KEY;
const db = await import('../src/db.js');
db.initDb();
const { lookupIpdataBulk, setIpdataApiKeys, clearIpdataCache } = await import('../src/services/ipdata.js');

const realFetch = globalThis.fetch;

/** Stand in for ipdata: answers every address with the route it belongs to. */
function stubIpdata(routeFor) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const batch = JSON.parse(init.body);
    sent.push(...batch);
    const body = batch.map(ip => ({
      ip,
      asn: { asn: 'AS5065', name: 'Test Net', type: 'isp', route: routeFor(ip) },
      company: { name: 'Test Net', type: 'isp' },
      country_code: 'US',
    }));
    return { ok: true, status: 200, json: async () => body };
  };
  return sent;
}

test.after(() => { globalThis.fetch = realFetch; });

test('one address per /24 is enough to classify the whole block', async () => {
  clearIpdataCache();
  setIpdataApiKeys(['bulk-test-key-0001']);
  const sent = stubIpdata(ip => `${ip.split('.').slice(0, 3).join('.')}.0/24`);

  const ips = [];
  for (const third of [10, 11, 12]) {
    for (let host = 1; host <= 60; host++) ips.push(`203.0.${third}.${host}`);
  }

  const found = await lookupIpdataBulk(ips);
  assert.equal(found.size, ips.length, '每个 IP 都要有结论');
  assert.equal(sent.length, 3, '180 个 IP 只应查 3 次（每个 /24 一个代表）');
  assert.equal(found.get('203.0.10.55').ipType, 'residential');

  const usage = db.getIpdataUsage();
  assert.equal(usage.calls, 3);
  assert.ok(usage.savedByCache >= 177, `缓存应挡下其余请求，实际 ${usage.savedByCache}`);
});

test('a block split between two owners simply needs another round', async () => {
  clearIpdataCache();
  setIpdataApiKeys(['bulk-test-key-0002']);
  // Lower half is one /25, upper half another — the /24 guess cannot cover both.
  const sent = stubIpdata(ip => (Number(ip.split('.')[3]) < 128 ? '198.51.100.0/25' : '198.51.100.128/25'));

  const ips = [1, 5, 60, 130, 200, 250].map(host => `198.51.100.${host}`);
  const found = await lookupIpdataBulk(ips);

  assert.equal(found.size, ips.length);
  assert.equal(sent.length, 2, '两个 /25 各查一次即可');
});

test('nothing is sent when every address is already cached', async () => {
  clearIpdataCache();
  setIpdataApiKeys(['bulk-test-key-0003']);
  stubIpdata(() => '192.0.2.0/24');
  await lookupIpdataBulk(['192.0.2.1']);

  const sent = stubIpdata(() => '192.0.2.0/24');
  const found = await lookupIpdataBulk(['192.0.2.7', '192.0.2.200']);
  assert.equal(sent.length, 0, '同网段的后续 IP 不应再产生请求');
  assert.equal(found.size, 2);
  setIpdataApiKeys([]);
});
