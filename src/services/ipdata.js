import net from 'node:net';
import dns from 'node:dns/promises';
import { getSetting } from '../db.js';

const IPDATA_API = 'https://api.ipdata.co';
const BULK_CHUNK_SIZE = 100;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_LIMIT = 5000;
// After a quota/rate-limit answer there is no point in burning further calls,
// so every lookup short-circuits until this timestamp passes.
const QUOTA_COOLDOWN_MS = 10 * 60 * 1000;

// ipdata classifies both the ASN and the owning company. `isp` is what a real
// residential/ISP line looks like; `hosting` is a datacenter range. The rest are
// organisation types that are never residential.
const NON_ISP_TYPES = new Set(['business', 'education', 'government', 'banking', 'military', 'cdn']);

const cache = new Map();
let quotaBlockedUntil = 0;
let lastError = '';

export function getIpdataApiKey() {
  let stored = '';
  try { stored = String(getSetting('ipdataApiKey') || '').trim(); } catch { stored = ''; }
  return stored || String(process.env.IPDATA_API_KEY || '').trim();
}

export function isIpdataConfigured() {
  return getIpdataApiKey().length > 0;
}

export function getIpdataStatus() {
  return {
    configured: isIpdataConfigured(),
    source: getSettingKeySource(),
    cached: cache.size,
    cooldownUntil: quotaBlockedUntil > Date.now() ? new Date(quotaBlockedUntil).toISOString() : null,
    lastError,
  };
}

function getSettingKeySource() {
  try {
    if (String(getSetting('ipdataApiKey') || '').trim()) return 'settings';
  } catch { /* database not ready */ }
  return String(process.env.IPDATA_API_KEY || '').trim() ? 'env' : '';
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
  quotaBlockedUntil = 0;
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

/** Map ipdata's HTTP errors onto a stable status, and arm the cooldown on quota. */
function httpFailure(httpStatus, body) {
  const message = String(body?.message || '').slice(0, 200);
  if (httpStatus === 401) return failure('auth_error', message || 'ipdata API Key 无效', { httpStatus, response: body || {} });
  if (httpStatus === 403 || httpStatus === 429) {
    quotaBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS;
    return failure('quota_error', message || 'ipdata 配额已用尽或触发限流', { httpStatus, response: body || {} });
  }
  return failure('http_error', message || `ipdata 返回 HTTP ${httpStatus}`, { httpStatus, response: body || {} });
}

/**
 * Look one address up. Hostnames are resolved first because ipdata only accepts
 * literal IPs — proxies imported by domain would otherwise never classify.
 */
export async function lookupIpdata(ip) {
  const apiKey = getIpdataApiKey();
  if (!apiKey) return failure('not_configured', '未配置 IPDATA_API_KEY');
  if (quotaBlockedUntil > Date.now()) return failure('quota_error', 'ipdata 配额冷却中，稍后重试');

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

  let response;
  try {
    response = await fetch(`${IPDATA_API}/${encodeURIComponent(queriedIp)}?api-key=${encodeURIComponent(apiKey)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    return failure('transport_error', String(error?.message || 'ipdata 请求失败'), { queriedIp });
  }

  let data = null;
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok) return { ...httpFailure(response.status, data), queriedIp };
  if (!data || (!data.asn && !data.company)) {
    return failure('no_data', 'ipdata 未返回 ASN/Company 类型', { queriedIp, httpStatus: response.status, response: data || {} });
  }

  const normalized = normalizeIpdata(data);
  cacheSet(queriedIp, { response: data, normalized });
  lastError = '';
  return { status: 'success', queriedIp, httpStatus: response.status, response: data, normalized };
}

/**
 * Bulk lookup — ipdata accepts up to 100 addresses per POST and each address
 * still counts against the daily quota, so cached entries are filtered out
 * before the request is built. Returns a Map of ip → normalized result.
 */
export async function lookupIpdataBulk(ips) {
  const found = new Map();
  const apiKey = getIpdataApiKey();
  const unique = [...new Set((ips || []).map(ip => String(ip || '').trim()).filter(ip => net.isIP(ip)))];
  if (!apiKey || !unique.length) return found;

  const pending = [];
  for (const ip of unique) {
    const cached = cacheGet(ip);
    if (cached) found.set(ip, cached.normalized);
    else pending.push(ip);
  }

  for (let start = 0; start < pending.length; start += BULK_CHUNK_SIZE) {
    if (quotaBlockedUntil > Date.now()) break;
    const batch = pending.slice(start, start + BULK_CHUNK_SIZE);
    let response;
    try {
      response = await fetch(`${IPDATA_API}/bulk?api-key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      lastError = String(error?.message || 'ipdata 批量请求失败').slice(0, 240);
      break;
    }

    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }
    if (!response.ok) {
      httpFailure(response.status, data);
      break;
    }
    if (!Array.isArray(data)) {
      lastError = 'ipdata 批量接口未返回数组';
      break;
    }

    data.forEach((entry, index) => {
      const ip = batch[index];
      if (!ip || !entry || (!entry.asn && !entry.company)) return;
      const normalized = normalizeIpdata(entry);
      cacheSet(ip, { response: entry, normalized });
      found.set(ip, normalized);
    });
  }

  return found;
}
