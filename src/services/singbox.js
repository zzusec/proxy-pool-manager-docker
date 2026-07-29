import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const START_TIMEOUT_MS = Number.parseInt(process.env.SINGBOX_START_TIMEOUT || '10000', 10);

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function waitForPort(port, child, readStderr, hasSpawnError) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (hasSpawnError()) return reject(new Error(`sing-box 无法启动${readStderr() ? '：' + readStderr() : ''}`));
      if (child.exitCode !== null) return reject(new Error(`sing-box 启动失败${readStderr() ? '：' + readStderr() : ''}`));
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) return reject(new Error(`sing-box 本地 SOCKS 启动超时${readStderr() ? '：' + readStderr() : ''}`));
        setTimeout(attempt, 80);
      });
    };
    attempt();
  });
}

function tls(proxy) {
  const extra = proxy.extra || {};
  return {
    enabled: true,
    server_name: extra.sni || proxy.ip,
    insecure: extra.allowInsecure === true || extra.skipCertVerify === true,
    alpn: extra.alpn ? String(extra.alpn).split(',').filter(Boolean) : undefined,
  };
}

export function singBoxOutbound(proxy) {
  const extra = proxy.extra || {};
  const server = proxy.ip;
  const server_port = Number(proxy.port);
  if (!server || !Number.isInteger(server_port)) throw new Error('代理地址或端口无效');

  switch (proxy.protocol) {
    case 'hysteria2':
    case 'hy2': {
      if (!proxy.username) throw new Error('Hysteria2 缺少密码');
      const outbound = { type: 'hysteria2', tag: 'proxy', server, server_port, password: proxy.username, tls: tls(proxy) };
      if (extra.obfs) outbound.obfs = { type: extra.obfs, password: extra.obfsPassword || '' };
      return outbound;
    }
    case 'vless':
      if (!proxy.username) throw new Error('VLESS 缺少 UUID');
      return { type: 'vless', tag: 'proxy', server, server_port, uuid: proxy.username, flow: extra.flow || undefined, tls: extra.security === 'tls' ? tls(proxy) : undefined, transport: extra.network === 'ws' ? { type: 'ws', path: extra.path || '/', headers: extra.host ? { Host: extra.host } : undefined } : undefined };
    case 'vmess':
      if (!proxy.username) throw new Error('VMess 缺少 UUID');
      return { type: 'vmess', tag: 'proxy', server, server_port, uuid: proxy.username, security: 'auto', tls: extra.tls === 'tls' ? tls(proxy) : undefined };
    case 'trojan':
      if (!proxy.password) throw new Error('Trojan 缺少密码');
      return { type: 'trojan', tag: 'proxy', server, server_port, password: proxy.password, tls: tls(proxy) };
    case 'ss':
      if (!proxy.username || !proxy.password) throw new Error('Shadowsocks 缺少加密方式或密码');
      return { type: 'shadowsocks', tag: 'proxy', server, server_port, method: proxy.username, password: proxy.password };
    default:
      throw new Error(`sing-box 不支持协议 ${proxy.protocol || 'unknown'}`);
  }
}

export async function withSingBoxSocks(proxy, callback) {
  const port = await freeLoopbackPort();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-pool-singbox-'));
  const configPath = path.join(tempDir, 'config.json');
  const config = {
    log: { disabled: true },
    inbounds: [{ type: 'socks', tag: 'in', listen: '127.0.0.1', listen_port: port }],
    outbounds: [singBoxOutbound(proxy)],
    route: { final: 'proxy' },
  };
  await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const binary = process.env.SING_BOX_BIN || 'sing-box';
  // stderr is captured so a rejected outbound config surfaces the real sing-box
  // message instead of a generic "隧道启动失败".
  const child = spawn(binary, ['run', '-c', configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let spawnError = false;
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-600); });
  child.once('error', error => { spawnError = true; stderr = (stderr + ` ${error.message}`).slice(-600); });
  const readStderr = () => stderr.split('\n').filter(Boolean).slice(-2).join(' ').trim().slice(0, 240);

  try {
    await waitForPort(port, child, readStderr, () => spawnError);
    return await callback({ protocol: 'socks5', ip: '127.0.0.1', port, username: '', password: '' });
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, 1000)),
    ]);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
