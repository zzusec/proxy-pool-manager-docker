import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import { open } from 'maxmind';
import dns from 'node:dns/promises';
import net from 'node:net';
import { normalizeCountryCode } from '../utils/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_CONCURRENCY = 20;
const FALLBACK_BATCH_SIZE = 100;
const FALLBACK_BATCH_DELAY_MS = 1500;
const IP_API_FIELDS = 'status,country,countryCode,as,isp,org';
const GEO_LITE_DIR = path.join(process.env.DATA_DIR || path.resolve(__dirname, '..', 'data'), 'geolite');
const TESTISP_API = 'https://testisp.info/api/check';

const GEO_LITE_SOURCES = {
  country: [
    'https://github.com/foxterm/GeoLite2/releases/latest/download/GeoLite2-Country.mmdb',
    'https://raw.githubusercontent.com/qNFCp/IP_database/main/geolite/GeoLite2-Country.mmdb',
    'https://raw.gitmirror.com/qNFCp/IP_database/main/geolite/GeoLite2-Country.mmdb',
  ],
  asn: [
    'https://raw.githubusercontent.com/qNFCp/IP_database/main/geolite/GeoLite2-ASN.mmdb',
    'https://raw.gitmirror.com/qNFCp/IP_database/main/geolite/GeoLite2-ASN.mmdb',
  ],
  city: [
    'https://raw.githubusercontent.com/qNFCp/IP_database/main/geolite/GeoLite2-City.mmdb',
    'https://raw.gitmirror.com/qNFCp/IP_database/main/geolite/GeoLite2-City.mmdb',
  ],
};

const GEO_LITE_FILES = {
  country: 'GeoLite2-Country.mmdb',
  asn: 'GeoLite2-ASN.mmdb',
  city: 'GeoLite2-City.mmdb',
};

let readersPromise = null;

function geoLitePath(kind) {
  return path.join(GEO_LITE_DIR, GEO_LITE_FILES[kind]);
}

async function openReader(kind) {
  const file = geoLitePath(kind);
  if (!fs.existsSync(file)) return null;
  try {
    return await open(file);
  } catch (error) {
    console.warn(`[GEOIP] Unable to open ${GEO_LITE_FILES[kind]}: ${error.message}`);
    return null;
  }
}

async function getReaders() {
  if (!readersPromise) {
    readersPromise = Promise.all([
      openReader('country'),
      openReader('asn'),
      openReader('city'),
    ]).then(([country, asn, city]) => ({ country, asn, city }));
  }
  return readersPromise;
}

export async function getGeoLiteStatus() {
  const files = {};
  for (const [kind, fileName] of Object.entries(GEO_LITE_FILES)) {
    try {
      const stat = await fsp.stat(geoLitePath(kind));
      files[kind] = { fileName, available: true, size: stat.size, updatedAt: stat.mtime.toISOString() };
    } catch {
      files[kind] = { fileName, available: false, size: 0, updatedAt: null };
    }
  }
  return {
    directory: GEO_LITE_DIR,
    ready: Object.values(files).some(file => file.available),
    files,
  };
}

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'proxy-pool-manager/1.0' },
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length'));
  if (contentLength && contentLength > 512 * 1024 * 1024) throw new Error('数据库文件过大');
  const temporary = `${destination}.download`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { flags: 'w' }));
  const stat = await fsp.stat(temporary);
  if (stat.size < 1024 * 1024) throw new Error('下载文件过小，不是有效数据库');
  await fsp.rename(temporary, destination);
  return stat.size;
}

/** Download the fixed administrator-approved GeoLite datasets atomically. */
export async function updateGeoLiteDatabases() {
  await fsp.mkdir(GEO_LITE_DIR, { recursive: true });
  const result = {};
  for (const kind of Object.keys(GEO_LITE_FILES)) {
    const destination = geoLitePath(kind);
    const errors = [];
    let downloaded = false;
    for (const source of GEO_LITE_SOURCES[kind]) {
      try {
        const size = await downloadFile(source, destination);
        result[kind] = { ok: true, size, source };
        downloaded = true;
        break;
      } catch (error) {
        errors.push(`${new URL(source).hostname}: ${error.message}`);
      }
    }
    if (!downloaded) result[kind] = { ok: false, error: errors.join('；') };
  }
  readersPromise = null;
  return { result, status: await getGeoLiteStatus() };
}

function localInfo(ip, readers) {
  const countryRecord = readers.country?.get(ip) || readers.city?.get(ip) || null;
  const asnRecord = readers.asn?.get(ip) || null;
  // `registered_country` is where the address block's owner is incorporated —
  // for hosting ranges that is often a different country than where the IP is
  // actually served from. Only the geographic country describes what a target
  // site sees, so never fall back to the registration country here.
  const country = countryRecord?.country || null;
  const countryCode = country?.iso_code || '';
  const countryName = country?.names?.en || '';
  const registeredCountry = countryRecord?.registered_country?.iso_code || '';
  const autonomousSystemNumber = asnRecord?.autonomous_system_number;
  const asn = autonomousSystemNumber ? `AS${autonomousSystemNumber}` : '';
  const org = asnRecord?.autonomous_system_organization || '';

  if (!countryCode && !asn) return null;
  return {
    countryCode,
    country: countryName,
    registeredCountry,
    asn,
    asName: org,
    isp: org,
    org,
  };
}

