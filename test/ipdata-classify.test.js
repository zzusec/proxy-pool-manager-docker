import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-ipdata-test-'));
const db = await import('../src/db.js');
db.initDb();
const { ipdataType, ipdataDetail, isIpdataConfigured, clearIpdataCache } = await import('../src/services/ipdata.js');

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
  db.setSetting('ipdataApiKey', '');
  assert.equal(isIpdataConfigured(), false);

  process.env.IPDATA_API_KEY = 'env-key-value';
  assert.equal(isIpdataConfigured(), true);

  db.setSetting('ipdataApiKey', 'settings-key-value');
  assert.equal(isIpdataConfigured(), true);
  db.setSetting('ipdataApiKey', '');
  delete process.env.IPDATA_API_KEY;
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
