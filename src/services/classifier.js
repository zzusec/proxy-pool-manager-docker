// ─── IP Classification via ipinfo.io ────────────────────────────────────────

const CLASSIFY_CONCURRENCY = 20;

export async function classifyIp(ip) {
  const token = process.env.IPINFO_TOKEN;
  if (!token) return null;

  try {
    const res = await fetch(`https://api.ipinfo.io/lite/${ip}?token=${token}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function batchClassify(proxies) {
  const results = [];
  for (let i = 0; i < proxies.length; i += CLASSIFY_CONCURRENCY) {
    const batch = proxies.slice(i, i + CLASSIFY_CONCURRENCY);
    const classifyResults = await Promise.allSettled(
      batch.map(p => classifyIp(p.ip))
    );

    for (let j = 0; j < batch.length; j++) {
      const proxy = batch[j];
      const result = classifyResults[j];

      if (result.status === 'fulfilled' && result.value) {
        const info = result.value;
        const asn = info.asn || '';
        const asName = info.asName || info.as_name || '';
        const isp = info.isp || '';
        const org = info.org || '';

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
