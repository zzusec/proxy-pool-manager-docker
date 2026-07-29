import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-ipdata-test-'));
const db = await import('../src/db.js');
db.initDb();
const { ipdataType, ipdataDetail, isIpdataConfigured, clearIpdataCache, getIpdataApiKeys, setIpdataApiKeys, getIpdataStatus, maskKey } = await import('../src/services/ipdata.js');

test('dual ISP (asn.type = company.type = isp) is residential', () => {
  const verdict = ipdataType({ asn: { asn: 'AS5065', name: 'Bunny Communications', type: 'isp' }, company: { name: 'Bunny Communications', type: 'isp' } });
  assert.equal(verdict.ipType, 'residential');
  assert.equal(verdict.dualIsp, true);
  assert.equal(verdict.confidence, 'high');
});

test('a carrier block does not turn a dual-ISP line into mobile', () => {
  const verdict = ipdataType({
    asn: { type: 'isp' }, company: { type: 'isp' },
    carrier: { name: 'Softcom Internet Communications, Inc', mcc: '313', mnc: '850' },
  });
  assert.equal(verdict.ipType, 'residential');
});

test('hosting on either side is a datacenter', () => {
  assert.equal(ipdataType({ asn: { type: 'hosting' }, company: { type: 'isp' } }).ipType, 'datacenter');
  assert.equal(ipdataType({ asn: { type: 'isp' }, company: { type: 'hosting' } }).ipType, 'datacenter');
});

test('threat.is_datacenter is enough to call a datacenter', () => {
  assert.equal(ipdataType({ asn: { type: 'business' }, threat: { is_datacenter: true } }).ipType, 'datacenter');
});

test('a single isp side still counts as residential, with lower confidence', () => {
  const verdict = ipdataType({ asn: { type: 'isp' }, company: {} });
  assert.equal(verdict.ipType, 'residential');
  assert.equal(verdict.dualIsp, false);
  assert.equal(verdict.confidence, 'medium');
});

test('other organisation types are not residential', () => {
  assert.equal(ipdataType({ asn: { type: 'business' }, company: { type: 'business' } }).ipType, 'datacenter');
  assert.equal(ipdataType({ asn: { type: 'education' } }).ipType, 'datacenter');
});

test('an answer without types stays unknown instead of guessing', () => {
  assert.equal(ipdataType({}).ipType, 'unknown');
  assert.equal(ipdataType({ asn: { name: 'Some Network' } }).ipType, 'unknown');
});

test('detail string records the evidence behind the verdict', () => {
  const detail = ipdataDetail({ asnType: 'isp', companyType: 'isp', dualIsp: true });
  assert.match(detail, /ASN=isp/);
  assert.match(detail, /Company=isp/);
  assert.match(detail, /双ISP住宅/);
});

test('the key is read from settings first, then the environment', () => {
  clearIpdataCache();
  delete process.env.IPDATA_API_KEY;
  setIpdataApiKeys([]);
  assert.equal(isIpdataConfigured(), false);

  process.env.IPDATA_API_KEY = 'env-key-value';
  assert.equal(isIpdataConfigured(), true);
  assert.deepEqual(getIpdataApiKeys().map(entry => entry.source), ['env']);

  setIpdataApiKeys(['settings-key-value']);
  assert.deepEqual(getIpdataApiKeys().map(entry => entry.key), ['settings-key-value', 'env-key-value']);
  assert.deepEqual(getIpdataApiKeys().map(entry => entry.source), ['settings', 'env']);

  setIpdataApiKeys([]);
  delete process.env.IPDATA_API_KEY;
});

test('a single legacy key is still honoured after the pool upgrade', () => {
  clearIpdataCache();
  setIpdataApiKeys([]);
  db.setSetting('ipdataApiKey', 'legacy-single-key');
  assert.deepEqual(getIpdataApiKeys().map(entry => entry.key), ['legacy-single-key']);
  db.setSetting('ipdataApiKey', '');
});

