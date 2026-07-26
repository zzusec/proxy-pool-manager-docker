// ─── IP Classification via ipinfo.io ────────────────────────────────────────

const TOKEN_CONCURRENCY = 20;
const FALLBACK_CONCURRENCY = 5;

export async function classifyIp(ip) {
  const token = process.env.IPINFO_TOKEN;
  const url = token
    ? `https://api.ipinfo.io/lite/${encodeURIComponent(ip)}?token=${token}`
    : `https://ipinfo.io/${encodeURIComponent(ip)}/json`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function batchClassify(proxies) {
  const results = [];
  const concurrency = process.env.IPINFO_TOKEN ? TOKEN_CONCURRENCY : FALLBACK_CONCURRENCY;
  for (let i = 0; i < proxies.length; i += concurrency) {
    const batch = proxies.slice(i, i + concurrency);
    const classifyResults = await Promise.allSettled(
      batch.map(p => classifyIp(p.ip))
    );

    for (let j = 0; j < batch.length; j++) {
      const proxy = batch[j];
      const result = classifyResults[j];

      if (result.status === 'fulfilled' && result.value) {
        const info = result.value;
        const org = info.org || '';
        const asn = info.asn || (org.match(/^(AS\d+)/i) || [])[1] || '';
        const asName = info.asName || info.as_name || org.replace(/^AS\d+\s*/i, '');
        const isp = info.isp || asName || org;

        // Classify IP type
        let ipType = 'residential';
        const text = [asn, asName, isp, org].join(' ').toLowerCase();
        const DC_KEYWORDS = ['hosting', 'cloud', 'datacenter', 'data center', 'server', 'vps', 'dedicated', 'colocation', 'virtual', 'ovh', 'hetzner', 'digitalocean', 'vultr', 'linode', 'amazon', 'aws', 'google cloud', 'gcp', 'azure', 'alibaba', 'aliyun', 'tencent', 'oracle cloud', 'scaleway', 'upcloud', 'contabo', 'leaseweb', 'choopa', 'cloudflare'];
        const MOBILE_KEYWORDS = ['mobile', 'wireless', 'cellular', 'lte', '5g', '4g', '3g', 'gsm', 'telecom', 'vodafone', 't-mobile', 'at&t mobility', 'verizon wireless', 'orange', 'telekom', 'china mobile', 'china unicom', 'china telecom', 'reliance', 'airtel', 'movistar', 'claro', 'telcel'];

        if (DC_KEYWORDS.some(k => text.includes(k))) ipType = 'datacenter';
        else if (MOBILE_KEYWORDS.some(k => text.includes(k))) ipType = 'mobile';

        proxy.ipType = ipType;
        proxy.country = info.country || 'unknown';
        proxy.countryName = info.country_name || info.countryName || '';
        proxy.asn = asn;
        proxy.asName = asName;
        proxy.isp = isp;
        proxy.org = org;
        proxy.lastClassifiedAt = new Date().toISOString();
      }

      results.push(proxy);
    }
  }
  return results;
}
