import http from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';
import { SocksClient } from 'socks';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getSetting } from '../db.js';
import { withSingBoxSocks } from './singbox.js';
import { DEFAULT_TEST_TARGETS } from '../utils/helpers.js';

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
  // 407 comes from the proxy itself, not the target: credentials are missing or
  // wrong, so the proxy is unusable no matter what the target would have said.
  if (statusCode === 407) {
    return { ok: false, category: 'proxy_auth_failed', reachedTarget: false, statusCode, error: '代理要求认证或认证失败（HTTP 407）' };
  }
  // `reachedTarget` marks that the proxy actually forwarded traffic and an HTTP
  // reply came back — the tunnel works even when the target itself refuses us.
  if (statusCode < 200 || statusCode >= 300) {
    return { ok: false, category: 'target_error', reachedTarget: statusCode > 0, statusCode, error: `目标返回 HTTP ${statusCode}` };
  }
  const exitIp = extractIp(body);
  if (!exitIp) return { ok: false, category: 'target_error', reachedTarget: true, statusCode, error: '检测目标未返回出口 IP' };
  return { ok: true, exitIp, country: extractCountry(body), statusCode };
}

/**
 * Cloudflare's trace endpoint reports `loc=<ISO country>` — the country a real
 * website sees for this exit, which is what a proxy is actually judged on.
 */
function extractCountry(body) {
  const match = String(body).match(/^loc=([A-Z]{2})\s*$/m);
  return match ? match[1] : null;
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

function requestThroughHttpProxy(proxy, target, timeout, parser = analyseResponse) {
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
        finish(resolve, parser(response.statusCode || 0, result.body));
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

async function requestThroughSocks(proxy, target, timeout, parser = analyseResponse) {
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
  return parser(statusMatch ? Number(statusMatch[1]) : 0, body);
}

async function testTarget(proxy, targetString, timeout, parser = analyseResponse) {
  const target = new URL(targetString);
  try {
    if (proxy.protocol === 'socks5' || proxy.protocol === 'socks4') {
      return await requestThroughSocks(proxy, target, timeout, parser);
    }
    return await requestThroughHttpProxy(proxy, target, timeout, parser);
  } catch (error) {
    return { ok: false, category: errorCategory(error), error: error.message || '检测请求失败' };
  }
}

export const TRANSPORT_PROTOCOLS = new Set(['http', 'https', 'socks5']);
export const SINGBOX_PROTOCOLS = new Set(['hysteria2', 'hy2', 'vless', 'vmess', 'trojan', 'ss']);

/**
 * Test one proxy against three independent, sequential exit-IP endpoints.
 * A proxy is marked dead only when every target reports a proxy-level failure.
 */
export async function testProxy(proxy, config = getTesterConfig()) {
  if (!TRANSPORT_PROTOCOLS.has(proxy.protocol)) {
    if (!SINGBOX_PROTOCOLS.has(proxy.protocol)) {
      return { id: proxy.id, alive: null, exitIp: null, responseTime: null, anonymity: null, attempts: [], errorCategory: 'unsupported_protocol', outcome: 'unsupported_protocol', error: `检测器不支持协议 ${proxy.protocol || 'unknown'}` };
    }
    try {
      const result = await withSingBoxSocks(proxy, localProxy => testProxy(localProxy, config));
      return { ...result, id: proxy.id, anonymity: result.exitIp === proxy.ip ? 'transparent' : 'elite' };
    } catch (error) {
      // The tunnel refused to start. Fall back to a plain TCP probe: an
      // unreachable endpoint is a dead node, not an unknown one.
      const message = String(error?.message || 'sing-box 隧道启动失败').slice(0, 240);
      const reachable = await testPortConnectivity(proxy.ip, Number(proxy.port), Math.min(config.timeout, 8000));
      if (!reachable.alive) {
        return { id: proxy.id, alive: false, exitIp: null, responseTime: null, anonymity: null, attempts: [], errorCategory: 'proxy_failure', outcome: 'dead', error: `节点端口不可达（${message}）` };
      }
      // The endpoint answers on TCP but no tunnel can be built, so the node is
      // unusable here. Report it as dead and keep the reason for the tooltip.
      return { id: proxy.id, alive: false, exitIp: null, responseTime: null, anonymity: null, attempts: [], errorCategory: 'proxy_failure', outcome: 'tunnel_error', error: `端口可连接但 sing-box 无法建立隧道（节点配置不被支持）：${message}` };
    }
  }
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
        // Observed country, present only when the target reports one.
        country: result.country || null,
        responseTime: Date.now() - start,
        anonymity: exitIp === proxy.ip ? 'transparent' : 'elite',
        attempts,
        outcome: 'alive',
      };
    }
  }

  // The proxy forwarded traffic and a target answered — the tunnel is alive even
  // though no exit IP could be read (rate limit, block page, non-JSON body).
  const forwarded = attempts.find(attempt => attempt.reachedTarget);
  if (forwarded) {
    return {
      id: proxy.id,
      alive: true,
      exitIp: null,
      responseTime: Date.now() - start,
      anonymity: null,
      attempts,
      outcome: 'alive_no_exit_ip',
      error: `代理转发正常，但检测目标未返回出口 IP（${forwarded.error || 'HTTP ' + (forwarded.statusCode || 0)}）`,
    };
  }

  // 所有目标都在连接层失败：判定失效，不再保留不确定状态
  return {
    id: proxy.id,
    alive: false,
    exitIp: null,
    responseTime: Date.now() - start,
    anonymity: null,
    attempts,
    errorCategory: 'proxy_failure',
    outcome: 'dead',
    error: attempts[attempts.length - 1]?.error || '所有检测目标均连接失败',
  };
}

