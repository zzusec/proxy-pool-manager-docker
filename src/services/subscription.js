import dns from 'node:dns/promises';
import net from 'node:net';
import { isValidIp, parseProxyLine } from '../utils/helpers.js';

const MAX_SUBSCRIPTION_URLS = 20;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

function isPrivateAddress(address) {
  if (net.isIP(address) === 0) return true; // Not a valid IP
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224; // Multicast or broadcast
  }

  if (net.isIP(address) === 6) {
    const value = address.toLowerCase();
    return value === '::' || value === '::1' || value.startsWith('fc') ||
      value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') ||
      value.startsWith('fea') || value.startsWith('feb') || value.startsWith('::ffff:127.') ||
      value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.');
  }

  return false;
}

async function validateUrl(url) {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('订阅链接只支持 HTTP 或 HTTPS');
  }
  if (!url.hostname || url.username || url.password) {
    throw new Error('订阅链接格式不安全');
  }
  if (url.hostname.toLowerCase() === 'localhost') {
    throw new Error('订阅链接不能指向本机');
  }

  const resolved = net.isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dns.lookup(url.hostname, { all: true });

  if (!resolved.length || resolved.some(entry => isPrivateAddress(entry.address))) {
    throw new Error('订阅链接不能指向内网地址');
  }
}

async function readResponseText(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('订阅内容超过 5MB 限制');
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > MAX_RESPONSE_BYTES) throw new Error('订阅内容超过 5MB 限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
}

// Airport panels route by client User-Agent and answer a generic one with 403,
// so identify as a real subscription client.
const SUBSCRIPTION_USER_AGENT = process.env.SUBSCRIPTION_USER_AGENT || 'clash-verge/v1.7.7';
const POOL_RETRY_LIMIT = Number.parseInt(process.env.SUBSCRIPTION_POOL_RETRIES || '', 10) || 3;

/**
 * Fetch through one of our own live proxies. Providers commonly refuse to serve
 * a subscription to datacenter IPs ("網絡環境存在風險"), and a residential exit
 * from the pool is exactly what gets past that.
 */
async function fetchSubscriptionViaPool(urlText) {
  const { listProxies } = await import('../db.js');
  const { ProxyAgent, fetch: proxiedFetch } = await import('undici');
  const candidates = [
    ...listProxies({ alive: 'true', type: 'residential', protocol: 'http', limit: POOL_RETRY_LIMIT }).proxies,
    ...listProxies({ alive: 'true', protocol: 'http', limit: POOL_RETRY_LIMIT }).proxies,
  ].slice(0, POOL_RETRY_LIMIT);

  const attempts = [];
  for (const proxy of candidates) {
    const credentials = proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@` : '';
    try {
      const response = await proxiedFetch(urlText, {
        dispatcher: new ProxyAgent(`http://${credentials}${proxy.ip}:${proxy.port}`),
        headers: { 'User-Agent': SUBSCRIPTION_USER_AGENT, Accept: 'text/plain, text/yaml, */*' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) { attempts.push(`${proxy.ip}: HTTP ${response.status}`); continue; }
      const text = await response.text();
      if (extractSupportedProxyLines(text).length) return { content: text, via: `${proxy.ip}:${proxy.port}` };
      attempts.push(`${proxy.ip}: 无节点`);
    } catch (error) {
      attempts.push(`${proxy.ip}: ${String(error.message || '失败').slice(0, 40)}`);
    }
  }
  return { content: '', attempts };
}

