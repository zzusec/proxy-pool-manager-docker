import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-rotation-test-'));
const db = await import('../src/db.js');
const { testProxy } = await import('../src/services/tester.js');

db.initDb();

let seq = 0;
function addProxy(overrides = {}) {
  seq += 1;
  const proxy = {
    id: `rot-${seq}`, ip: `198.51.100.${seq}`, port: 9000 + seq, protocol: 'http',
    source: 'test', tags: [], ...overrides,
  };
  db.upsertProxy(proxy);
  return proxy.id;
}

test('repeated identical exit IPs mark a proxy sticky, a change marks it rotating', () => {
  const id = addProxy();
  db.recordExitIpObservation(id, '5.5.5.5');
  db.recordExitIpObservation(id, '5.5.5.5');
  assert.equal(db.getProxyById(id).rotation, 'unknown', '两次样本还不足以判定');

  db.recordExitIpObservation(id, '5.5.5.5');
  assert.equal(db.getProxyById(id).rotation, 'sticky');
  assert.equal(db.getProxyById(id).rotation_source, 'auto');

  db.recordExitIpObservation(id, '6.6.6.6');
  assert.equal(db.getProxyById(id).rotation, 'rotating');
});

test('a manual rotation label is never overwritten by the observer', () => {
  const id = addProxy();
  db.setProxyRotation(id, 'sticky');
  for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4']) db.recordExitIpObservation(id, ip);
  const proxy = db.getProxyById(id);
  assert.equal(proxy.rotation, 'sticky');
  assert.equal(proxy.rotation_source, 'manual');
});

test('rotation is a filterable dimension', () => {
  const sticky = addProxy();
  const rotating = addProxy();
  db.setProxyRotation(sticky, 'sticky');
  db.setProxyRotation(rotating, 'rotating');
  assert.ok(db.listProxies({ rotation: 'sticky' }).proxies.some(p => p.id === sticky));
  assert.ok(db.listProxies({ rotation: 'rotating' }).proxies.every(p => p.id !== sticky));
});

test('sticky sessions bind one proxy and cap the TTL at 120 minutes', () => {
  const id = addProxy();
  const long = db.saveStickySession('session-cap', id, { country: 'US' }, 999 * 60);
  assert.equal(long.ttl, db.STICKY_MAX_TTL_SECONDS);
  assert.equal(db.STICKY_MAX_TTL_SECONDS, 120 * 60);

  const session = db.getStickySession('session-cap');
  assert.equal(session.proxy_id, id);

  db.saveStickySession('session-expired', id, {}, 1);
  db.getDb().prepare("UPDATE api_sessions SET expires_at = datetime('now', '-1 minute') WHERE session_key = 'session-expired'").run();
  assert.equal(db.getStickySession('session-expired'), null, '过期会话不再返回');
  db.purgeExpiredSessions();
  assert.equal(db.getDb().prepare("SELECT COUNT(*) c FROM api_sessions WHERE session_key = 'session-expired'").get().c, 0);
});

test('a proxy that forwards traffic counts as alive even without an exit IP', async () => {
  const target = http.createServer((req, res) => { res.writeHead(429); res.end('slow down'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));

  const proxy = http.createServer();
  proxy.on('connect', (req, clientSocket) => {
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
  });
  proxy.on('request', (req, res) => {
    const url = new URL(req.url);
    const upstream = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: req.method }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));

  const targetUrl = `http://127.0.0.1:${target.address().port}/ip`;
  const config = { timeout: 3000, concurrency: 1, targets: [targetUrl, targetUrl, targetUrl] };
  const result = await testProxy({ id: 'fwd', protocol: 'http', ip: '127.0.0.1', port: proxy.address().port }, config);

  assert.equal(result.alive, true);
  assert.equal(result.outcome, 'alive_no_exit_ip');
  assert.match(result.error, /出口 IP/);

  await new Promise(resolve => proxy.close(resolve));
  await new Promise(resolve => target.close(resolve));
});

test('a proxy demanding authentication (407) is dead, not alive', async () => {
  const proxy = http.createServer((req, res) => {
    res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="proxy"' });
    res.end();
  });
  proxy.on('connect', (req, clientSocket) => {
    clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    clientSocket.destroy();
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));

  const targets = ['http://example.invalid/ip', 'http://example.invalid/ip', 'http://example.invalid/ip'];
  const result = await testProxy(
    { id: 'auth', protocol: 'http', ip: '127.0.0.1', port: proxy.address().port },
    { timeout: 3000, concurrency: 1, targets },
  );

  assert.equal(result.alive, false);
  assert.match(result.error, /407/);
  await new Promise(resolve => proxy.close(resolve));
});

