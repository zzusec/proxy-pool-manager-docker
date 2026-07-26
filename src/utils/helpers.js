import crypto from 'crypto';

// ─── Proxy Parsing ──────────────────────────────────────────────────────────

export function parseProxyLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;

  // protocol://user:pass@ip:port
  let m = trimmed.match(/^(https?|socks[45]):\/\/([^:]+):([^@]+)@(\[[\da-fA-F:]+\]|[\d.]+):(\d+)$/i);
  if (m) return { protocol: m[1].toLowerCase().replace('socks4', 'socks5'), username: m[2], password: m[3], ip: m[4].replace(/^\[|\]$/g, ''), port: parseInt(m[5]) };

  // protocol://ip:port
  m = trimmed.match(/^(https?|socks[45]):\/\/(\[[\da-fA-F:]+\]|[\d.]+):(\d+)$/i);
  if (m) return { protocol: m[1].toLowerCase().replace('socks4', 'socks5'), username: '', password: '', ip: m[2].replace(/^\[|\]$/g, ''), port: parseInt(m[3]) };

  // user:pass@ip:port
  m = trimmed.match(/^([^:]{1,64}):([^@]{1,64})@(\[[\da-fA-F:]+\]|[\d.]+):(\d+)$/);
  if (m) return { protocol: 'http', username: m[1], password: m[2], ip: m[3].replace(/^\[|\]$/g, ''), port: parseInt(m[4]) };

  // ip:port:user:pass
  m = trimmed.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+):([^:]{1,64}):(.{1,64})$/);
  if (m) return { protocol: 'http', username: m[3], password: m[4], ip: m[1], port: parseInt(m[2]) };

  // ip:port
  m = trimmed.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/);
  if (m) return { protocol: 'http', username: '', password: '', ip: m[1], port: parseInt(m[2]) };

  // [ipv6]:port
  m = trimmed.match(/^\[([\da-fA-F:]+)\]:(\d+)$/);
  if (m) return { protocol: 'http', username: '', password: '', ip: m[1], port: parseInt(m[2]) };

  // [ipv6]:port:user:pass
  m = trimmed.match(/^\[([\da-fA-F:]+)\]:(\d+):([^:]{1,64}):(.{1,64})$/);
  if (m) return { protocol: 'http', username: m[3], password: m[4], ip: m[1], port: parseInt(m[2]) };

  return null;
}

