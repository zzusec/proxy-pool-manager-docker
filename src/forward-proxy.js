import http from 'node:http';
import net from 'node:net';
import { getRandomProxy } from './db.js';

/**
 * Forwarding HTTP proxy that transparently rotates through the proxy pool.
 *
 * Clients point their `proxy` setting at this single endpoint (e.g.
 * http://host:3100).  Each incoming CONNECT or proxied request picks a random
 * alive proxy from the pool and chains through it with its credentials.  This
 * lets grok-register use one stable address while the underlying exit IP
 * rotates automatically.
 */

const CONNECT_TIMEOUT_MS = Number.parseInt(process.env.FORWARD_PROXY_CONNECT_TIMEOUT || '15000', 10);

function pickPoolProxy() {
  return (
    getRandomProxy({ alive: 'true', protocol: 'http' }) ||
    getRandomProxy({ alive: 'true', protocol: 'https' }) ||
    getRandomProxy({ alive: 'true', protocol: 'socks5' })
  );
}

function basicAuthHeader(proxy) {
  if (!proxy.username) return '';
  const creds = `${proxy.username}:${proxy.password || ''}`;
  return `Proxy-Authorization: Basic ${Buffer.from(creds).toString('base64')}\r\n`;
}

/**
 * Connect to an upstream HTTP proxy and issue CONNECT to tunnel to target.
 * Resolves a raw TCP socket once the tunnel is established.
 */
function httpProxyConnect(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.ip, port: proxy.port, timeout: CONNECT_TIMEOUT_MS });
    let buf = '';
    const cleanup = () => { socket.removeAllListeners(); socket.destroy(); };

    socket.on('connect', () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          basicAuthHeader(proxy) +
          `\r\n`
      );
    });

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const statusLine = buf.slice(0, buf.indexOf('\r\n'));
      socket.removeAllListeners('data');
      if (/200/.test(statusLine)) {
        resolve(socket);
      } else {
        cleanup();
        reject(new Error(`upstream CONNECT failed: ${statusLine}`));
      }
    });

    socket.on('timeout', () => { cleanup(); reject(new Error('upstream CONNECT timeout')); });
    socket.on('error', (err) => { cleanup(); reject(err); });
  });
}

/**
 * Minimal SOCKS5 connect with optional username/password auth.
 */
function socks5Connect(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.ip, port: proxy.port, timeout: CONNECT_TIMEOUT_MS });
    const cleanup = () => { socket.removeAllListeners(); socket.destroy(); };
    let phase = 0;

    socket.on('connect', () => {
      socket.write(Buffer.from([0x05, 0x01, proxy.username ? 0x02 : 0x00]));
    });

    socket.on('data', (data) => {
      if (phase === 0) {
        // auth method negotiation response
        if (data[0] !== 0x05) { cleanup(); return reject(new Error('bad socks version')); }
        if (data[1] === 0x02 && proxy.username) {
          const user = Buffer.from(proxy.username);
          const pass = Buffer.from(proxy.password || '');
          socket.write(Buffer.from([0x01, user.length, ...user, pass.length, ...pass]));
          phase = 1;
          return;
        }
        if (data[1] === 0x00) { phase = 2; return sendConnect(); }
        cleanup();
        return reject(new Error('socks auth method rejected'));
      }
      if (phase === 1) {
        // auth response
        if (data[1] !== 0x00) { cleanup(); return reject(new Error('socks auth failed')); }
        phase = 2;
        return sendConnect();
      }
      if (phase === 2) {
        // connect response
        if (data[1] === 0x00) {
          socket.removeAllListeners('data');
          resolve(socket);
        } else {
          cleanup();
          reject(new Error(`socks connect failed: ${data[1]}`));
        }
      }
      function sendConnect() {
        const hostBuf = Buffer.from(targetHost, 'utf8');
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(targetPort);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf]));
      }
    });

    socket.on('timeout', () => { cleanup(); reject(new Error('socks connect timeout')); });
    socket.on('error', (err) => { cleanup(); reject(err); });
  });
}

function dialUpstream(proxy, targetHost, targetPort) {
  const proto = String(proxy.protocol || 'http').toLowerCase();
  if (proto === 'socks5') return socks5Connect(proxy, targetHost, targetPort);
  return httpProxyConnect(proxy, targetHost, targetPort);
}

/**
 * Pick a proxy, attempt to connect; retry with a fresh proxy on failure.
 */
async function dialWithRetry(targetHost, targetPort, retries = 12) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const proxy = pickPoolProxy();
    if (!proxy) { lastErr = new Error('pool empty'); continue; }
    try {
      return { socket: await dialUpstream(proxy, targetHost, targetPort), proxy };
    } catch (err) {
    }
  }
  throw lastErr || new Error('all upstream attempts failed');
}

function pipeBidirectional(a, b) {
  a.pipe(b);
  b.pipe(a);
  const cleanup = () => { a.destroy(); b.destroy(); };
  a.on('error', cleanup);
  b.on('error', cleanup);
  a.on('close', cleanup);
}

export function startForwardProxy(port = 3100) {
  const server = http.createServer(async (req, res) => {
    // Plain HTTP proxying (non-CONNECT): parse absolute-form URL.
    try {
      const target = new URL(req.url);
      const targetPort = parseInt(target.port || '80', 10);
      const targetHost = target.hostname;
      const upstream = await dialWithRetry(targetHost, targetPort);
      // Rewrite to origin-form request line + relay headers
      const path = target.pathname + target.search;
      let head = `${req.method} ${path} HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(req.headers)) {
        if (key.toLowerCase() === 'proxy-connection') continue;
        head += `${key}: ${value}\r\n`;
      }
      head += '\r\n';
      upstream.socket.write(head);
      upstream.socket.pipe(res);
      req.pipe(upstream.socket);
      res.on('close', () => upstream.socket.destroy());
    } catch (err) {
      if (!res.headersSent) { res.writeHead(502); res.end(`forward proxy error: ${err.message}`); }
      else res.end();
    }
  });

  server.on('connect', async (req, clientSocket, head) => {
    const [host, portStr] = req.url.split(':');
    const port = parseInt(portStr || '443', 10);
    try {
      clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head && head.length) upstream.socket.write(head);
      pipeBidirectional(clientSocket, upstream.socket);
    } catch (err) {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[Forward Proxy] Rotating pool proxy listening on 0.0.0.0:${port}`);
  });
}
