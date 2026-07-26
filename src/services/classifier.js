// ─── IP Classification ──────────────────────────────────────────────────────

const TOKEN_CONCURRENCY = 20;
const FALLBACK_BATCH_SIZE = 100;
const FALLBACK_BATCH_DELAY_MS = 1500;
const IP_API_FIELDS = 'status,country,countryCode,as,isp,org';

export async function classifyIp(ip) {
  const token = process.env.IPINFO_TOKEN;
  const url = token
    ? `https://api.ipinfo.io/lite/${encodeURIComponent(ip)}?token=${token}`
    : `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${IP_API_FIELDS}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.status === 'fail' ? null : data;
  } catch {
    return null;
  }
}

export async function batchClassify(proxies) {
  if (!process.env.IPINFO_TOKEN) return batchClassifyWithIpApi(proxies);

  const results = [];
  for (let i = 0; i < proxies.length; i += TOKEN_CONCURRENCY) {
    const batch = proxies.slice(i, i + TOKEN_CONCURRENCY);
    const classifyResults = await Promise.allSettled(batch.map(proxy => classifyIp(proxy.ip)));

    for (let j = 0; j < batch.length; j++) {
      const proxy = batch[j];
      const result = classifyResults[j];
      if (result.status === 'fulfilled' && result.value) applyClassification(proxy, result.value);
      results.push(proxy);
    }
  }
  return results;
}

async function batchClassifyWithIpApi(proxies) {
  const results = [];

  for (let i = 0; i < proxies.length; i += FALLBACK_BATCH_SIZE) {
    const batch = proxies.slice(i, i + FALLBACK_BATCH_SIZE);
    try {
      const res = await fetch(`http://ip-api.com/batch?fields=${IP_API_FIELDS}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.map(proxy => proxy.ip)),
        signal: AbortSignal.timeout(15000),
      });
      const data = res.ok ? await res.json() : [];
      for (let j = 0; j < batch.length; j++) {
        if (data[j] && data[j].status !== 'fail') applyClassification(batch[j], data[j]);
        results.push(batch[j]);
      }
    } catch {
      results.push(...batch);
    }

    if (i + FALLBACK_BATCH_SIZE < proxies.length) {
      await new Promise(resolve => setTimeout(resolve, FALLBACK_BATCH_DELAY_MS));
    }
  }

  return results;
}

function applyClassification(proxy, info) {
  const org = info.org || '';
  const asValue = info.asn || info.as || '';
  const asn = (asValue.match(/AS\d+/i) || [])[0] || '';
  const asName = info.asName || info.as_name || asValue.replace(/^AS\d+\s*/i, '') || org;
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