test('the pool stores several keys, drops duplicates and keeps order', () => {
  clearIpdataCache();
  setIpdataApiKeys(['key-one-aaaa', 'key-two-bbbb', 'key-one-aaaa', 'key-three-cccc']);
  assert.deepEqual(getIpdataApiKeys().map(entry => entry.key), ['key-one-aaaa', 'key-two-bbbb', 'key-three-cccc']);

  const status = getIpdataStatus();
  assert.equal(status.total, 3);
  assert.equal(status.available, 3);
  assert.deepEqual(status.keys.map(key => key.state), ['ready', 'ready', 'ready']);
  setIpdataApiKeys([]);
});

test('a stored key is never echoed back in full', () => {
  clearIpdataCache();
  setIpdataApiKeys(['abcdefghijklmnop']);
  const status = getIpdataStatus();
  assert.equal(status.keys[0].masked, 'abcd********mnop');
  assert.equal(JSON.stringify(status).includes('abcdefghijklmnop'), false);
  assert.equal(maskKey('short'), '*****');
  setIpdataApiKeys([]);
});

test('proxies keep the source and evidence of their IP-type verdict', () => {
  db.upsertProxy({
    id: 'ipdata-proxy', ip: '207.97.155.10', port: 8080, protocol: 'http', source: 'test', tags: [],
    ipType: 'residential', ipTypeSource: 'ipdata', ipTypeDetail: 'ASN=isp · Company=isp · 双ISP住宅',
  });
  const stored = db.getProxyById('ipdata-proxy');
  assert.equal(stored.ip_type, 'residential');
  assert.equal(stored.ip_type_source, 'ipdata');
  assert.match(stored.ip_type_detail, /双ISP住宅/);
});

test('threat flags are counted the way ipdata summarises them', async () => {
  const { summariseThreats, trustScoreLevel } = await import('../src/services/ipdata.js');
  const summary = summariseThreats({
    is_datacenter: true, is_proxy: true, is_threat: true,
    is_tor: false, is_known_abuser: false,
    blocklists: [{ name: 'x' }, { name: 'y' }],
    scores: { trust_score: 33, vpn_score: 10, proxy_score: 90, threat_score: 55 },
  });
  assert.equal(summary.threatCount, 3);
  assert.deepEqual(summary.threatFlags, ['is_proxy', 'is_datacenter', 'is_threat']);
  assert.equal(summary.trustScore, 33);
  assert.equal(summary.riskLevel, 'high');
  assert.equal(summary.blocklistCount, 2);
  assert.equal(summary.proxyScore, 90);

  // Banding follows ipdata's own dashboard: 0-33 高危, 34-66 中, 67-100 低。
  assert.equal(trustScoreLevel(0), 'high');
  assert.equal(trustScoreLevel(34), 'medium');
  assert.equal(trustScoreLevel(66), 'medium');
  assert.equal(trustScoreLevel(67), 'low');
  assert.equal(trustScoreLevel(100), 'low');
  assert.equal(trustScoreLevel(null), '');
});

test('an answer without a scores block reports no trust score', async () => {
  const { summariseThreats } = await import('../src/services/ipdata.js');
  const summary = summariseThreats({ is_proxy: true });
  assert.equal(summary.threatCount, 1);
  assert.equal(summary.trustScore, null);
  assert.equal(summary.riskLevel, '');
});

test('risk fields round-trip through the proxies table', () => {
  db.upsertProxy({
    id: 'risk-proxy', ip: '129.146.46.164', port: 8080, protocol: 'http', source: 'test', tags: [],
    ipType: 'datacenter', threatCount: 3, trustScore: 33, threatFlags: ['is_proxy', 'is_datacenter', 'is_threat'], riskLevel: 'high',
  });
  const stored = db.getProxyById('risk-proxy');
  assert.equal(stored.trust_score, 33);
  assert.equal(stored.threat_count, 3);
  assert.equal(stored.risk_level, 'high');
  assert.equal(stored.threat_flags, 'is_proxy,is_datacenter,is_threat');

  // A proxy that was never scored keeps NULL rather than a misleading zero.
  db.upsertProxy({ id: 'unscored-proxy', ip: '1.1.1.1', port: 80, protocol: 'http', source: 'test', tags: [] });
  const unscored = db.getProxyById('unscored-proxy');
  assert.equal(unscored.trust_score, null);
  assert.equal(unscored.threat_count, null);
});
