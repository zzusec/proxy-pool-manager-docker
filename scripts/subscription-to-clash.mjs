#!/usr/bin/env node
/**
 * 将订阅链接转换为 Clash/Mihomo 配置文件
 * 支持: hysteria2, vmess, vless, trojan, ss, socks5, http
 */

import fs from 'fs';
import { URL } from 'url';

const SUBSCRIPTION_URL = process.argv[2] || 'https://apidc.dnso.ccwu.cc:2096/UuD64zln8W06Q9GEZAa1frciE56UwN/3r9jqza9b3eyzhne';
const OUTPUT_FILE = process.argv[3] || 'clash-config.yaml';

async function fetchSubscription(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ClashForWindows/0.20.39',
      'Accept': '*/*'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const text = await response.text();
  // 尝试 base64 解码
  try {
    const decoded = Buffer.from(text.trim(), 'base64').toString('utf8');
    if (decoded.includes('://')) {
      return decoded;
    }
  } catch {}

  return text;
}

function parseHysteria2(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'hysteria2:' && url.protocol !== 'hy2:') return null;

    const name = decodeURIComponent(url.hash || '').replace(/^#/, '') || `HY2-${url.hostname}`;
    const params = new URLSearchParams(url.search);

    return {
      name,
      type: 'hysteria2',
      server: url.hostname,
      port: parseInt(url.port),
      password: url.username + (url.password ? ':' + url.password : ''),
      obfs: params.get('obfs') || '',
      'obfs-password': params.get('obfs-password') || '',
      sni: params.get('sni') || url.hostname,
      'skip-cert-verify': false,
    };
  } catch {
    return null;
  }
}

function parseVmess(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'vmess:') return null;

    const config = JSON.parse(Buffer.from(url.hostname, 'base64').toString());
    const params = new URLSearchParams(url.search);

    return {
      name: config.ps || `VMess-${config.add}`,
      type: 'vmess',
      server: config.add,
      port: parseInt(config.port),
      uuid: config.id,
      alterId: parseInt(config.aid || 0),
      cipher: config.scy || 'auto',
      network: config.net || 'tcp',
      ...(config.net === 'ws' ? {
        'ws-opts': {
          path: config.path || '/',
          headers: { Host: config.host || config.add }
        }
      } : {}),
      tls: config.tls === 'tls',
      'skip-cert-verify': false,
    };
  } catch {
    return null;
  }
}

function parseVless(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'vless:') return null;

    const name = decodeURIComponent(url.hash || '').replace(/^#/, '') || `VLESS-${url.hostname}`;
    const params = new URLSearchParams(url.search);

    return {
      name,
      type: 'vless',
      server: url.hostname,
      port: parseInt(url.port),
      uuid: url.username,
      network: params.get('type') || 'tcp',
      tls: params.get('security') === 'tls' || params.get('security') === 'reality',
      'skip-cert-verify': false,
      ...(params.get('type') === 'ws' ? {
        'ws-opts': {
          path: params.get('path') || '/',
          headers: { Host: params.get('host') || url.hostname }
        }
      } : {}),
    };
  } catch {
    return null;
  }
}

function parseTrojan(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'trojan:') return null;

    const name = decodeURIComponent(url.hash || '').replace(/^#/, '') || `Trojan-${url.hostname}`;
    const params = new URLSearchParams(url.search);

    return {
      name,
      type: 'trojan',
      server: url.hostname,
      port: parseInt(url.port),
      password: url.username,
      sni: params.get('sni') || url.hostname,
      'skip-cert-verify': false,
    };
  } catch {
    return null;
  }
}

function parseSS(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'ss:' && url.protocol !== 'ssr:') return null;

    const name = decodeURIComponent(url.hash || '').replace(/^#/, '') || `SS-${url.hostname}`;

    // ss://base64(method:password)@server:port
    // 或 ss://base64(method:password@server:port)
    let method, password;

    if (url.username) {
      const decoded = Buffer.from(url.username, 'base64').toString();
      const parts = decoded.split(':');
      method = parts[0];
      password = parts.slice(1).join(':');
    }

    return {
      name,
      type: 'ss',
      server: url.hostname,
      port: parseInt(url.port),
      cipher: method || 'aes-128-gcm',
      password: password || url.password || '',
    };
  } catch {
    return null;
  }
}

function parseHttpSocks(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'socks5:') return null;

    const name = decodeURIComponent(url.hash || '').replace(/^#/, '') || `${url.protocol.slice(0, -1).toUpperCase()}-${url.hostname}`;

    return {
      name,
      type: url.protocol === 'socks5:' ? 'socks5' : 'http',
      server: url.hostname,
      port: parseInt(url.port),
      ...(url.username ? { username: url.username } : {}),
      ...(url.password ? { password: url.password } : {}),
      tls: url.protocol === 'https:',
      'skip-cert-verify': false,
    };
  } catch {
    return null;
  }
}

function parseProxyLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  return parseHysteria2(trimmed) ||
         parseVmess(trimmed) ||
         parseVless(trimmed) ||
         parseTrojan(trimmed) ||
         parseSS(trimmed) ||
         parseHttpSocks(trimmed);
}

function generateClashConfig(proxies) {
  const proxyNames = proxies.map(p => p.name);

  return `# Clash 配置文件 - 由 subscription-to-clash.mjs 生成
# 生成时间: ${new Date().toISOString()}
# 代理数量: ${proxies.length}

mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
external-controller: 127.0.0.1:9090

dns:
  enable: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - 223.5.5.5
    - 119.29.29.29

proxies:
${proxies.map(p => {
  const lines = [];
  lines.push(`  - name: "${p.name.replace(/"/g, '\\"')}"`);
  lines.push(`    type: ${p.type}`);
  lines.push(`    server: ${p.server}`);
  lines.push(`    port: ${p.port}`);

  if (p.password) lines.push(`    password: "${p.password}"`);
  if (p.uuid) lines.push(`    uuid: ${p.uuid}`);
  if (p['obfs-password']) lines.push(`    obfs-password: ${p['obfs-password']}`);
  if (p.obfs) lines.push(`    obfs: ${p.obfs}`);
  if (p.sni) lines.push(`    sni: ${p.sni}`);
  if (p.cipher) lines.push(`    cipher: ${p.cipher}`);
  if (p.network) lines.push(`    network: ${p.network}`);
  if (p.tls !== undefined) lines.push(`    tls: ${p.tls}`);
  if (p['skip-cert-verify'] !== undefined) lines.push(`    skip-cert-verify: ${p['skip-cert-verify']}`);
  if (p.username) lines.push(`    username: ${p.username}`);
  if (p['ws-opts']) {
    lines.push(`    ws-opts:`);
    lines.push(`      path: ${p['ws-opts'].path}`);
    if (p['ws-opts'].headers?.Host) {
      lines.push(`      headers:`);
      lines.push(`        Host: ${p['ws-opts'].headers.Host}`);
    }
  }

  return lines.join('\n');
}).join('\n\n')}

proxy-groups:
  - name: "🚀 节点选择"
    type: select
    proxies:
      - "♻️ 自动选择"
      - "🔰 故障转移"
      - DIRECT
${proxyNames.map(n => `      - "${n}"`).join('\n')}

  - name: "♻️ 自动选择"
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 300
    tolerance: 50
    proxies:
${proxyNames.map(n => `      - "${n}"`).join('\n')}

  - name: "🔰 故障转移"
    type: fallback
    url: http://www.gstatic.com/generate_204
    interval: 300
    proxies:
${proxyNames.map(n => `      - "${n}"`).join('\n')}

rules:
  - GEOIP,LAN,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,🚀 节点选择
`;
}

async function main() {
  console.log(`[订阅转换] 获取: ${SUBSCRIPTION_URL}`);

  let content;
  try {
    content = await fetchSubscription(SUBSCRIPTION_URL);
    console.log(`[订阅转换] 成功获取 ${content.length} 字节`);
  } catch (error) {
    console.error(`[订阅转换] 获取失败: ${error.message}`);
    process.exit(1);
  }

  const lines = content.split('\n').filter(l => l.trim());
  const proxies = [];

  for (const line of lines) {
    const proxy = parseProxyLine(line);
    if (proxy) {
      proxies.push(proxy);
      console.log(`  ✓ ${proxy.type.toUpperCase()}: ${proxy.name}`);
    }
  }

  if (proxies.length === 0) {
    console.error(`[订阅转换] 未找到任何支持的代理`);
    process.exit(1);
  }

  console.log(`\n[订阅转换] 共解析 ${proxies.length} 个代理`);

  // 统计
  const byType = {};
  for (const p of proxies) {
    byType[p.type] = (byType[p.type] || 0) + 1;
  }
  console.log('[订阅转换] 类型分布:', byType);

  // 生成配置
  const config = generateClashConfig(proxies);
  fs.writeFileSync(OUTPUT_FILE, config, 'utf8');
  console.log(`\n[订阅转换] 配置已保存到: ${OUTPUT_FILE}`);
  console.log(`\n使用方法:
  1. 将配置文件导入 Clash/Mihomo
  2. 或启动 Clash: clash -f ${OUTPUT_FILE}
  3. 本地代理地址: http://127.0.0.1:7890
`);
}

main().catch(console.error);
