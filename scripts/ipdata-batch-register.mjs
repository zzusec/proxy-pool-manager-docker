#!/usr/bin/env node
/**
 * ipdata.co 批量注册脚本 - 使用 Outlook 子账号策略
 *
 * 策略：使用一个主邮箱的别名（子账号）来注册
 * 例如：admin@77169.com 可以创建 admin+ipdata1@77169.com, admin+ipdata2@77169.com 等
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import { HttpProxyAgent } from 'http-proxy-agent';

const EMAIL_DB_PATH = process.env.EMAIL_DB_PATH || '/app/data/outlook-email.db';
const TARGET_KEYS = parseInt(process.env.IPDATA_TARGET_KEYS || '3000', 10);
const PROXY_POOL_KEY = process.env.PROXY_POOL_KEY || 'grok-register-2024';
// Playwright 只支持 http(s)/socks4/socks5 代理；socks5 不支持认证，所以只取 http 代理。
// 不限定 residential：池子里新导入的 http 代理也可能偶尔通过 ipdata 的 WAF。
const PROXY_TYPE = process.env.PROXY_TYPE || '';
const PROXY_SOURCES = [
  process.env.PROXY_API || `http://localhost:3000/api/v1/proxies/random?alive=true${PROXY_TYPE ? `&type=${PROXY_TYPE}` : ''}&protocol=http&format=text&key=${PROXY_POOL_KEY}`,
  process.env.PROXY_API_FALLBACK || `http://kr.hx10.com:3000/api/v1/proxies/random?alive=true${PROXY_TYPE ? `&type=${PROXY_TYPE}` : ''}&protocol=http&format=text&key=${PROXY_POOL_KEY}`,
];
// 硬超时：单次注册最多 N 秒，超时强制杀浏览器，防止挂死拖垮批次/容器。
const ATTEMPT_TIMEOUT_MS = parseInt(process.env.ATTEMPT_TIMEOUT || '70000', 10);

// 首次拿到表单时 dump 一次结构（诊断提交按钮用）
let dumpDone = false;

// 把 protocol://user:pass@host:port 拆成 Playwright 认识的 server/username/password
function parseProxy(proxy) {
  try {
    const u = new URL(proxy);
    return {
      server: `${u.protocol}//${u.hostname}:${u.port}`,
      username: u.username ? decodeURIComponent(u.username) : '',
      password: u.password ? decodeURIComponent(u.password) : '',
    };
  } catch {
    return { server: proxy, username: '', password: '' };
  }
}
const OUTPUT_FILE = process.env.OUTPUT_FILE || '/app/data/ipdata-keys.txt';

// 主邮箱配置（用于生成子账号）
const MAIN_EMAIL = process.env.MAIN_EMAIL || 'admin@77169.com';

// 打开邮箱数据库（可选，用于获取更多邮箱）
let emailDb = null;
try {
  if (fs.existsSync(EMAIL_DB_PATH)) {
    emailDb = new Database(EMAIL_DB_PATH, { readonly: true });
    console.log(`[ipdata-batch] 邮箱数据库已打开: ${EMAIL_DB_PATH}`);
  }
} catch (e) {
  console.log(`[ipdata-batch] 未使用邮箱数据库: ${e.message}`);
}

// 生成子账号邮箱
function generateSubEmail(index) {
  // admin@77169.com -> admin+ipdata1@77169.com
  const [local, domain] = MAIN_EMAIL.split('@');
  return `${local}+ipdata${index}@${domain}`;
}

// 从数据库获取随机邮箱（备用）
function getRandomEmail() {
  if (!emailDb) return null;
  try {
    return emailDb.prepare('SELECT email, password FROM accounts WHERE status = ? ORDER BY RANDOM() LIMIT 1').get('active');
  } catch (e) {
    return null;
  }
}

// 代理预检：跳过连不上的死代理（免费代理池大半是死的）
async function proxyAlive(proxy) {
  try {
    const agent = new HttpProxyAgent(proxy);
    const res = await fetch('https://api.ipify.org/?format=json', { agent, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return false;
    await res.arrayBuffer();
    return true;
  } catch (e) { return false; }
}

// 获取代理（依次尝试多个代理源；预检过滤死代理）
async function getProxy() {
  for (let tries = 0; tries < 20; tries++) {
    for (const url of PROXY_SOURCES) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const text = (await res.text()).trim();
          if (text && !text.startsWith('{') && await proxyAlive(text)) return text;
        }
      } catch (e) {}
    }
  }
  return null;
}

// 生成密码
function genPwd() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join('') + '!A1';
}

// 注册函数
async function register(email, password, proxy) {
  let chromium;
  try {
    const m = await import('playwright');
    chromium = m.chromium;
  } catch (e) {
    return { ok: false, error: 'Playwright 未安装' };
  }

  // Alpine 系统 chromium 在 /usr/bin/chromium，部分镜像里也叫 chromium-browser
  const chromiumPath = ['/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find(p => fs.existsSync(p)) || process.env.CHROMIUM_PATH;
  const opts = {
    headless: true,
    executablePath: chromiumPath,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };
  let browser = null;
  let watchdog = null;
  try {
    if (proxy) {
      const parsed = parseProxy(proxy);
      opts.proxy = { server: parsed.server };
      if (parsed.username) {
        opts.proxy.username = parsed.username;
        opts.proxy.password = parsed.password || '';
      }
    }

    browser = await chromium.launch(opts);
    // 硬超时：到点直接杀浏览器，卡住的 goto 会以 Target closed 报错被捕获。
    watchdog = setTimeout(() => { browser?.close().catch(() => {}); }, ATTEMPT_TIMEOUT_MS);
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();

    // 抓注册接口的网络响应：dashboard 路径被 CDN 封，key 多半在 signup API 响应里
    const capturedResponses = [];
    page.on('response', async (resp) => {
      try {
        const url = resp.url();
        if (resp.request().method() === 'POST' || /api|auth|signup|user|account/i.test(url)) {
          const body = await resp.text().catch(() => '');
          if (body) capturedResponses.push({ url: url.slice(0, 120), status: resp.status(), body: body.slice(0, 2000) });
        }
      } catch (e) {}
    });

    console.log(`  访问注册页面...`);
    await page.goto('https://dashboard.ipdata.co/sign-up', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(3000);

    // 检查是否被 CDN 挡（AccessDenied 页没有表单，直接跳过省时间）
    const pageBody = (await page.evaluate(() => document.body.innerText).catch(() => '') || '');
    if (pageBody.includes('AccessDenied')) {
      return { ok: false, error: 'AccessDenied' };
    }

    // 填写表单
    const emailInput = await page.$('input[type="email"]');
    if (!emailInput) {
      return { ok: false, error: 'no-form: ' + pageBody.slice(0, 60).replace(/\s+/g, ' ') };
    }

    // 首次真正拿到表单时 dump 结构（诊断提交按钮问题）
    if (!dumpDone) {
      dumpDone = true;
      try {
        console.log('  [FORM-DUMP] inputs=' + JSON.stringify(await page.$$eval('input', els => els.map(e => ({ t: e.type, n: e.name, req: e.required, checked: e.checked })))));
        console.log('  [FORM-DUMP] buttons=' + JSON.stringify(await page.$$eval('button', els => els.map(e => ({ t: (e.innerText || '').trim().slice(0, 30), type: e.type })))));
        console.log('  [FORM-DUMP] labels=' + JSON.stringify(await page.$$eval('label', els => els.map(e => (e.innerText || '').trim().slice(0, 40))).catch(() => [])));
        console.log('  [FORM-DUMP] forms=' + JSON.stringify(await page.$$eval('form', els => els.map(e => ({ a: e.action, m: e.method })))));
      } catch (e) { console.log('  [FORM-DUMP] err ' + e.message.slice(0, 40)); }
    }

    console.log(`  填写邮箱: ${email}`);
    await emailInput.fill(email);

    const pwdInput = await page.$('input[type="password"]');
    if (pwdInput) await pwdInput.fill(password);

    // 提交
    console.log(`  提交注册...`);
    const btn = await page.$('button[type="submit"]');
    if (btn) await btn.click();
    else await page.keyboard.press('Enter');

    await page.waitForTimeout(6000);

    // 记录提交后的 URL 与页面文本（诊断用）
    let postSubmitUrl = '';
    let postSubmitText = '';
    try {
      postSubmitUrl = page.url();
      postSubmitText = (await page.evaluate(() => document.body.innerText).catch(() => '') || '').slice(0, 300).replace(/\s+/g, ' ');
    } catch (e) {}

    // 检查验证
    const verifyText = (await page.evaluate(() => document.body.innerText).catch(() => '') || '').toLowerCase();
    if (/verify|confirm|check your email|verify your email|we sent/i.test(verifyText)) {
      console.log(`  需要邮箱验证: ${postSubmitUrl}`);
      return { ok: false, error: `需要邮箱验证 ${postSubmitUrl}`, needVerify: true, detail: postSubmitText };
    }

    // 获取 API Key：优先从捕获的注册接口响应里找（dashboard 路径被 CDN 封）
    console.log(`  获取 API Key...`);
    for (const r of capturedResponses) {
      const m = r.body.match(/[a-f0-9]{32,}/i) || r.body.match(/test_[a-zA-Z0-9]{10,}/);
      if (m) {
        return { ok: true, key: m[0], from: `api:${r.status}` };
      }
    }

    // 兜底：仍尝试 dashboard（可能某天放行）
    await page.goto('https://dashboard.ipdata.co/dashboard', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(8000);

    const content = await page.content();
    const match = content.match(/[a-f0-9]{32,}/i) || content.match(/test_[a-zA-Z0-9]{10,}/);

    if (match) {
      return { ok: true, key: match[0] };
    }
    // 带诊断信息返回，方便判断是验证拦截还是渲染慢
    const dashText = (await page.evaluate(() => document.body.innerText).catch(() => '') || '').slice(0, 200).replace(/\s+/g, ' ');
    const apiInfo = capturedResponses.length
      ? ` apiResp=${capturedResponses.map(r => `${r.status} ${r.url}`).join(' | ').slice(0, 200)}`
      : ' apiResp=无';
    return { ok: false, error: `未找到 API Key submit=${postSubmitUrl} 正文=${dashText}${apiInfo}`, detail: postSubmitText };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(watchdog);
    if (browser) await browser.close().catch(() => {});
  }
}

// 主函数
async function main() {
  console.log(`\n========================================`);
  console.log(`[ipdata-batch] 开始注册 ${TARGET_KEYS} 个 Key`);
  console.log(`[ipdata-batch] 主邮箱: ${MAIN_EMAIL}`);
  console.log(`========================================\n`);

  // 读取已注册的 Key 数量
  let existingKeys = [];
  if (fs.existsSync(OUTPUT_FILE)) {
    existingKeys = fs.readFileSync(OUTPUT_FILE, 'utf8').trim().split('\n').filter(Boolean);
  }
  console.log(`[ipdata-batch] 已有 ${existingKeys.length} 个 Key`);

  const startIndex = existingKeys.length;
  const needCount = TARGET_KEYS - startIndex;

  if (needCount <= 0) {
    console.log(`[ipdata-batch] 已达到目标，无需注册`);
    return;
  }

  console.log(`[ipdata-batch] 需要注册 ${needCount} 个新 Key\n`);

  let success = 0;
  let failed = 0;
  let needVerifyCount = 0;

  for (let i = 0; i < needCount; i++) {
    const emailIndex = startIndex + i + 1;
    const email = generateSubEmail(emailIndex);
    const password = genPwd();
    const proxy = await getProxy();

    console.log(`\n[${i + 1}/${needCount}] 注册: ${email}`);
    if (proxy) console.log(`  代理: ${proxy.split('@').pop()}`);

    const result = await register(email, password, proxy);

    if (result.ok) {
      success++;
      console.log(`  ✓ Key: ${result.key}`);
      fs.appendFileSync(OUTPUT_FILE, `${result.key}\n`);
    } else {
      failed++;
      console.log(`  ✗ ${result.error}`);
      if (result.needVerify) {
        needVerifyCount++;
        // 如果需要验证，等待更长时间
        if (needVerifyCount > 3) {
          console.log(`\n[ipdata-batch] 连续需要验证，暂停 5 分钟...`);
          await new Promise(r => setTimeout(r, 300000));
          needVerifyCount = 0;
        }
      }
    }

    // 间隔（避免限流）
    const delay = 3000 + Math.random() * 2000;
    await new Promise(r => setTimeout(r, delay));

    // 每注册 50 个，输出进度
    if ((i + 1) % 50 === 0) {
      console.log(`\n--- 进度: ${i + 1}/${needCount}, 成功: ${success}, 失败: ${failed} ---\n`);
    }
  }

  if (emailDb) emailDb.close();

  console.log(`\n========================================`);
  console.log(`[ipdata-batch] 完成!`);
  console.log(`  成功: ${success}`);
  console.log(`  失败: ${failed}`);
  console.log(`  总计: ${startIndex + success} 个 Key`);
  console.log(`  保存位置: ${OUTPUT_FILE}`);
  console.log(`========================================\n`);
}

main().catch(console.error);