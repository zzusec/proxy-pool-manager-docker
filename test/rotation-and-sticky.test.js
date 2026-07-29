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