test('a node whose tunnel cannot be built is dead, never "unknown"', async () => {
  // No sing-box binary in the test environment: the tunnel always fails to start.
  const listener = net.createServer(socket => socket.destroy());
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const openPort = listener.address().port;

  const result = await testProxy(
    { id: 'tunnel', protocol: 'vless', ip: '127.0.0.1', port: openPort, username: '11111111-2222-3333-4444-555555555555' },
    { timeout: 2000, concurrency: 1, targets: [] },
  );

  assert.equal(result.alive, false, '端口可连但隧道建不起来时必须给出明确结论');
  assert.equal(result.outcome, 'tunnel_error');
  assert.match(result.error, /sing-box/);
  await new Promise(resolve => listener.close(resolve));
});

test('an unsupported protocol says so instead of guessing', async () => {
  const result = await testProxy({ id: 'tuic', protocol: 'tuic', ip: '127.0.0.1', port: 1080 }, { timeout: 1000, concurrency: 1, targets: [] });
  assert.equal(result.alive, null);
  assert.equal(result.outcome, 'unsupported_protocol');
  assert.match(result.error, /不支持协议/);
});

test('a proxy nothing can connect to is reported dead with a reason', async () => {
  const closed = net.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const deadPort = closed.address().port;
  await new Promise(resolve => closed.close(resolve));

  const targets = [`http://127.0.0.1:${deadPort}/a`, `http://127.0.0.1:${deadPort}/b`, `http://127.0.0.1:${deadPort}/c`];
  const result = await testProxy(
    { id: 'dead', protocol: 'http', ip: '127.0.0.1', port: deadPort },
    { timeout: 2000, concurrency: 1, targets },
  );

  assert.equal(result.alive, false);
  assert.equal(result.outcome, 'dead');
  assert.ok(result.error, '失败原因必须写清楚');
});

test('the country a target reports through the proxy is what gets stored', async () => {
  // Cloudflare's trace format: the exit IP and `loc=` come back together.
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('fl=123abc\nh=www.cloudflare.com\nip=203.0.113.55\nts=1700000000\nloc=US\ncolo=LAX\n');
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));

  const proxy = http.createServer((req, res) => {
    const url = new URL(req.url);
    const upstream = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: req.method }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));

  const targetUrl = `http://127.0.0.1:${target.address().port}/cdn-cgi/trace`;
  const result = await testProxy(
    { id: 'geo', protocol: 'http', ip: '127.0.0.1', port: proxy.address().port },
    { timeout: 3000, concurrency: 1, targets: [targetUrl] },
  );

  assert.equal(result.alive, true);
  assert.equal(result.exitIp, '203.0.113.55');
  assert.equal(result.country, 'US', '国家取自目标实测，而不是任何 GeoIP 库');

  await new Promise(resolve => proxy.close(resolve));
  await new Promise(resolve => target.close(resolve));
});

test('a target without a country simply reports none', async () => {
  const target = http.createServer((req, res) => { res.end(JSON.stringify({ ip: '203.0.113.56' })); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const proxy = http.createServer((req, res) => {
    const url = new URL(req.url);
    const upstream = http.request({ host: url.hostname, port: url.port, path: url.pathname }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));

  const result = await testProxy(
    { id: 'geo-none', protocol: 'http', ip: '127.0.0.1', port: proxy.address().port },
    { timeout: 3000, concurrency: 1, targets: [`http://127.0.0.1:${target.address().port}/ip`] },
  );
  assert.equal(result.alive, true);
  assert.equal(result.country, null);

  await new Promise(resolve => proxy.close(resolve));
  await new Promise(resolve => target.close(resolve));
});

test('a lookup answering "Unknown" never erases a known country', async () => {
  const { normalizeCountryCode } = await import('../src/utils/helpers.js');
  assert.equal(normalizeCountryCode('Unknown'), '');
  assert.equal(normalizeCountryCode(''), '');
  assert.equal(normalizeCountryCode('-'), '');
  assert.equal(normalizeCountryCode('us'), 'US');
  assert.equal(normalizeCountryCode(' fr '), 'FR');
});
