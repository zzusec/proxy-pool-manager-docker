import crypto from 'crypto';
import net from 'node:net';

// ─── Proxy Parsing ──────────────────────────────────────────────────────────

/**
 * Parse proxy URI formats (hysteria2, vmess, vless, trojan, ss, http, socks)
 * Returns parsed proxy object or null if unrecognized
 */
export function parseProxyLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;

  // hysteria2:// or hy2://
  // Split at # to handle fragment (name), then parse query params
  let m = trimmed.match(/^(hysteria2|hy2):\/\/([^@]+)@([^:]+):(\d+)(\?[^#]*)?(#.*)?$/i);
  if (m) {
    const queryPart = m[5] || '';
    const params = new URLSearchParams(queryPart.replace(/^\?/, ''));
    const name = m[6] ? decodeURIComponent(m[6].replace(/^#/, '')) : '';
    return {
      protocol: 'hysteria2',
      username: m[2],
      password: '',
      ip: m[3],
      port: parseInt(m[4]),
      extra: {
        obfs: params.get('obfs') || '',
        obfsPassword: params.get('obfs-password') || '',
        sni: params.get('sni') || m[3],
        alpn: params.get('alpn') || '',
      },
      name,
    };
  }

  // vless://uuid@server:port?params#name
  m = trimmed.match(/^(vless):\/\/([^@]+)@([^:]+):(\d+)(\?[^#]*)?(#.*)?$/i);
  if (m) {
    const queryPart = m[5] || '';
    const params = new URLSearchParams(queryPart.replace(/^\?/, ''));
    const name = m[6] ? decodeURIComponent(m[6].replace(/^#/, '')) : '';
    return {
      protocol: 'vless',
      username: m[2], // uuid
      password: '',
      ip: m[3],
      port: parseInt(m[4]),
      extra: {
        network: params.get('type') || 'tcp',
        security: params.get('security') || '',
        sni: params.get('sni') || '',
        flow: params.get('flow') || '',
      },
      name,
    };
  }

  // trojan://password@server:port?params#name
  m = trimmed.match(/^(trojan):\/\/([^@]+)@([^:]+):(\d+)(\?[^#]*)?(#.*)?$/i);
  if (m) {
    const queryPart = m[5] || '';
    const params = new URLSearchParams(queryPart.replace(/^\?/, ''));
    const name = m[6] ? decodeURIComponent(m[6].replace(/^#/, '')) : '';
    return {
      protocol: 'trojan',
      username: '',
      password: m[2],
      ip: m[3],
      port: parseInt(m[4]),
      extra: {
        sni: params.get('sni') || m[3],
        security: params.get('security') || 'tls',
      },
      name,
    };
  }

  // vmess://base64json
  m = trimmed.match(/^(vmess):\/\/([A-Za-z0-9+/=_-]+)(#.*)?$/i);
  if (m) {
    try {
      const json = JSON.parse(Buffer.from(m[2], 'base64').toString('utf8'));
      return {
        protocol: 'vmess',
        username: json.id || '', // uuid
        password: '',
        ip: json.add || '',
        port: parseInt(json.port) || 443,
        extra: {
          net: json.net || 'tcp',
          type: json.type || 'none',
          host: json.host || '',
          path: json.path || '',
          tls: json.tls || '',
          sni: json.sni || json.host || '',
        },
        name: json.ps || '',
      };
    } catch {}
  }

  // ss://base64(method:password)@server:port#name or ss://base64@server:port#name
  m = trimmed.match(/^(ss):\/\/([^@]+)@([^:]+):(\d+)(#.*)?$/i);
  if (m) {
    const name = decodeURIComponent(m[5] || '').replace(/^#/, '') || '';
    try {
      const decoded = Buffer.from(m[2], 'base64').toString('utf8');
      const [method, password] = decoded.split(':');
      return {
        protocol: 'ss',
        username: method || '',
        password: password || '',
        ip: m[3],
        port: parseInt(m[4]),
        extra: {},
        name,
      };
    } catch {}
  }

  // Remove fragment for standard parsing
  const withoutFragment = trimmed.replace(/#.*$/, '');

  // protocol://user:pass@ip:port
  m = withoutFragment.match(/^(https?|socks[45]):\/\/([^:]+):([^@]+)@(\[[\da-fA-F:]+\]|[\d.]+):(\d+)$/i);
  if (m) return { protocol: m[1].toLowerCase().replace('socks4', 'socks5'), username: m[2], password: m[3], ip: m[4].replace(/^\[|\]$/g, ''), port: parseInt(m[5]) };

  // protocol://ip:port
  m = withoutFragment.match(/^(https?|socks[45]):\/\/(\[[\da-fA-F:]+\]|[\d.]+):(\d+)$/i);
  if (m) return { protocol: m[1].toLowerCase().replace('socks4', 'socks5'), username: '', password: '', ip: m[2].replace(/^\[|\]$/g, ''), port: parseInt(m[3]) };

  // user:pass@ip:port
  m = withoutFragment.match(/^([^:]{1,64}):([^@]{1,64})@(\[[\da-fA-F:]+\]|[\d.]+):(\d+)$/);
  if (m) return { protocol: 'http', username: m[1], password: m[2], ip: m[3].replace(/^\[|\]$/g, ''), port: parseInt(m[4]) };

  // ip:port:user:pass
  m = withoutFragment.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+):([^:]{1,64}):(.{1,64})$/);
  if (m) return { protocol: 'http', username: m[3], password: m[4], ip: m[1], port: parseInt(m[2]) };

  // ip:port
  m = withoutFragment.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/);
  if (m) return { protocol: 'http', username: '', password: '', ip: m[1], port: parseInt(m[2]) };

  // [ipv6]:port
  m = withoutFragment.match(/^\[([\da-fA-F:]+)\]:(\d+)$/);
  if (m) return { protocol: 'http', username: '', password: '', ip: m[1], port: parseInt(m[2]) };

  // [ipv6]:port:user:pass
  m = withoutFragment.match(/^\[([\da-fA-F:]+)\]:(\d+):([^:]{1,64}):(.{1,64})$/);
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

  const PROXY_TYPES = new Set(['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'hy2', 'tuic', 'wireguard', 'http', 'socks5']);

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
            else if (key === 'password') currentProxy.password = val;
            else if (key === 'uuid' || key === 'user') currentProxy.uuid = val;
            else if (key === 'sni' || key === 'servername') currentProxy.sni = val;
            else if (key === 'network') currentProxy.network = val;
            else currentProxy[key] = val;
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
      else if (key === 'password') currentProxy.password = val;
      else if (key === 'uuid' || key === 'user') currentProxy.uuid = val;
      else if (key === 'sni' || key === 'servername') currentProxy.sni = val;
      else if (key === 'network') currentProxy.network = val;
      else currentProxy[key] = val;
    }
  }

  if (currentProxy && currentProxy.type && PROXY_TYPES.has(currentProxy.type.replace(/['"]/g, ''))) {
    proxies.push(currentProxy);
  }

  // Convert to standard format, preserving protocol type
  return proxies.map(p => {
    const protocol = p.type === 'socks5' ? 'socks5' : p.type;
    return {
      protocol,
      ip: p.server || '',
      port: p.port || 0,
      username: p.uuid || p.user || '',
      password: p.password || '',
      name: p.name || '',
      extra: {
        sni: p.sni || p.servername || '',
        network: p.network || 'tcp',
        obfs: p.obfs || '',
        'obfs-password': p['obfs-password'] || '',
      },
    };
  }).filter(p => p.ip && p.port);
}

export function isValidIp(ip) {
  return net.isIP(String(ip || '')) !== 0;
}

export function proxyKey(proxy) {
  return `${proxy.ip}:${proxy.port}:${proxy.protocol}`;
}

export function generateId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

export function normalizeGroup(value) {
  if (value === undefined || value === null || value === '') return '';
  const normalized = String(value).trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error('分组仅支持字母、数字、点、下划线和连字符，长度不超过 64');
  }
  return normalized;
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
