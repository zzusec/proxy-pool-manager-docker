import net from 'net';
import { SocksClient } from 'socks';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

// ─── Built-in Proxy Testing ─────────────────────────────────────────────────

const TEST_URL = process.env.TEST_URL || 'http://httpbin.org/ip';
const TEST_TIMEOUT = parseInt(process.env.TEST_TIMEOUT) || 10000;

/**
 * Test a single proxy via built-in TCP/HTTP/SOCKS5 detection
 */
export async function testProxy(proxy) {
  const start = Date.now();
  try {
    if (proxy.protocol === 'socks5' || proxy.protocol === 'socks4') {
      return await testSocksProxy(proxy, start);
    } else {
      return await testHttpProxy(proxy, start);
    }
  } catch (err) {
    return {
      id: proxy.id,
      alive: false,
      exitIp: null,
      responseTime: Date.now() - start,
      anonymity: null,
    };
  }
}

/**
 * Test HTTP/HTTPS proxy
 */
async function testHttpProxy(proxy, start) {
  const proxyUrl = proxy.username
    ? `http://${proxy.username}:${proxy.password}@${proxy.ip}:${proxy.port}`
    : `http://${proxy.ip}:${proxy.port}`;

  const agent = new HttpProxyAgent(proxyUrl);

  const response = await fetch(TEST_URL, {
    agent,
    signal: AbortSignal.timeout(TEST_TIMEOUT),
    redirect: 'manual',
  });

  const body = await response.text();
  const responseTime = Date.now() - start;

  let exitIp = null;
  let anonymity = 'anonymous';

  try {
    const data = JSON.parse(body);
    exitIp = data.origin || data.ip || null;
  } catch {}

  // Determine anonymity
  if (exitIp && exitIp === proxy.ip) {
    anonymity = 'transparent';
  } else if (exitIp) {
    anonymity = 'elite';
  }

  return {
    id: proxy.id,
    alive: true,
    exitIp,
    responseTime,
    anonymity,
  };
}

/**
 * Test SOCKS5 proxy
 */
async function testSocksProxy(proxy, start) {
  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: proxy.ip,
      port: proxy.port,
      type: proxy.protocol === 'socks4' ? 4 : 5,
      userId: proxy.username || undefined,
      password: proxy.password || undefined,
    },
    command: 'connect',
    destination: {
      host: new URL(TEST_URL).hostname,
      port: 80,
    },
  });

  // Send HTTP request through the SOCKS tunnel
  const httpReq = `GET ${new URL(TEST_URL).pathname} HTTP/1.1\r\nHost: ${new URL(TEST_URL).hostname}\r\nConnection: close\r\n\r\n`;
  socket.write(httpReq);

  const responseTime = Date.now() - start;

  return new Promise((resolve) => {
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('end', () => {
      let exitIp = null;
      let anonymity = 'anonymous';

      // Try to extract IP from response body
      const bodyMatch = data.match(/\{[^}]*"origin"[^}]*\}|\{[^}]*"ip"[^}]*\}/);
      if (bodyMatch) {
        try {
          const json = JSON.parse(bodyMatch[0]);
          exitIp = json.origin || json.ip || null;
        } catch {}
      }

      if (exitIp && exitIp === proxy.ip) anonymity = 'transparent';
      else if (exitIp) anonymity = 'elite';

      resolve({
        id: proxy.id,
        alive: true,
        exitIp,
        responseTime,
        anonymity,
      });
    });
    socket.on('error', () => {
      resolve({
        id: proxy.id,
        alive: false,
        exitIp: null,
        responseTime: Date.now() - start,
        anonymity: null,
      });
    });

    // Timeout fallback
    setTimeout(() => {
      socket.destroy();
      resolve({
        id: proxy.id,
        alive: data.length > 0,
        exitIp: null,
        responseTime: Date.now() - start,
        anonymity: null,
      });
    }, TEST_TIMEOUT);
  });
}

/**
 * TCP port connectivity test (quick check, no proxy protocol)
 */
export function testPortConnectivity(ip, port, timeout = 5000) {
  return new Promise((resolve) => {
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

// ─── External Tester Service ────────────────────────────────────────────────

/**
 * Test proxies via external tester service (legacy compatibility)
 */
export async function testProxiesExternal(proxies) {
  const testerUrl = process.env.TESTER_URL;
  const testerSecret = process.env.TESTER_SECRET;

  if (!testerUrl) return { error: 'TESTER_URL not configured' };

  const payload = {
    proxies: proxies.map(p => ({
      id: p.id,
      ip: p.ip,
      port: p.port,
      protocol: p.protocol,
      username: p.username || '',
      password: p.password || '',
    })),
    testUrl: TEST_URL,
    timeout: TEST_TIMEOUT,
  };

  const res = await fetch(testerUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${testerSecret || ''}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TEST_TIMEOUT + 5000),
  });

  if (!res.ok) {
    throw new Error(`Tester returned ${res.status}`);
  }

  return await res.json();
}

/**
 * Test multiple proxies (auto-select built-in or external)
 */
export async function testProxies(proxies) {
  if (process.env.TESTER_URL) {
    return await testProxiesExternal(proxies);
  }

  // Built-in testing
  const results = await Promise.allSettled(
    proxies.map(p => testProxy(p))
  );

  return {
    results: results.map(r => {
      if (r.status === 'fulfilled') return r.value;
      return { id: null, alive: false, exitIp: null, responseTime: null, anonymity: null };
    }),
  };
}
