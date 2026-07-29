import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-ipdata-cache-test-'));
const db = await import('../src/db.js');
db.initDb();
const { ipToHex, cidrToRange } = await import('../src/utils/helpers.js');
const { datacenterAsnName } = await import('../src/services/datacenter-asns.js');

test('addresses map to comparable fixed-width hex', () => {
  assert.equal(ipToHex('0.0.0.0'), '00000000');
  assert.equal(ipToHex('255.255.255.255'), 'ffffffff');
  assert.equal(ipToHex('207.97.155.10'), 'cf619b0a');
  assert.equal(ipToHex('2001:db8::1').length, 32);
  assert.equal(ipToHex('2001:db8::1'), '20010db8000000000000000000000001');
  assert.equal(ipToHex('::ffff:1.2.3.4'), '00000000000000000000ffff01020304');
  assert.equal(ipToHex('not-an-ip'), null);
});

test('a CIDR expands to the range it covers', () => {
  const range = cidrToRange('207.97.155.0/24');
  assert.equal(range.start, 'cf619b00');
  assert.equal(range.end, 'cf619bff');
  assert.equal(range.family, 4);

  const single = cidrToRange('8.8.8.8/32');
  assert.equal(single.start, single.end);
  assert.equal(cidrToRange('10.0.0.0/33'), null);
  assert.equal(cidrToRange('garbage/24'), null);
});

test('one lookup covers every address in the reported network', () => {
  db.clearIpdataCacheRows();
  const stored = db.putIpdataCache('207.97.155.10', { ipType: 'residential', dualIsp: true, route: '207.97.155.0/24' });
  assert.equal(stored, '207.97.155.0/24');

  // A neighbour in the same /24 is answered without touching the API.
  const neighbour = db.lookupIpdataCache('207.97.155.200');
  assert.equal(neighbour.normalized.ipType, 'residential');
  assert.equal(neighbour.cidr, '207.97.155.0/24');

  // An address outside the block is not covered.
  assert.equal(db.lookupIpdataCache('207.97.156.1'), null);
});

test('a narrower entry wins over the block it sits inside', () => {
  db.clearIpdataCacheRows();
  db.putIpdataCache('1.2.3.4', { ipType: 'residential', route: '1.2.0.0/16' });
  db.putIpdataCache('1.2.3.4', { ipType: 'datacenter', route: '1.2.3.0/24' });
  assert.equal(db.lookupIpdataCache('1.2.3.4').normalized.ipType, 'datacenter');
  assert.equal(db.lookupIpdataCache('1.2.9.9').normalized.ipType, 'residential');
});

test('an answer without a route is cached for that single address only', () => {
  db.clearIpdataCacheRows();
  db.putIpdataCache('9.9.9.9', { ipType: 'datacenter' });
  assert.equal(db.lookupIpdataCache('9.9.9.9').normalized.ipType, 'datacenter');
  assert.equal(db.lookupIpdataCache('9.9.9.10'), null);
});

test('expired rows stop matching and can be pruned', () => {
  db.clearIpdataCacheRows();
  db.putIpdataCache('5.5.5.5', { ipType: 'datacenter', route: '5.5.5.0/24' }, 30);
  db.getDb().prepare("UPDATE ipdata_cache SET expires_at = datetime('now', '-1 day')").run();
  assert.equal(db.lookupIpdataCache('5.5.5.5'), null);
  assert.equal(db.pruneIpdataCache(), 1);
});

test('cache statistics separate networks from single addresses', () => {
  db.clearIpdataCacheRows();
  db.putIpdataCache('11.0.0.1', { ipType: 'datacenter', route: '11.0.0.0/24' });
  db.putIpdataCache('12.0.0.1', { ipType: 'residential' });
  db.lookupIpdataCache('11.0.0.9');
  const stats = db.getIpdataCacheStats();
  assert.equal(stats.entries, 2);
  assert.equal(stats.networks, 1);
  assert.equal(stats.hits, 1);
});

test('quota accounting tracks calls and what was saved', () => {
  db.recordIpdataUsage({ calls: 3 });
  db.recordIpdataUsage({ savedByCache: 2, savedByPrefilter: 5 });
  const usage = db.getIpdataUsage();
  assert.equal(usage.calls, 3);
  assert.equal(usage.savedByCache, 2);
  assert.equal(usage.savedByPrefilter, 5);
  assert.equal(usage.day, new Date().toISOString().slice(0, 10));
});

test('known hosting ASNs are recognised in every notation', () => {
  assert.equal(datacenterAsnName(16509), 'Amazon AWS');
  assert.equal(datacenterAsnName('AS24940'), 'Hetzner');
  assert.equal(datacenterAsnName('14061'), 'DigitalOcean');
  // Consumer ISPs must never be prefiltered — that is exactly what ipdata is for.
  assert.equal(datacenterAsnName(7922), '');
  assert.equal(datacenterAsnName(5065), '');
  assert.equal(datacenterAsnName('nonsense'), '');
});