async function fetchSubscription(urlText) {
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error('订阅链接格式无效');
  }

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await validateUrl(url);
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': SUBSCRIPTION_USER_AGENT, Accept: 'text/plain, text/yaml, */*' },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('订阅重定向缺少地址');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`订阅请求失败 (${response.status})`);
    return readResponseText(response);
  }

  throw new Error('订阅重定向次数过多');
}

function decodeBase64Subscription(text) {
  const compact = text.replace(/\s/g, '');
  if (compact.length < 16 || compact.length % 4 === 1 || !/^[A-Za-z0-9+/_=-]+$/.test(compact)) {
    return text;
  }

  try {
    const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(normalized, 'base64').toString('utf8').replace(/^﻿/, '');
    // Check for any supported protocol scheme or IP:port format
    const hasProxyContent = /(?:https?|socks[45]|hysteria2|hy2|vmess|vless|trojan|ss):\/\/|^\d{1,3}(?:\.\d{1,3}){3}:\d+/m.test(decoded);
    return hasProxyContent ? decoded : text;
  } catch {
    return text;
  }
}

// Parse single proxy line from Clash YAML format (name: "xxx", type: "xxx", server: "xxx", port: xxx)
function parseClashInlineProxy(text) {
  // Match: { name: "xxx", type: "hysteria2", server: "xxx", port: xxx, ... }
  const m = text.match(/^\s*\{\s*(.+)\s*\}\s*$/);
  if (!m) return null;

  const pairs = m[1].split(/,\s*/);
  const proxy = {};
  for (const pair of pairs) {
    const kv = pair.match(/^(\w+):\s*['"]?(.+?)['"]?\s*$/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].replace(/^['"]|['"]$/g, '');
      proxy[key] = val;
    }
  }

  if (!proxy.type || !proxy.server || !proxy.port) return null;

  const supportedTypes = ['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'hy2', 'tuic', 'wireguard', 'http', 'socks5'];
  if (!supportedTypes.includes(proxy.type)) return null;

  return {
    protocol: proxy.type === 'socks5' ? 'socks5' : proxy.type,
    ip: proxy.server,
    port: parseInt(proxy.port),
    username: proxy.user || proxy.username || '',
    password: proxy.password || '',
    name: proxy.name || '',
    extra: proxy,
  };
}

export function extractSupportedProxyLines(content) {
  const decoded = decodeBase64Subscription(content);
  const seen = new Set();
  const lines = [];

  // Check if content is Clash YAML format
  if (decoded.includes('proxies:') && /\btype:\s*['"]?(ss|ssr|vmess|vless|trojan|hysteria|hysteria2|hy2|tuic|wireguard|http|socks5)['"]?/i.test(decoded)) {
    // Parse Clash YAML and convert to URI format
    const clashProxies = parseClashYamlProxies(decoded);
    for (const cp of clashProxies) {
      const uri = convertClashProxyToUri(cp);
      if (uri && !seen.has(uri)) {
        seen.add(uri);
        lines.push(uri);
      }
    }
    return lines;
  }

  // Standard URI parsing
  for (const line of decoded.split(/\r?\n/)) {
    const parsed = parseProxyLine(line);
    if (!parsed) continue;

    // For new protocols, allow domain names; for HTTP/SOCKS, require valid IP
    const isNewProtocol = ['hysteria2', 'hy2', 'vmess', 'vless', 'trojan', 'ss'].includes(parsed.protocol);
    const validHost = isNewProtocol ? (!!parsed.ip) : isValidIp(parsed.ip);

    if (!validHost || parsed.port < 1 || parsed.port > 65535) continue;

    // Include extra fields in the key for protocols that use them
    const extraKey = parsed.extra ? JSON.stringify(parsed.extra) : '';
    const key = `${parsed.protocol}|${parsed.ip}|${parsed.port}|${parsed.username}|${parsed.password}|${extraKey}`;

    if (!seen.has(key)) {
      seen.add(key);
      lines.push(line.trim());
    }
  }

  return lines;
}

// Parse Clash YAML proxies section into structured objects
function parseClashYamlProxies(yamlText) {
  const proxies = [];
  const lines = yamlText.split('\n');
  let inProxies = false;
  let currentProxy = null;

  const PROXY_TYPES = new Set(['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'hy2', 'tuic', 'wireguard', 'http', 'socks5']);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (/^proxies:/.test(trimmed)) { inProxies = true; continue; }
    if (!inProxies) continue;

    // End of proxies section (new top-level key)
    if (!line.startsWith(' ') && !line.startsWith('\t') && !trimmed.startsWith('-')) {
      if (currentProxy && currentProxy.type && PROXY_TYPES.has(currentProxy.type.replace(/['"]/g, ''))) {
        proxies.push(currentProxy);
      }
      currentProxy = null;
      inProxies = false;
      continue;
    }

    // New proxy entry starts with '-'
    const dashMatch = line.match(/^(\s*)-\s+(.*)/);
    if (dashMatch) {
      // Save previous proxy
      if (currentProxy && currentProxy.type && PROXY_TYPES.has(currentProxy.type.replace(/['"]/g, ''))) {
        proxies.push(currentProxy);
      }
      currentProxy = {};

      // Check for inline format: - { name: "xxx", type: "xxx", server: "xxx", port: xxx }
      const inlineMatch = dashMatch[2].match(/^\{(.+)\}$/);
      if (inlineMatch) {
        const pairs = inlineMatch[1].split(/,\s*/);
        for (const pair of pairs) {
          const kv = pair.match(/^(\w+):\s*['"]?(.+?)['"]?\s*$/);
          if (kv) {
            const key = kv[1];
            const val = kv[2].replace(/^['"]|['"]$/g, '');
            currentProxy[key] = val;
          }
        }
        continue;
      }

      // Start of multi-line proxy definition
      const nameMatch = dashMatch[2].match(/^name:\s*['"]?(.+?)['"]?\s*$/);
      if (nameMatch) currentProxy.name = nameMatch[1].replace(/^['"]|['"]$/g, '');
      const typeMatch = dashMatch[2].match(/^type:\s*['"]?(.+?)['"]?\s*$/);
      if (typeMatch) currentProxy.type = typeMatch[1].replace(/^['"]|['"]$/g, '');
      continue;
    }

    // Key-value line inside proxy definition
    if (!currentProxy) continue;

    const kvMatch = trimmed.match(/^(\w[\w-]*):\s*['"]?(.+?)['"]?\s*$/);
    if (kvMatch) {
      const key = kvMatch[1];
      let val = kvMatch[2].replace(/^['"]|['"]$/g, '');
      if (key === 'port' || key === 'server') {
        currentProxy[key] = key === 'port' ? parseInt(val) : val;
      } else {
        currentProxy[key] = val;
      }
    }
  }

  // Don't forget the last proxy
  if (currentProxy && currentProxy.type && PROXY_TYPES.has(currentProxy.type.replace(/['"]/g, ''))) {
    proxies.push(currentProxy);
  }

  return proxies;
}

// Convert Clash proxy object to URI format for storage
function convertClashProxyToUri(proxy) {
  if (!proxy.server || !proxy.port) return null;

  const protocol = proxy.type;

  // For hysteria2/hy2, construct URI
  if (protocol === 'hysteria2' || protocol === 'hy2') {
    const password = proxy.password || '';
    const sni = proxy.sni || proxy.servername || proxy.server;
    const obfs = proxy['obfs'] || proxy['obfs-type'] || '';
    const obfsPassword = proxy['obfs-password'] || '';
    const name = proxy.name ? `#${encodeURIComponent(proxy.name)}` : '';

    let uri = `hysteria2://${password}@${proxy.server}:${proxy.port}?sni=${sni}`;
    if (obfs) uri += `&obfs=${obfs}`;
    if (obfsPassword) uri += `&obfs-password=${obfsPassword}`;
    uri += name;
    return uri;
  }

  // For vless, construct URI
  if (protocol === 'vless') {
    const uuid = proxy.uuid || proxy.user || '';
    const network = proxy.network || 'tcp';
    const security = proxy.tls ? 'tls' : '';
    const sni = proxy.servername || proxy.sni || '';
    const name = proxy.name ? `#${encodeURIComponent(proxy.name)}` : '';

    let uri = `vless://${uuid}@${proxy.server}:${proxy.port}?type=${network}`;
    if (security) uri += `&security=${security}`;
    if (sni) uri += `&sni=${sni}`;
    uri += name;
    return uri;
  }

  // For trojan, construct URI
  if (protocol === 'trojan') {
    const password = proxy.password || '';
    const sni = proxy.servername || proxy.sni || proxy.server;
    const name = proxy.name ? `#${encodeURIComponent(proxy.name)}` : '';
    return `trojan://${password}@${proxy.server}:${proxy.port}?sni=${sni}&security=tls${name}`;
  }

  // For vmess, construct base64 JSON URI
  if (protocol === 'vmess') {
    const vmessObj = {
      v: '2',
      ps: proxy.name || '',
      add: proxy.server,
      port: proxy.port,
      id: proxy.uuid || proxy.user || '',
      net: proxy.network || 'tcp',
      type: proxy['ws-opts'] ? 'ws' : 'none',
      host: proxy['ws-opts']?.headers?.Host || '',
      path: proxy['ws-opts']?.path || '',
      tls: proxy.tls ? 'tls' : '',
      sni: proxy.servername || proxy.sni || '',
    };
    const base64 = Buffer.from(JSON.stringify(vmessObj)).toString('base64');
    return `vmess://${base64}`;
  }

  // For ss (Shadowsocks), construct URI
  if (protocol === 'ss') {
    const method = proxy.cipher || proxy.method || '';
    const password = proxy.password || '';
    const name = proxy.name ? `#${encodeURIComponent(proxy.name)}` : '';
    const userinfo = Buffer.from(`${method}:${password}`).toString('base64');
    return `ss://${userinfo}@${proxy.server}:${proxy.port}${name}`;
  }

  // For HTTP/SOCKS5, use standard format
  if (protocol === 'http' || protocol === 'socks5') {
    const auth = proxy.username && proxy.password ? `${proxy.username}:${proxy.password}@` : '';
    return `${protocol}://${auth}${proxy.server}:${proxy.port}`;
  }

  // For other protocols, store as JSON-like line (will be parsed by parseProxyLine)
  return JSON.stringify({
    protocol,
    ip: proxy.server,
    port: proxy.port,
    username: proxy.username || proxy.user || '',
    password: proxy.password || '',
    name: proxy.name || '',
  });
}

export async function resolveSubscriptionLinks(inputText) {
  const urls = [];

  // First, try to decode if the entire input is Base64 encoded
  let textToProcess = inputText;
  const compact = inputText.replace(/\s/g, '');
  if (compact.length >= 16 && compact.length % 4 !== 1 && /^[A-Za-z0-9+/_=-]+$/.test(compact)) {
    try {
      const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(normalized, 'base64').toString('utf8').replace(/^﻿/, '');
      const hasProxyContent = /(?:https?|socks[45]|hysteria2|hy2|vmess|vless|trojan|ss):\/\/|^\d{1,3}(?:\.\d{1,3}){3}:\d+/m.test(decoded);
      if (hasProxyContent) {
        textToProcess = decoded;
      }
    } catch {}
  }

  // Check if the text is Clash YAML format
  const isClashYaml = textToProcess.includes('proxies:') &&
    /\btype:\s*['"]?(ss|ssr|vmess|vless|trojan|hysteria|hysteria2|hy2|tuic|wireguard|http|socks5)['"]?/i.test(textToProcess);

  if (isClashYaml) {
    // Parse Clash YAML directly
    const clashProxies = parseClashYamlProxies(textToProcess);
    const proxyLines = [];
    for (const cp of clashProxies) {
      const uri = convertClashProxyToUri(cp);
      if (uri) proxyLines.push(uri);
    }
    return { proxyLines, subscriptions: [] };
  }

  // Standard URI parsing
  const directLines = [];
  for (const line of textToProcess.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    if (parseProxyLine(value)) directLines.push(line);
    else if (/^https?:\/\//i.test(value)) urls.push(value);
    else directLines.push(line);
  }

  if (urls.length > MAX_SUBSCRIPTION_URLS) {
    throw new Error(`一次最多导入 ${MAX_SUBSCRIPTION_URLS} 个订阅链接`);
  }

  const subscriptions = [];
  const proxyLines = [...directLines];
  for (const url of urls) {
    try {
      const content = await fetchSubscription(url);
      let lines = extractSupportedProxyLines(content);
      let via = '';

      if (!lines.length) {
        const retry = await fetchSubscriptionViaPool(url);
        if (retry.content) {
          lines = extractSupportedProxyLines(retry.content);
          via = retry.via;
        }
        if (!lines.length) {
          // Show what the provider actually said instead of a blank result.
          const notice = String(content).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
          throw new Error(notice ? `订阅未返回节点，服务端提示：${notice}` : '订阅未返回可用节点');
        }
      }

      subscriptions.push({ url, ok: true, proxies: lines.length, via });
      proxyLines.push(...lines);
    } catch (error) {
      subscriptions.push({ url, ok: false, proxies: 0, error: error.message || '订阅读取失败' });
    }
  }

  return { proxyLines, subscriptions };
}
