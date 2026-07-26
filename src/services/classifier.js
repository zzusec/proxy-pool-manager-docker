import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import { open } from 'maxmind';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_CONCURRENCY = 20;
const FALLBACK_BATCH_SIZE = 100;
const FALLBACK_BATCH_DELAY_MS = 1500;
const IP_API_FIELDS = 'status,country,countryCode,as,isp,org';
const GEO_LITE_DIR = path.join(process.env.DATA_DIR || path.resolve(__dirname, '..', 'data'), 'geolite');

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
  const country = countryRecord?.country || countryRecord?.registered_country || null;
  const countryCode = country?.iso_code || '';
  const countryName = country?.names?.en || '';
  const autonomousSystemNumber = asnRecord?.autonomous_system_number;
  const asn = autonomousSystemNumber ? `AS${autonomousSystemNumber}` : '';
  const org = asnRecord?.autonomous_system_organization || '';

  if (!countryCode && !asn) return null;
  return {
    countryCode,
    country: countryName,
    asn,
    asName: org,
    isp: org,
    org,
  };
}

export async function classifyIp(ip) {
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

export async function batchClassify(proxies) {
  const readers = await getReaders();
  const missingLocalData = [];
  for (const proxy of proxies) {
    const info = localInfo(proxy.ip, readers);
    if (info) applyClassification(proxy, info);
    else missingLocalData.push(proxy);
  }

  if (!missingLocalData.length) return proxies;
  if (!process.env.IPINFO_TOKEN) {
    await batchClassifyWithIpApi(missingLocalData);
    return proxies;
  }

  for (let i = 0; i < missingLocalData.length; i += TOKEN_CONCURRENCY) {
    const batch = missingLocalData.slice(i, i + TOKEN_CONCURRENCY);
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

  let ipType = 'residential';
  const text = [asn, asName, isp, org].join(' ').toLowerCase();
  const DC_KEYWORDS = ['hosting', 'cloud', 'datacenter', 'data center', 'server', 'vps', 'dedicated', 'colocation', 'virtual', 'ovh', 'hetzner', 'digitalocean', 'vultr', 'linode', 'amazon', 'aws', 'google cloud', 'gcp', 'azure', 'alibaba', 'aliyun', 'tencent', 'oracle cloud', 'scaleway', 'upcloud', 'contabo', 'leaseweb', 'choopa', 'cloudflare'];
  const MOBILE_KEYWORDS = ['mobile', 'wireless', 'cellular', 'lte', '5g', '4g', '3g', 'gsm', 'telecom', 'vodafone', 't-mobile', 'at&t mobility', 'verizon wireless', 'orange', 'telekom', 'china mobile', 'china unicom', 'china telecom', 'reliance', 'airtel', 'movistar', 'claro', 'telcel'];
  if (DC_KEYWORDS.some(keyword => text.includes(keyword))) ipType = 'datacenter';
  else if (MOBILE_KEYWORDS.some(keyword => text.includes(keyword))) ipType = 'mobile';

  proxy.ipType = ipType;
  proxy.country = info.countryCode || info.country || 'unknown';
  proxy.countryName = info.country_name || info.countryName || (info.countryCode ? info.country : '');
  proxy.asn = asn;
  proxy.asName = asName;
  proxy.isp = isp;
  proxy.org = org;
  proxy.lastClassifiedAt = new Date().toISOString();
}
