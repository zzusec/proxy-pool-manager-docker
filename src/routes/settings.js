import crypto from 'crypto';
import { getSetting, setSetting, getAdminSettings, setAdminSettings } from '../db.js';
import { hashPassword, secureEqual } from '../utils/crypto.js';
import { DEFAULT_TEST_TARGETS } from '../utils/helpers.js';
import { getGeoLiteStatus, updateGeoLiteDatabases } from '../services/classifier.js';
import { getIpdataStatus, isIpdataConfigured, clearIpdataCache, lookupIpdata, testIpdataKey, getIpdataApiKeys, setIpdataApiKeys } from '../services/ipdata.js';

let geoLiteUpdatePromise = null;
let geoLiteLastResult = null;

function readInteger(value, fallback, min, max, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} 必须介于 ${min} 和 ${max} 之间`);
  }
  return parsed;
}

function isPrivateTargetHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = ipv4.slice(1).map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function normalizeTestTargets(value) {
  if (!Array.isArray(value) || value.length !== 3) throw new Error('需要配置 3 个检测目标');
  return value.map((raw, index) => {
    let target;
    try { target = new URL(String(raw).trim()); }
    catch { throw new Error(`检测目标 ${index + 1} 不是有效 URL`); }
    if (!['http:', 'https:'].includes(target.protocol) || isPrivateTargetHost(target.hostname)) {
      throw new Error(`检测目标 ${index + 1} 必须是公开 HTTP/HTTPS 地址`);
    }
    return target.toString();
  });
}

function getTestTargets() {
  try {
    const configured = JSON.parse(getSetting('testTargets') || 'null');
    return normalizeTestTargets(configured);
  } catch {
    return DEFAULT_TEST_TARGETS;
  }
}

function getSystemSettings() {
  const checkInterval = Number.parseInt(getSetting('checkInterval'), 10) || 600;
  const autoClassify = getSetting('autoClassify') !== 'false';
  const autoTestEnabled = getSetting('autoTestEnabled') !== 'false';
  const autoDeleteDead = getSetting('autoDeleteDead') !== 'false';
  const classifyBatchSize = Number.parseInt(getSetting('classifyBatchSize'), 10) || 200;
  const testBatchSize = Number.parseInt(getSetting('testBatchSize'), 10) || 20;
  const testConcurrency = Number.parseInt(getSetting('testConcurrency'), 10) || 10;
  const testTimeout = Number.parseInt(getSetting('testTimeout'), 10) || 10000;
  const primaryColor = /^#[0-9a-f]{6}$/i.test(getSetting('primaryColor') || '') ? getSetting('primaryColor') : '#07c160';
  const testerConfigured = true;
  const ipdata = getIpdataStatus();
  const classifierConfigured = ipdata.configured;
  const classifierProvider = ipdata.configured
    ? `ipdata.co（机房/ISP 判定，${ipdata.total} 个 Key 轮换，当前可用 ${ipdata.available}）`
    : '未配置 ipdata API Key，暂用 testisp.info + ispinfo.io';

  return {
    ipdata,
    checkInterval,
    autoClassify,
    autoTestEnabled,
    autoDeleteDead,
    classifyBatchSize,
    testBatchSize,
    testConcurrency,
    testTimeout,
    testTargets: getTestTargets(),
    primaryColor,
    classifierConfigured,
    classifierProvider,
    testerConfigured,
    builtInTester: true,
  };
}

export function setupSettingsRoutes(app) {
  app.get('/api/settings/system', (req, res) => {
    res.json(getSystemSettings());
  });

  app.get('/api/settings/geolite', async (req, res) => {
    res.json({
      ...(await getGeoLiteStatus()),
      updating: !!geoLiteUpdatePromise,
      lastResult: geoLiteLastResult,
    });
  });

  app.post('/api/settings/geolite/update', (req, res) => {
    if (!geoLiteUpdatePromise) {
      geoLiteUpdatePromise = updateGeoLiteDatabases()
        .then(result => { geoLiteLastResult = { ok: true, ...result, completedAt: new Date().toISOString() }; })
        .catch(error => { geoLiteLastResult = { ok: false, error: error.message || '下载失败', completedAt: new Date().toISOString() }; })
        .finally(() => { geoLiteUpdatePromise = null; });
    }
    res.status(202).json({ ok: true, message: 'GeoLite 数据库下载已启动' });
  });

  // GET /api/settings/ipdata — key presence and quota state, never the key itself.
  app.get('/api/settings/ipdata', (req, res) => {
    res.json(getIpdataStatus());
  });

  // POST /api/settings/ipdata — grow, replace or clear the key pool without a
  // restart. Several free keys can be stacked: the pool rotates and moves on
  // when one runs out of daily quota.
  function readKeys(value) {
    const list = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/);
    const keys = list.map(item => String(item || '').trim()).filter(Boolean);
    for (const key of keys) {
      if (!/^[A-Za-z0-9._-]{10,200}$/.test(key)) throw new Error(`API Key 格式无效：${key.slice(0, 6)}…`);
    }
    return keys;
  }

  app.post('/api/settings/ipdata', (req, res) => {
    try {
      const body = req.body || {};
      const stored = getIpdataApiKeys().filter(entry => entry.source === 'settings').map(entry => entry.key);

      if (body.apiKeys !== undefined) {
        // Full replacement — the caller sent the pool it wants.
        setIpdataApiKeys(readKeys(body.apiKeys));
      } else if (body.removeIndex !== undefined) {
        const index = Number.parseInt(body.removeIndex, 10);
        if (!Number.isInteger(index) || index < 0 || index >= stored.length) throw new Error('要删除的 Key 不存在');
        setIpdataApiKeys(stored.filter((_, position) => position !== index));
      } else {
        const added = readKeys(body.apiKey);
        // An empty submission is the explicit "clear the pool" gesture.
        setIpdataApiKeys(added.length ? [...stored, ...added] : []);
      }
      clearIpdataCache();
      res.json({ ok: true, ...getIpdataStatus() });
    } catch (error) {
      res.status(400).json({ error: error.message || 'API Key 无效' });
    }
  });

  // POST /api/settings/ipdata/test — spend one lookup to prove a key works.
  // Without `index` the pool decides; with it, that one key is tested alone.
  app.post('/api/settings/ipdata/test', async (req, res) => {
    if (!isIpdataConfigured()) return res.status(400).json({ error: '尚未配置 ipdata API Key' });
    const ip = String(req.body?.ip || '8.8.8.8').trim();
    const index = req.body?.index;
    const result = index === undefined || index === null || index === ''
      ? await lookupIpdata(ip)
      : await testIpdataKey(Number.parseInt(index, 10), ip);
    if (result.status !== 'success') return res.status(400).json({ error: result.error || 'ipdata 查询失败', status: result.status });
    const { ipType, asnType, companyType, dualIsp, asn, isp, countryCode } = result.normalized;
    res.json({ ok: true, ip: result.queriedIp, ipType, asnType, companyType, dualIsp, asn, isp, countryCode, cached: !!result.cached });
  });

  // GET /api/settings/api — API credentials and endpoint examples for the administrator.
  app.get('/api/settings/api', (req, res) => {
    const adminSettings = getAdminSettings();
    const apiKey = adminSettings.apiKey || process.env.API_KEY || '';
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ apiKey, enabled: adminSettings.apiEnabled !== false, baseUrl });
  });

  // POST /api/settings/api/regenerate — replace the external caller credential.
  app.post('/api/settings/api/regenerate', (req, res) => {
    const adminSettings = getAdminSettings();
    const apiKey = crypto.randomBytes(24).toString('hex');
    setAdminSettings({ ...adminSettings, apiKey, apiEnabled: true });
    res.json({ apiKey, enabled: true });
  });

  // POST /api/settings/api/toggle — immediately enable or disable external access.
  app.post('/api/settings/api/toggle', (req, res) => {
    const adminSettings = getAdminSettings();
    const enabled = req.body.enabled !== false;
    setAdminSettings({ ...adminSettings, apiEnabled: enabled });
    res.json({ ok: true, enabled });
  });

  // POST /api/settings/system — validate and persist runtime policies without a restart.
  app.post('/api/settings/system', (req, res) => {
    try {
      const body = req.body || {};
      if (body.checkInterval !== undefined) setSetting('checkInterval', readInteger(body.checkInterval, 600, 60, 2_592_000, '检测间隔'));
      if (body.autoClassify !== undefined) setSetting('autoClassify', String(body.autoClassify === true || body.autoClassify === 'true'));
      if (body.autoTestEnabled !== undefined) setSetting('autoTestEnabled', String(body.autoTestEnabled === true || body.autoTestEnabled === 'true'));
      if (body.autoDeleteDead !== undefined) setSetting('autoDeleteDead', String(body.autoDeleteDead === true || body.autoDeleteDead === 'true'));
      if (body.classifyBatchSize !== undefined) setSetting('classifyBatchSize', readInteger(body.classifyBatchSize, 200, 1, 1000, '每轮分类数量'));
      if (body.testBatchSize !== undefined) setSetting('testBatchSize', readInteger(body.testBatchSize, 1, 1, 1000, '检测队列批次大小'));
      if (body.testConcurrency !== undefined) setSetting('testConcurrency', readInteger(body.testConcurrency, 10, 1, 50, '检测并发数'));
      if (body.testTimeout !== undefined) setSetting('testTimeout', readInteger(body.testTimeout, 10000, 1000, 60000, '检测超时'));
      if (body.testTargets !== undefined) setSetting('testTargets', JSON.stringify(normalizeTestTargets(body.testTargets)));
      if (body.primaryColor !== undefined) {
        const primaryColor = String(body.primaryColor).trim();
        if (!/^#[0-9a-f]{6}$/i.test(primaryColor)) throw new Error('主题颜色必须是 6 位十六进制颜色');
        setSetting('primaryColor', primaryColor.toLowerCase());
      }
      res.json({ ok: true, settings: getSystemSettings() });
    } catch (error) {
      res.status(400).json({ error: error.message || '设置无效' });
    }
  });

  // POST /api/account/password
  app.post('/api/account/password', async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: '请填写所有字段' });

    const adminSettings = getAdminSettings();
    const secret = process.env.SESSION_SECRET;
    if (adminSettings.passwordHash) {
      const hash = hashPassword(currentPassword, secret);
      if (!secureEqual(hash, adminSettings.passwordHash)) return res.status(400).json({ error: '当前密码错误' });
    } else if (!secureEqual(currentPassword, process.env.ADMIN_PASSWORD)) {
      return res.status(400).json({ error: '当前密码错误' });
    }

    if (confirmPassword && newPassword !== confirmPassword) return res.status(400).json({ error: '两次输入的新密码不一致' });

    const newHash = hashPassword(newPassword, secret);
    setAdminSettings({ ...adminSettings, passwordHash: newHash });
    res.json({ ok: true });
  });
}