export async function lookupTestIsp(ip) {
  let queriedIp = ip;
  try {
    if (!net.isIP(ip)) queriedIp = (await dns.lookup(ip)).address;
  } catch (error) {
    return { status: 'resolve_error', queriedIp, httpStatus: null, response: {}, error: `无法解析代理主机名：${String(error?.message || ip).slice(0, 180)}` };
  }
  try {
    const response = await fetch(`${TESTISP_API}?ip=${encodeURIComponent(queriedIp)}`, {
      signal: AbortSignal.timeout(8000),
      headers: { 'Accept': 'application/json' },
    });
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok) return { status: 'http_error', queriedIp, httpStatus: response.status, response: data || {}, error: `TestISP 返回 HTTP ${response.status}` };
    if (!data?.isp?.type || /unknown|未知/i.test(data.isp.type)) {
      return { status: 'no_data', queriedIp, httpStatus: response.status, response: data || {}, error: 'TestISP 未返回明确网络类型' };
    }
    return { status: 'success', queriedIp, httpStatus: response.status, response: data, normalized: convertTestispResult(data) };
  } catch (error) {
    return { status: 'transport_error', queriedIp, httpStatus: null, response: {}, error: String(error?.message || 'TestISP 请求失败').slice(0, 240) };
  }
}

/**
 * Derive the IP type from an ispinfo.io answer. ispinfo is queried through the
 * proxy itself, so it describes the real exit address rather than the entry one.
 */
export function ispInfoType(normalized = {}) {
  if (normalized.isMobile) return 'mobile';
  const companyType = String(normalized.companyType || '').toLowerCase();
  if (normalized.isDatacenter || /hosting|datacenter|data_center/.test(companyType)) return 'datacenter';
  if (normalized.isDualIsp || companyType === 'isp') return 'residential';
  return 'unknown';
}

/**
 * Country of an address from the local MaxMind database — the industry baseline
 * and the best answer available when a proxy cannot be probed directly.
 */
export async function lookupCountryLocal(ip) {
  const readers = await getReaders();
  if (!readers.country && !readers.city) return null;
  const record = readers.country?.get(ip) || readers.city?.get(ip) || null;
  const code = normalizeCountryCode(record?.country?.iso_code);
  if (!code) return null;
  return {
    countryCode: code,
    countryName: record?.country?.names?.en || '',
    registeredCountry: normalizeCountryCode(record?.registered_country?.iso_code),
  };
}

/**
 * Country from ipinfo.io. With a token the batch endpoint resolves up to 1000
 * addresses per call; without one we fall back to the anonymous endpoint, which
 * is rate limited to roughly 1k lookups a day.
 */
