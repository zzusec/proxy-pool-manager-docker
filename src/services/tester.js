import http from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';
import { SocksClient } from 'socks';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getSetting } from '../db.js';

const DEFAULT_TEST_TARGETS = [
  'http://api.ipify.org?format=json',
  'http://httpbin.org/ip',
  'http://ipinfo.io/json',
];

let activeChecks = 0;
let configuredConcurrency = 10;
const checkWaiters = [];

function readPositiveSetting(key, fallback, min, max) {
  const value = Number.parseInt(getSetting(key), 10);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function getTesterConfig() {
  const timeout = readPositiveSetting('testTimeout', 10000, 1000, 60000);
  const concurrency = readPositiveSetting('testConcurrency', 10, 1, 50);
  let targets = DEFAULT_TEST_TARGETS;
  try {
    const saved = JSON.parse(getSetting('testTargets') || 'null');
    if (Array.isArray(saved) && saved.length === 3 && saved.every(target => {
      const url = new URL(target);
      return url.protocol === 'http:' || url.protocol === 'https:';
    })) targets = saved;
  } catch {}
  return { timeout, concurrency, targets };
}

function releaseCheckSlot() {
  activeChecks--;
  while (checkWaiters.length && activeChecks < configuredConcurrency) {
    activeChecks++;
    checkWaiters.shift()();
  }
}

async function withCheckSlot(concurrency, task) {
  configuredConcurrency = concurrency;
  await new Promise(resolve => {
    if (activeChecks < configuredConcurrency) {
      activeChecks++;
      resolve();
    } else {
      checkWaiters.push(resolve);
    }
  });
  try {
    return await task();
  } finally {
    releaseCheckSlot();
  }
}

function proxyUrl(proxy) {
  const credentials = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  return `${proxy.protocol || 'http'}://${credentials}${proxy.ip}:${proxy.port}`;
}

function errorCategory(error) {
  const code = error?.code;
  if (['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ERR_SOCKS_CONNECTION_FAILED', 'ERR_SOCKS_REQUEST_FAILED'].includes(code)) {
    return 'proxy_failure';
  }
  return 'inconclusive';
}

function extractIp(body) {
  try {
    const data = JSON.parse(body);
    const candidate = data.ip || data.origin || data.query || '';
    const match = String(candidate).match(/(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f:]{2,}/i);
    if (match) return match[0];
  } catch {}
  const match = String(body).match(/(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]{1,4}/i);
  return match ? match[0] : null;
}

function analyseResponse(statusCode, body) {
  if (statusCode < 200 || statusCode >= 300) {
    return { ok: false, category: 'inconclusive', error: `目标返回 HTTP ${statusCode}` };
  }
  const exitIp = extractIp(body);
  if (!exitIp) return { ok: false, category: 'inconclusive', error: '检测目标未返回出口 IP' };
  return { ok: true, exitIp };
}

function readResponse(stream, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let body = '';
    let statusCode = 0;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timeoutError = () => {
      const error = new Error('检测响应超时');
      error.code = 'ETIMEDOUT';
      stream.destroy(error);
      finish(reject, error);
    };
    timer = setTimeout(timeoutError, timeout);
    stream.on('data', chunk => {
      body += chunk.toString('utf8');
      if (body.length > 1024 * 1024) {
        const error = new Error('检测响应过大');
        error.code = 'ERESPONSETOOLARGE';
        stream.destroy(error);
        finish(reject, error);
      }
    });
    stream.once('end', () => finish(resolve, { statusCode, body }));
    stream.once('error', error => finish(reject, error));
    stream.once('close', () => {
      if (!settled) finish(resolve, { statusCode, body });
    });
    stream._setStatusCode = value => { statusCode = value; };
  });
}

function requestThroughHttpProxy(proxy, target, timeout) {
  return new Promise((resolve, reject) => {
    const useTls = target.protocol === 'https:';
    const Agent = useTls ? HttpsProxyAgent : HttpProxyAgent;
    const agent = new Agent(proxyUrl(proxy));
    const transport = useTls ? https : http;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      agent.destroy();
      callback(value);
    };
    const request = transport.request(target, {
      method: 'GET',
      agent,
      headers: {
        Accept: 'application/json, text/plain;q=0.9',
        'User-Agent': 'proxy-pool-manager/1.0',
        Connection: 'close',
      },
    }, async response => {
      try {
        const result = await readResponse(response, timeout);
        finish(resolve, analyseResponse(response.statusCode || 0, result.body));
      } catch (error) {
        finish(reject, error);
      }
    });
    request.setTimeout(timeout, () => {
      const error = new Error('检测连接超时');
      error.code = 'ETIMEDOUT';
      request.destroy(error);
    });
    request.once('error', error => finish(reject, error));
    request.end();
  });
}

