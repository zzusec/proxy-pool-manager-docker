import net from 'node:net';
import dns from 'node:dns/promises';
import { getSetting, setSetting } from '../db.js';

const IPDATA_API = 'https://api.ipdata.co';
const BULK_CHUNK_SIZE = 100;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_LIMIT = 5000;
// A throttled key recovers within minutes; a key whose daily allowance is gone
// only recovers when ipdata rolls the quota over at UTC midnight.
const THROTTLE_COOLDOWN_MS = 10 * 60 * 1000;

// ipdata classifies both the ASN and the owning company. `isp` is what a real
// residential/ISP line looks like; `hosting` is a datacenter range. The rest are
// organisation types that are never residential.
const NON_ISP_TYPES = new Set(['business', 'education', 'government', 'banking', 'military', 'cdn']);

const cache = new Map();
// Per-key health, keyed by the key itself: a pool member is skipped while it is
// cooling down, and dropped from rotation entirely once ipdata rejects it.
const keyState = new Map();
let rotationIndex = 0;
let lastError = '';

function parseKeyList(raw) {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map(value => value.trim())
    .filter(Boolean);
}

function readStoredKeys() {
  let stored = [];
  try {
    const json = getSetting('ipdataApiKeys');
    if (json) {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) stored = parsed.map(value => String(value || '').trim()).filter(Boolean);
    }
    // Installations configured before the pool existed kept a single key.
    if (!stored.length) stored = parseKeyList(getSetting('ipdataApiKey'));
  } catch { stored = []; }
  return stored;
}

/** Every usable key, settings first, then whatever the environment supplies. */
export function getIpdataApiKeys() {
  const entries = [];
  const seen = new Set();
  for (const key of readStoredKeys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, source: 'settings' });
  }
  for (const key of parseKeyList(process.env.IPDATA_API_KEY)) {
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, source: 'env' });
  }
  return entries;
}

/** Replace the stored pool. Environment keys are not touched. */
export function setIpdataApiKeys(keys) {
  const unique = [...new Set((keys || []).map(value => String(value || '').trim()).filter(Boolean))];
  setSetting('ipdataApiKeys', JSON.stringify(unique));
  setSetting('ipdataApiKey', '');
  for (const key of [...keyState.keys()]) {
    if (!unique.includes(key)) keyState.delete(key);
  }
  rotationIndex = 0;
  return unique;
}

export function getIpdataApiKey() {
  return getIpdataApiKeys()[0]?.key || '';
}

export function isIpdataConfigured() {
  return getIpdataApiKeys().length > 0;
}

function stateOf(key) {
  let state = keyState.get(key);
  if (!state) {
    state = { cooldownUntil: 0, invalid: false, lastError: '', success: 0, failed: 0, lastUsedAt: null };
    keyState.set(key, state);
  }
  return state;
}

function isAvailable(key) {
  const state = stateOf(key);
  return !state.invalid && state.cooldownUntil <= Date.now();
}

/** Mask a credential for display: enough to tell keys apart, not enough to use. */
export function maskKey(key) {
  const value = String(key || '');
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

function nextUtcMidnight() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
}

export function getIpdataStatus() {
  const entries = getIpdataApiKeys();
  const now = Date.now();
  const keys = entries.map(entry => {
    const state = stateOf(entry.key);
    const cooling = !state.invalid && state.cooldownUntil > now;
    return {
      masked: maskKey(entry.key),
      source: entry.source,
      state: state.invalid ? 'invalid' : cooling ? 'cooling' : 'ready',
      cooldownUntil: cooling ? new Date(state.cooldownUntil).toISOString() : null,
      lastError: state.lastError,
      success: state.success,
      failed: state.failed,
      lastUsedAt: state.lastUsedAt,
    };
  });
  return {
    configured: entries.length > 0,
    total: entries.length,
    available: entries.filter(entry => isAvailable(entry.key)).length,
    // Kept for older callers that only asked "where did the key come from".
    source: entries[0]?.source || '',
    keys,
    cached: cache.size,
    lastError,
  };
}

