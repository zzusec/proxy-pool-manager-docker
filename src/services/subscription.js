import dns from 'node:dns/promises';
import net from 'node:net';
import { isValidIp, parseProxyLine } from '../utils/helpers.js';

const MAX_SUBSCRIPTION_URLS = 20;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

function isPrivateAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224;
  }

  if (net.isIP(address) === 6) {
    const value = address.toLowerCase();
    return value === '::' || value === '::1' || value.startsWith('fc') ||
      value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') ||
      value.startsWith('fea') || value.startsWith('feb') || value.startsWith('::ffff:127.') ||
      value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.');
  }

  return true;
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
      headers: { 'User-Agent': 'Proxy-Pool-Manager/1.0', Accept: 'text/plain, text/yaml, */*' },
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
    return /(?:https?|socks[45]):\/\/|^\d{1,3}(?:\.\d{1,3}){3}:\d+/m.test(decoded) ? decoded : text;
  } catch {
    return text;
  }
}

function extractSupportedProxyLines(content) {
  const decoded = decodeBase64Subscription(content);
  const seen = new Set();
  const lines = [];

  for (const line of decoded.split(/\r?\n/)) {
    const parsed = parseProxyLine(line);
    if (!parsed || !isValidIp(parsed.ip) || parsed.port < 1 || parsed.port > 65535) continue;
    const key = `${parsed.protocol}|${parsed.ip}|${parsed.port}|${parsed.username}|${parsed.password}`;
    if (!seen.has(key)) {
      seen.add(key);
      lines.push(line.trim());
    }
  }

  return lines;
}

export async function resolveSubscriptionLinks(inputText) {
  const directLines = [];
  const urls = [];

  for (const line of inputText.split(/\r?\n/)) {
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
      const lines = extractSupportedProxyLines(content);
      subscriptions.push({ url, ok: true, proxies: lines.length });
      proxyLines.push(...lines);
    } catch (error) {
      subscriptions.push({ url, ok: false, proxies: 0, error: error.message || '订阅读取失败' });
    }
  }

  return { proxyLines, subscriptions };
}