// Parse Clash/Mihomo YAML proxies section
export function parseClashYaml(yamlText) {
  const proxies = [];
  const lines = yamlText.split('\n');
  let inProxies = false;
  let currentProxy = null;
  let proxyIndent = 0;

  const PROXY_TYPES = new Set(['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'wireguard', 'http', 'socks5']);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (/^proxies:/.test(trimmed)) { inProxies = true; continue; }
    if (!inProxies) continue;

    if (!line.startsWith(' ') && !line.startsWith('\t') && !trimmed.startsWith('-')) {
      if (currentProxy && currentProxy.type && PROXY_TYPES.has(currentProxy.type.replace(/['"]/g, ''))) {
        proxies.push(currentProxy);
      }
      currentProxy = null;
      inProxies = false;
      continue;
    }

    const dashMatch = line.match(/^(\s*)-\s+(.*)/);
    if (dashMatch) {
      if (currentProxy && currentProxy.type && PROXY_TYPES.has(currentProxy.type.replace(/['"]/g, ''))) {
        proxies.push(currentProxy);
      }
      currentProxy = {};
      proxyIndent = dashMatch[1].length;

      const inlineMatch = dashMatch[2].match(/^\{(.+)\}$/);
      if (inlineMatch) {
        const pairs = inlineMatch[1].split(',');
        for (const pair of pairs) {
          const kv = pair.trim().match(/^(\w+):\s*['"]?(.+?)['"]?\s*$/);
          if (kv) {
            const key = kv[1];
            const val = kv[2].replace(/^['"]|['"]$/g, '');
            if (key === 'name') currentProxy.name = val;
            else if (key === 'type') currentProxy.type = val;
            else if (key === 'server') currentProxy.server = val;
            else if (key === 'port') currentProxy.port = parseInt(val);
          }
        }
        continue;
      }

      const nameMatch = dashMatch[2].match(/^name:\s*['"]?(.+?)['"]?\s*$/);
      if (nameMatch) currentProxy.name = nameMatch[1].replace(/^['"]|['"]$/g, '');
      const typeMatch = dashMatch[2].match(/^type:\s*['"]?(.+?)['"]?\s*$/);
      if (typeMatch) currentProxy.type = typeMatch[1].replace(/^['"]|['"]$/g, '');
      continue;
    }

    if (!currentProxy) continue;

    const kvMatch = trimmed.match(/^(\w[\w-]*):\s*['"]?(.+?)['"]?\s*$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const val = kvMatch[2].replace(/^['"]|['"]$/g, '');
      if (key === 'name') currentProxy.name = val;
      else if (key === 'type') currentProxy.type = val;
      else if (key === 'server') currentProxy.server = val;
      else if (key === 'port') currentProxy.port = parseInt(val);
    }
  }

  if (currentProxy && currentProxy.type && PROXY_TYPES.has(currentProxy.type.replace(/['"]/g, ''))) {
    proxies.push(currentProxy);
  }

  return proxies.map(p => ({
    protocol: p.type === 'socks5' ? 'socks5' : 'http',
    ip: p.server || '',
    port: p.port || 0,
    username: '',
    password: '',
    name: p.name || '',
  })).filter(p => p.ip && p.port);
}

export function isValidIp(ip) {
  return /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[\da-fA-F:]+)$/.test(ip);
}

export function proxyKey(proxy) {
  return `${proxy.ip}:${proxy.port}:${proxy.protocol}`;
}

export function generateId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

// ─── IP Classification ──────────────────────────────────────────────────────

const DC_KEYWORDS = ['hosting', 'cloud', 'datacenter', 'data center', 'server', 'vps', 'dedicated', 'colocation', 'colo', 'hypervisor', 'vmware', 'virtual', 'ovh', 'hetzner', 'digitalocean', 'vultr', 'linode', 'amazon', 'aws', 'google cloud', 'gcp', 'microsoft azure', 'azure', 'alibaba cloud', 'aliyun', 'tencent cloud', 'oracle cloud', 'scaleway', 'upcloud', 'kamatera', 'contabo', 'leaseweb', 'choopa', 'quadranet', 'psychz', 'buyvm', 'hostwinds', 'cloudflare'];
const MOBILE_KEYWORDS = ['mobile', 'wireless', 'cellular', 'lte', '5g', '4g', '3g', 'gsm', 'umts', 'telecom', 'telefonica', 'vodafone', 't-mobile', 'at&t mobility', 'verizon wireless', 'sprint', 'orange', 'telekom', 'china mobile', 'china unicom', 'china telecom', 'reliance', 'airtel', 'bharti', 'movistar', 'claro', 'telcel', 'digicel', 'optus', 'telstra'];

export function classifyIpType(asn, asName, isp, org) {
  const text = [asn, asName, isp, org].join(' ').toLowerCase();
  if (DC_KEYWORDS.some(k => text.includes(k))) return 'datacenter';
  if (MOBILE_KEYWORDS.some(k => text.includes(k))) return 'mobile';
  return 'residential';
}

// ─── Response Helpers ───────────────────────────────────────────────────────

export function jsonResponse(res, data, status = 200) {
  res.status(status).json(data);
}

export function htmlResponse(res, html, status = 200) {
  res.status(status).set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  }).send(html);
}

export function redirectTo(res, path, status = 302) {
  res.status(status).set('Location', path).end();
}

export function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

// ─── Same Origin Check ──────────────────────────────────────────────────────

export function isSameOriginRequest(req) {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'same-origin' || fetchSite === 'none') return true;

  const origin = req.headers['origin'];
  const host = req.headers['host'];
  if (origin && host) {
    try { if (new URL(origin).host === host) return true; } catch {}
  }

  const referer = req.headers['referer'];
  if (referer && host) {
    try { if (new URL(referer).host === host) return true; } catch {}
  }

  return false;
}