function cacheGet(ip) {
  const hit = cache.get(ip);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(ip);
    return null;
  }
  return hit.value;
}

function cacheSet(ip, value) {
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(ip, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function clearIpdataCache() {
  cache.clear();
  keyState.clear();
  rotationIndex = 0;
  lastError = '';
}

/**
 * Decide residential vs datacenter from an ipdata answer.
 *
 * A line whose ASN *and* company are both typed `isp` is the "dual ISP"
 * residential address operators actually want, so that combination wins over
 * every other signal. Anything hosted — either side typed `hosting`, or the
 * threat feed flagging a datacenter range — is a machine room.
 */
export function ipdataType(data = {}) {
  const asnType = String(data?.asn?.type || '').toLowerCase();
  const companyType = String(data?.company?.type || '').toLowerCase();
  const isDatacenterFlag = data?.threat?.is_datacenter === true;

  if (asnType === 'isp' && companyType === 'isp') return { ipType: 'residential', dualIsp: true, confidence: 'high' };
  if (asnType === 'hosting' || companyType === 'hosting' || isDatacenterFlag) {
    return { ipType: 'datacenter', dualIsp: false, confidence: 'high' };
  }
  if (asnType === 'isp' || companyType === 'isp') return { ipType: 'residential', dualIsp: false, confidence: 'medium' };
  if (NON_ISP_TYPES.has(asnType) || NON_ISP_TYPES.has(companyType)) {
    return { ipType: 'datacenter', dualIsp: false, confidence: 'medium' };
  }
  return { ipType: 'unknown', dualIsp: false, confidence: 'none' };
}

/** Human readable summary shown on hover in the proxy table. */
export function ipdataDetail(normalized = {}) {
  const parts = [];
  if (normalized.asnType) parts.push(`ASN=${normalized.asnType}`);
  if (normalized.companyType) parts.push(`Company=${normalized.companyType}`);
  if (normalized.dualIsp) parts.push('双ISP住宅');
  if (normalized.isDatacenterFlag) parts.push('threat.is_datacenter');
  return parts.join(' · ');
}

function normalizeIpdata(data = {}) {
  const verdict = ipdataType(data);
  const asnNumber = String(data?.asn?.asn || '').trim();
  return {
    ip: String(data?.ip || ''),
    ipType: verdict.ipType,
    dualIsp: verdict.dualIsp,
    confidence: verdict.confidence,
    asnType: String(data?.asn?.type || ''),
    companyType: String(data?.company?.type || ''),
    isDatacenterFlag: data?.threat?.is_datacenter === true,
    isProxy: data?.threat?.is_proxy === true,
    isVpn: data?.threat?.is_vpn === true,
    asn: asnNumber ? (asnNumber.toUpperCase().startsWith('AS') ? asnNumber.toUpperCase() : `AS${asnNumber}`) : '',
    asName: data?.asn?.name || '',
    isp: data?.company?.name || data?.asn?.name || '',
    org: data?.company?.name || data?.asn?.name || '',
    route: data?.asn?.route || data?.company?.network || '',
    countryCode: data?.country_code || '',
    country: data?.country_name || '',
    carrier: data?.carrier?.name || '',
    source: 'ipdata',
  };
}

function failure(status, error, extra = {}) {
  lastError = String(error || '').slice(0, 240);
  return { status, error: lastError, response: {}, normalized: {}, httpStatus: null, ...extra };
}

/**
 * Record why a key was rejected and take it out of rotation for as long as the
 * rejection lasts. Returns true when another key is worth trying.
 */
function penaliseKey(key, httpStatus, body) {
  const state = stateOf(key);
  const message = String(body?.message || '').slice(0, 200);
  state.failed += 1;
  state.lastError = message || `HTTP ${httpStatus}`;
  if (httpStatus === 401) {
    state.invalid = true;
    return true;
  }
  if (httpStatus === 403 || httpStatus === 429) {
    // "exceeded your daily request limit" only clears at the UTC rollover;
    // plain throttling clears much sooner.
    const daily = /daily|quota|limit/i.test(message) && httpStatus === 403;
    state.cooldownUntil = daily ? nextUtcMidnight() : Date.now() + THROTTLE_COOLDOWN_MS;
    return true;
  }
  return false;
}

/**
 * Run one request against the key pool: keys are tried round-robin, and a key
 * that reports an invalid credential or an exhausted quota hands over to the
 * next one instead of failing the whole lookup.
 */
async function withKeyRotation(perform) {
  const entries = getIpdataApiKeys();
  if (!entries.length) return { poolStatus: 'not_configured', error: '未配置 ipdata API Key' };

  const usable = entries.filter(entry => isAvailable(entry.key));
  if (!usable.length) {
    const anyInvalid = entries.every(entry => stateOf(entry.key).invalid);
    return {
      poolStatus: anyInvalid ? 'auth_error' : 'quota_error',
      error: anyInvalid ? '所有 ipdata API Key 均无效' : `全部 ${entries.length} 个 ipdata Key 配额已用尽或冷却中`,
    };
  }

  for (let attempt = 0; attempt < usable.length; attempt++) {
    const entry = usable[rotationIndex++ % usable.length];
    if (!isAvailable(entry.key)) continue;
    const state = stateOf(entry.key);
    state.lastUsedAt = new Date().toISOString();

    const outcome = await perform(entry.key);
    if (outcome.ok) {
      state.success += 1;
      state.lastError = '';
      lastError = '';
      return { ...outcome, key: entry.key };
    }
    if (outcome.httpStatus) {
      // penaliseKey already recorded the failure on this key.
      if (penaliseKey(entry.key, outcome.httpStatus, outcome.body)) continue;
      return { ...outcome, key: entry.key };
    }
    state.failed += 1;
    state.lastError = String(outcome.error || '').slice(0, 200);
    return { ...outcome, key: entry.key };
  }

  const allInvalid = entries.every(entry => stateOf(entry.key).invalid);
  return {
    poolStatus: allInvalid ? 'auth_error' : 'quota_error',
    error: allInvalid ? '所有 ipdata API Key 均无效' : '所有 ipdata Key 都被拒绝（配额用尽或限流）',
  };
}

function poolFailure(rotation, extra = {}) {
  const status = rotation.poolStatus || rotation.status || 'transport_error';
  return failure(status, rotation.error, extra);
}

/**
 * Look one address up. Hostnames are resolved first because ipdata only accepts
 * literal IPs — proxies imported by domain would otherwise never classify.
 */
export async function lookupIpdata(ip) {
  if (!isIpdataConfigured()) return failure('not_configured', '未配置 ipdata API Key');

  let queriedIp = String(ip || '').trim();
  if (!queriedIp) return failure('invalid_input', '缺少 IP 地址');
  if (!net.isIP(queriedIp)) {
    try {
      queriedIp = (await dns.lookup(queriedIp)).address;
    } catch (error) {
      return failure('resolve_error', `无法解析主机名：${String(error?.message || ip).slice(0, 180)}`, { queriedIp: String(ip) });
    }
  }

  const cached = cacheGet(queriedIp);
  if (cached) return { status: 'success', queriedIp, httpStatus: 200, response: cached.response, normalized: cached.normalized, cached: true };

  const rotation = await withKeyRotation(async apiKey => {
    let response;
    try {
      response = await fetch(`${IPDATA_API}/${encodeURIComponent(queriedIp)}?api-key=${encodeURIComponent(apiKey)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      return { ok: false, status: 'transport_error', error: String(error?.message || 'ipdata 请求失败') };
    }
    let data = null;
    try { data = await response.json(); } catch { /* handled by the caller */ }
    if (!response.ok) {
      return { ok: false, status: 'http_error', httpStatus: response.status, body: data, error: String(data?.message || `ipdata 返回 HTTP ${response.status}`) };
    }
    return { ok: true, httpStatus: response.status, data };
  });

  if (!rotation.ok) return poolFailure(rotation, { queriedIp, httpStatus: rotation.httpStatus || null, response: rotation.body || {} });

  const data = rotation.data;
  if (!data || (!data.asn && !data.company)) {
    return failure('no_data', 'ipdata 未返回 ASN/Company 类型', { queriedIp, httpStatus: rotation.httpStatus, response: data || {} });
  }

  const normalized = normalizeIpdata(data);
  cacheSet(queriedIp, { response: data, normalized });
  lastError = '';
  return { status: 'success', queriedIp, httpStatus: rotation.httpStatus, response: data, normalized };
}

/**
 * Probe one specific pool member. Used by the settings page so an operator can
 * tell which stacked key is exhausted instead of only seeing the pool verdict.
 */
export async function testIpdataKey(index, ip = '8.8.8.8') {
  const entries = getIpdataApiKeys();
  const entry = entries[index];
  if (!entry) return failure('invalid_input', '指定的 ipdata Key 不存在');

  const queriedIp = net.isIP(String(ip).trim()) ? String(ip).trim() : '8.8.8.8';
  const state = stateOf(entry.key);
  state.lastUsedAt = new Date().toISOString();

  let response;
  try {
    response = await fetch(`${IPDATA_API}/${encodeURIComponent(queriedIp)}?api-key=${encodeURIComponent(entry.key)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    state.failed += 1;
    state.lastError = String(error?.message || 'ipdata 请求失败').slice(0, 200);
    return failure('transport_error', state.lastError, { queriedIp });
  }

  let data = null;
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    penaliseKey(entry.key, response.status, data);
    return failure(response.status === 401 ? 'auth_error' : response.status === 403 || response.status === 429 ? 'quota_error' : 'http_error',
      String(data?.message || `ipdata 返回 HTTP ${response.status}`), { queriedIp, httpStatus: response.status, response: data || {} });
  }

  state.success += 1;
  state.lastError = '';
  const normalized = normalizeIpdata(data || {});
  cacheSet(queriedIp, { response: data, normalized });
  return { status: 'success', queriedIp, httpStatus: response.status, response: data, normalized };
}

/**
 * Bulk lookup — ipdata accepts up to 100 addresses per POST and each address
 * still counts against the daily quota, so cached entries are filtered out
 * before the request is built. Returns a Map of ip → normalized result.
 */
export async function lookupIpdataBulk(ips) {
  const found = new Map();
  const unique = [...new Set((ips || []).map(ip => String(ip || '').trim()).filter(ip => net.isIP(ip)))];
  if (!isIpdataConfigured() || !unique.length) return found;

  const pending = [];
  for (const ip of unique) {
    const cached = cacheGet(ip);
    if (cached) found.set(ip, cached.normalized);
    else pending.push(ip);
  }

  for (let start = 0; start < pending.length; start += BULK_CHUNK_SIZE) {
    const batch = pending.slice(start, start + BULK_CHUNK_SIZE);
    const rotation = await withKeyRotation(async apiKey => {
      let response;
      try {
        response = await fetch(`${IPDATA_API}/bulk?api-key=${encodeURIComponent(apiKey)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(30000),
        });
      } catch (error) {
        return { ok: false, status: 'transport_error', error: String(error?.message || 'ipdata 批量请求失败') };
      }
      let data = null;
      try { data = await response.json(); } catch { /* handled by the caller */ }
      if (!response.ok) {
        return { ok: false, status: 'http_error', httpStatus: response.status, body: data, error: String(data?.message || `ipdata 返回 HTTP ${response.status}`) };
      }
      return { ok: true, httpStatus: response.status, data };
    });

    if (!rotation.ok) {
      lastError = String(rotation.error || 'ipdata 批量查询失败').slice(0, 240);
      break;
    }
    if (!Array.isArray(rotation.data)) {
      lastError = 'ipdata 批量接口未返回数组';
      break;
    }

    rotation.data.forEach((entry, index) => {
      const ip = batch[index];
      if (!ip || !entry || (!entry.asn && !entry.company)) return;
      const normalized = normalizeIpdata(entry);
      cacheSet(ip, { response: entry, normalized });
      found.set(ip, normalized);
    });
  }

  return found;
}