export async function lookupCountryIpinfo(ips) {
  const token = String(process.env.IPINFO_TOKEN || '').trim();
  const unique = [...new Set(ips.filter(ip => net.isIP(ip)))];
  const found = new Map();
  if (!unique.length) return found;

  if (token) {
    for (let start = 0; start < unique.length; start += 1000) {
      const batch = unique.slice(start, start + 1000);
      try {
        const response = await fetch(`https://ipinfo.io/batch?token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batch.map(ip => `${ip}/json`)),
          signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        for (const [key, value] of Object.entries(data || {})) {
          const code = normalizeCountryCode(value?.country);
          if (code) found.set(key.replace('/json', ''), { countryCode: code, countryName: '' });
        }
      } catch (error) {
        console.warn('[GEOIP] ipinfo batch failed:', error.message);
        break;
      }
    }
    return found;
  }

  // Anonymous: keep it modest and stop as soon as we are throttled.
  for (const ip of unique.slice(0, 200)) {
    try {
      const response = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, { signal: AbortSignal.timeout(10000) });
      if (response.status === 429) break;
      if (!response.ok) continue;
      const data = await response.json();
      const code = normalizeCountryCode(data?.country);
      if (code) found.set(ip, { countryCode: code, countryName: '' });
    } catch { /* skip this address */ }
  }
  return found;
}

export async function classifyIp(ip) {
  // TestISP is deliberately queried before local GeoLite data: its IP-type result
  // is more useful than inferring residential/datacenter from an ASN name.
  const testisp = await lookupTestIsp(ip);
  if (testisp.status === 'success') return testisp.normalized;

  const local = localInfo(ip, await getReaders());
  if (local) return local;

  const token = process.env.IPINFO_TOKEN;
  const url = token
    ? `https://api.ipinfo.io/lite/${encodeURIComponent(ip)}?token=${token}`
    : `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${IP_API_FIELDS}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const data = await response.json();
    return data.status === 'fail' ? null : data;
  } catch {
    return null;
  }
}

// Convert testisp.info response to standard classification format
function convertTestispResult(data) {
  const isp = data.isp || {};
  const geo = data.geo || {};

  // Parse IP type from testisp.info format
  // Examples: "住宅网络 (Residential)", "机房网络 (Datacenter)", "移动网络 (Mobile)"
  let ipType = 'unknown';
  const typeStr = (isp.type || '').toLowerCase();
  if (typeStr.includes('机房') || typeStr.includes('datacenter') || typeStr.includes('hosting')) {
    ipType = 'datacenter';
  } else if (typeStr.includes('移动') || typeStr.includes('mobile') || typeStr.includes('wireless') || typeStr.includes('cellular')) {
    ipType = 'mobile';
  } else if (typeStr.includes('住宅') || typeStr.includes('residential')) {
    ipType = 'residential';
  }

  // Parse ASN from format like "AS12345"
  const asnMatch = (isp.asn || '').match(/AS(\d+)/i);
  const asn = asnMatch ? `AS${asnMatch[1]}` : '';

  return {
    countryCode: geo.country_code || 'unknown',
    country: geo.country || '',
    asn,
    asName: isp.org || '',
    isp: isp.org || '',
    org: isp.org || '',
    ipType,
    source: 'testisp',
    // Preserve original testisp data for reference
    _testisp: {
      native_type: geo.native_type,
      flag: isp.flag,
      warning: isp.warning,
    },
  };
}

export async function batchClassify(proxies) {
  // Always go through classifyIp so TestISP is consulted for every IP, including
  // IPs present in GeoLite. The local database remains the fallback when TestISP
  // cannot identify a network type.
  for (let i = 0; i < proxies.length; i += TOKEN_CONCURRENCY) {
    const batch = proxies.slice(i, i + TOKEN_CONCURRENCY);
    const classifyResults = await Promise.allSettled(batch.map(proxy => classifyIp(proxy.ip)));
    for (let j = 0; j < batch.length; j++) {
      const result = classifyResults[j];
      if (result.status === 'fulfilled' && result.value) applyClassification(batch[j], result.value);
    }
  }
  return proxies;
}

async function batchClassifyWithIpApi(proxies) {
  for (let i = 0; i < proxies.length; i += FALLBACK_BATCH_SIZE) {
    const batch = proxies.slice(i, i + FALLBACK_BATCH_SIZE);
    try {
      const response = await fetch(`http://ip-api.com/batch?fields=${IP_API_FIELDS}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.map(proxy => proxy.ip)),
        signal: AbortSignal.timeout(15000),
      });
      const data = response.ok ? await response.json() : [];
      for (let j = 0; j < batch.length; j++) {
        if (data[j] && data[j].status !== 'fail') applyClassification(batch[j], data[j]);
      }
    } catch {}
    if (i + FALLBACK_BATCH_SIZE < proxies.length) {
      await new Promise(resolve => setTimeout(resolve, FALLBACK_BATCH_DELAY_MS));
    }
  }
}

function applyClassification(proxy, info) {
  const org = info.org || '';
  const asValue = info.asn || info.as || '';
  const asn = (String(asValue).match(/AS\d+/i) || [])[0] || '';
  const asName = info.asName || info.as_name || String(asValue).replace(/^AS\d+\s*/i, '') || org;
  const isp = info.isp || asName || org;

  // Use ipType from testisp if available, otherwise classify by keywords
  let ipType = info.ipType || 'residential';
  if (info.source !== 'testisp') {
    const text = [asn, asName, isp, org].join(' ').toLowerCase();
    const DC_KEYWORDS = ['hosting', 'cloud', 'datacenter', 'data center', 'server', 'vps', 'dedicated', 'colocation', 'virtual', 'ovh', 'hetzner', 'digitalocean', 'vultr', 'linode', 'amazon', 'aws', 'google cloud', 'gcp', 'azure', 'alibaba', 'aliyun', 'tencent', 'oracle cloud', 'scaleway', 'upcloud', 'contabo', 'leaseweb', 'choopa', 'cloudflare'];
    const MOBILE_KEYWORDS = ['mobile', 'wireless', 'cellular', 'lte', '5g', '4g', '3g', 'gsm', 'telecom', 'vodafone', 't-mobile', 'at&t mobility', 'verizon wireless', 'orange', 'telekom', 'china mobile', 'china unicom', 'china telecom', 'reliance', 'airtel', 'movistar', 'claro', 'telcel'];
    if (DC_KEYWORDS.some(keyword => text.includes(keyword))) ipType = 'datacenter';
    else if (MOBILE_KEYWORDS.some(keyword => text.includes(keyword))) ipType = 'mobile';
  }

  proxy.ipType = ipType;
  // Never let a lookup downgrade a known country to "Unknown".
  const countryCode = normalizeCountryCode(info.countryCode || info.country_code || info.country);
  if (countryCode) {
    proxy.country = countryCode;
    proxy.countryName = info.country_name || info.countryName || (info.countryCode ? info.country : '');
  } else if (!proxy.country) {
    proxy.country = 'unknown';
  }
  proxy.asn = asn;
  proxy.asName = asName;
  proxy.isp = isp;
  proxy.org = org;
  proxy.lastClassifiedAt = new Date().toISOString();

  // Store testisp metadata if available
  if (info._testisp) {
    proxy.testispMeta = info._testisp;
  }
}