async function createSocksConnection(proxy, target, timeout) {
  let expired = false;
  const connection = SocksClient.createConnection({
    proxy: {
      host: proxy.ip,
      port: proxy.port,
      type: proxy.protocol === 'socks4' ? 4 : 5,
      userId: proxy.username || undefined,
      password: proxy.password || undefined,
    },
    command: 'connect',
    destination: {
      host: target.hostname,
      port: Number(target.port) || (target.protocol === 'https:' ? 443 : 80),
    },
    timeout,
  }).then(result => {
    if (expired) result.socket.destroy();
    return result;
  });

  let timer;
  try {
    return await Promise.race([
      connection,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          const error = new Error('SOCKS 连接超时');
          error.code = 'ETIMEDOUT';
          reject(error);
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function requestThroughSocks(proxy, target, timeout) {
  const { socket: rawSocket } = await createSocksConnection(proxy, target, timeout);
  const socket = target.protocol === 'https:'
    ? tls.connect({ socket: rawSocket, servername: target.hostname })
    : rawSocket;
  const path = `${target.pathname || '/'}${target.search || ''}`;
  const responsePromise = readResponse(socket, timeout);
  socket.write(`GET ${path} HTTP/1.1\r\nHost: ${target.host}\r\nAccept: application/json, text/plain;q=0.9\r\nUser-Agent: proxy-pool-manager/1.0\r\nConnection: close\r\n\r\n`);
  const response = await responsePromise;
  const boundary = response.body.indexOf('\r\n\r\n');
  const headerText = boundary >= 0 ? response.body.slice(0, boundary) : response.body;
  const statusMatch = headerText.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/m);
  const body = boundary >= 0 ? response.body.slice(boundary + 4) : '';
  return analyseResponse(statusMatch ? Number(statusMatch[1]) : 0, body);
}

async function testTarget(proxy, targetString, timeout) {
  const target = new URL(targetString);
  try {
    if (proxy.protocol === 'socks5' || proxy.protocol === 'socks4') {
      return await requestThroughSocks(proxy, target, timeout);
    }
    return await requestThroughHttpProxy(proxy, target, timeout);
  } catch (error) {
    return { ok: false, category: errorCategory(error), error: error.message || '检测请求失败' };
  }
}

/**
 * Test one proxy against three independent, sequential exit-IP endpoints.
 * A proxy is marked dead only when every target reports a proxy-level failure.
 */
export async function testProxy(proxy, config = getTesterConfig()) {
  const start = Date.now();
  const attempts = [];
  for (const target of config.targets.slice(0, 3)) {
    const result = await testTarget(proxy, target, config.timeout);
    attempts.push({ target, ...result });
    if (result.ok) {
      const exitIp = result.exitIp;
      return {
        id: proxy.id,
        alive: true,
        exitIp,
        responseTime: Date.now() - start,
        anonymity: exitIp === proxy.ip ? 'transparent' : 'elite',
        attempts,
      };
    }
  }

  const definitelyDead = attempts.length === 3 && attempts.every(attempt => attempt.category === 'proxy_failure');
  return {
    id: proxy.id,
    alive: definitelyDead ? false : null,
    exitIp: null,
    responseTime: Date.now() - start,
    anonymity: null,
    attempts,
    errorCategory: definitelyDead ? 'proxy_failure' : 'inconclusive',
  };
}

/**
 * TCP port connectivity test (quick check, no proxy protocol)
 */
export function testPortConnectivity(ip, port, timeout = 5000) {
  return new Promise(resolve => {
    const start = Date.now();
    const socket = net.createConnection({ host: ip, port }, () => {
      socket.destroy();
      resolve({ alive: true, responseTime: Date.now() - start });
    });
    socket.setTimeout(timeout);
    socket.on('timeout', () => { socket.destroy(); resolve({ alive: false, responseTime: null }); });
    socket.on('error', () => { socket.destroy(); resolve({ alive: false, responseTime: null }); });
  });
}

// ─── External Tester Service (legacy compatibility) ─────────────────────────

export async function testProxiesExternal(proxies) {
  const testerUrl = process.env.TESTER_URL;
  const testerSecret = process.env.TESTER_SECRET;
  if (!testerUrl) return { error: 'TESTER_URL not configured' };
  const config = getTesterConfig();
  const response = await fetch(testerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${testerSecret || ''}` },
    body: JSON.stringify({
      proxies: proxies.map(proxy => ({
        id: proxy.id, ip: proxy.ip, port: proxy.port, protocol: proxy.protocol,
        username: proxy.username || '', password: proxy.password || '',
      })),
      testUrl: config.targets[0],
      timeout: config.timeout,
    }),
    signal: AbortSignal.timeout(config.timeout + 5000),
  });
  if (!response.ok) throw new Error(`Tester returned ${response.status}`);
  return response.json();
}

/**
 * Test multiple proxies using the built-in three-target verifier. Every entry
 * shares a global concurrency limiter across manual, batch, and cron checks.
 */
export async function testProxies(proxies, onProgress) {
  const config = getTesterConfig();
  let completed = 0;
  const results = await Promise.all(proxies.map(async proxy => {
    const result = await withCheckSlot(config.concurrency, () => testProxy(proxy, config));
    completed++;
    onProgress?.(completed, proxies.length, result);
    return result;
  }));
  return { results };
}