export async function inspectIspInfoThroughProxy(proxy, config = getTesterConfig()) {
  const url = process.env.ISPINFO_API_URL || 'https://ispinfo.io/api/ip';
  const timeout = Math.max(1000, Math.min(Number.parseInt(process.env.ISPINFO_TIMEOUT || '', 10) || config.timeout, 60000));
  let target;
  try { target = new URL(url); }
  catch { return { status: 'invalid_config', error: 'ISPINFO_API_URL 无效', response: {}, normalized: {} }; }

  const query = async activeProxy => testTarget(activeProxy, target.toString(), timeout, (statusCode, body) => ({ ok: statusCode >= 200 && statusCode < 300, statusCode, body }));
  let result;
  try {
    if (TRANSPORT_PROTOCOLS.has(proxy.protocol)) result = await query(proxy);
    else if (SINGBOX_PROTOCOLS.has(proxy.protocol)) result = await withSingBoxSocks(proxy, query);
    else return { status: 'skipped_unsupported', error: `不支持协议 ${proxy.protocol || 'unknown'}`, response: {}, normalized: {} };
  } catch (error) {
    return { status: 'transport_error', error: String(error?.message || 'ispinfo 请求失败').slice(0, 240), response: {}, normalized: {} };
  }
  if (!result.ok) return { status: result.statusCode ? 'http_error' : (result.category || 'transport_error'), httpStatus: result.statusCode || null, error: result.error || `ispinfo 返回 HTTP ${result.statusCode || 0}`, response: {}, normalized: {} };

  let data;
  try { data = JSON.parse(result.body); }
  catch { return { status: 'invalid_response', httpStatus: result.statusCode, error: 'ispinfo 未返回 JSON', response: {}, normalized: {} }; }
  if (!data?.ip) return { status: 'invalid_response', httpStatus: result.statusCode, error: 'ispinfo 未返回出口 IP', response: data, normalized: {} };
  return {
    status: 'success', httpStatus: result.statusCode, observedIp: String(data.ip), response: data,
    normalized: {
      ip: String(data.ip), isDatacenter: !!data.is_datacenter, isMobile: !!data.is_mobile,
      isDualIsp: !!data.is_dual_isp, isVpn: !!data.is_vpn, isProxy: !!data.is_proxy,
      asn: data.asn || null, asnOrg: data.asn_org || '', companyName: data.company_name || '',
      companyType: data.company_type || '', country: data.country || '', countryCode: data.country_code || '',
    },
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
