import { listProxies, getProxyById, getProxiesWithoutObservedCountry, setProxyCountry, upsertProxy, deleteProxyById, deleteProxiesByIds, deleteProxiesByFilters, countProxies, proxyExists, computeStats, getProxyIdsToTest, getProxyIdsByFilters, createTestJob, createFullInspectionJob, getActiveFullInspectionJob, getLatestFullInspectionJob, getTestJob, getLatestTestJob, getNextTestJob, claimTestJobItems, claimFullInspectionItems, completeTestJobItems, completeFullInspectionItems, upsertInspectionResult, listFullInspectionItems, finalizeTestJob, getProxyGroups, getSetting, recordExitIpObservation, setProxyRotation, ROTATION_VALUES } from '../db.js';
import { generateId, isValidIp, normalizeGroup, normalizeCountryCode } from '../utils/helpers.js';
import { batchClassify, lookupTestIsp, ispInfoType, lookupCountryIpinfo, lookupCountryLocal } from '../services/classifier.js';
import { inspectIspInfoThroughProxy, testProxies } from '../services/tester.js';

function validateTestFilters(input = {}) {
  const filters = {};
  if (input.type) {
    if (!['residential', 'datacenter', 'mobile', 'unknown'].includes(input.type)) throw new Error('代理类型无效');
    filters.type = input.type;
  }
  if (input.protocol) {
    if (!['http', 'https', 'socks5'].includes(input.protocol)) throw new Error('代理协议无效');
    filters.protocol = input.protocol;
  }
  if (input.alive !== undefined && input.alive !== '') {
    const alive = String(input.alive);
    if (!['true', 'false', 'null'].includes(alive)) throw new Error('检测状态无效');
    filters.alive = alive;
  }
  if (input.country) {
    const country = String(input.country).trim().toUpperCase();
    if (country !== 'UNKNOWN' && !/^[A-Z]{2}$/.test(country)) throw new Error('国家代码无效');
    filters.country = country === 'UNKNOWN' ? 'unknown' : country;
  }
  if (input.rotation) {
    if (!ROTATION_VALUES.has(input.rotation)) throw new Error('会话类型无效');
    filters.rotation = input.rotation;
  }
  if (input.group !== undefined && input.group !== '') filters.group = normalizeGroup(input.group);
  if (input.search) filters.search = String(input.search).trim().slice(0, 100);
  return filters;
}

/** Persist one connectivity result, including the reason when it is unclear. */
function applyTestResult(proxy, result) {
  const now = new Date().toISOString();
  proxy.lastTestOutcome = result.outcome || (result.alive === true ? 'alive' : result.alive === false ? 'dead' : 'inconclusive');
  proxy.lastTestError = String(result.error || '').slice(0, 240);
  proxy.lastCheckAt = now;
  if (result.alive === true || result.alive === false) {
    proxy.alive = result.alive;
    proxy.exitIp = result.exitIp || null;
    proxy.responseTime = result.responseTime || null;
    proxy.anonymity = result.anonymity || null;
  }
  // An observed country (what the target site actually sees through this proxy)
  // outranks every GeoIP lookup, which is why it is written unconditionally.
  const observedCountry = normalizeCountryCode(result.country);
  if (observedCountry) {
    proxy.country = observedCountry;
    proxy.countryName = '';
    proxy.countrySource = 'observed';
  }
  proxy.updatedAt = now;
  upsertProxy(proxy);
  if (result.alive === true && result.exitIp) recordExitIpObservation(proxy.id, result.exitIp);
}

export function setupProxyRoutes(app) {
  let testQueueProcessing = false;

  async function processTestQueue() {
    if (testQueueProcessing) return;
    testQueueProcessing = true;

    try {
      while (true) {
        const job = getNextTestJob();
        if (!job) break;

        if (job.kind === 'full_inspection') {
          await processFullInspectionJob(job);
          continue;
        }

        const batchSize = Math.max(1, Math.min(parseInt(getSetting('testBatchSize')) || 20, 1000));
        const proxyIds = claimTestJobItems(job.id, batchSize);
        if (!proxyIds.length) {
          finalizeTestJob(job.id);
          continue;
        }

        const proxies = proxyIds.map(getProxyById).filter(Boolean);
        const result = proxies.length ? await testProxies(proxies) : { results: [] };
        const resultById = new Map((result.results || []).filter(item => item?.id).map(item => [item.id, item]));
        const completed = proxyIds.map(id => resultById.get(id) || ({ id, alive: null, errorCategory: 'inconclusive' }));

        for (const item of completed) {
          const proxy = getProxyById(item.id);
          if (!proxy) continue;
          applyTestResult(proxy, item);
        }

        completeTestJobItems(job.id, completed);
        finalizeTestJob(job.id);
        computeStats();
      }
    } catch (error) {
      const job = getNextTestJob();
      if (job) finalizeTestJob(job.id, error.message || '检测失败');
      console.error('[test-queue] Error:', error.message);
    } finally {
      testQueueProcessing = false;
      if (getNextTestJob()) processTestQueue();
    }
  }

  async function processFullInspectionJob(job) {
    const batchSize = Math.max(1, Math.min(parseInt(getSetting('testBatchSize')) || 10, 50));
    const items = claimFullInspectionItems(job.id, batchSize);
    if (!items.length) {
      finalizeTestJob(job.id);
      return;
    }

    const results = await Promise.all(items.map(async item => {
      const proxy = getProxyById(item.proxy_id);
      if (!proxy) {
        return { proxyId: item.proxy_id, outcome: 'missing', message: '代理已被删除', testispStatus: 'skipped_missing', ispinfoStatus: 'skipped_missing' };
      }

      const testisp = await lookupTestIsp(item.endpoint_ip || proxy.ip);
      upsertInspectionResult({ jobId: job.id, proxyId: proxy.id, source: 'testisp', ...testisp });
      if (testisp.status === 'success') {
        const info = testisp.normalized;
        proxy.ipType = info.ipType;
        const testispCountry = normalizeCountryCode(info.countryCode);
        if (testispCountry && proxy.country_source !== 'observed') {
          proxy.country = testispCountry;
          proxy.countryName = info.country || '';
          proxy.countrySource = 'testisp';
        }
        proxy.asn = info.asn || '';
        proxy.asName = info.asName || '';
        proxy.isp = info.isp || '';
        proxy.org = info.org || '';
        proxy.lastClassifiedAt = new Date().toISOString();
      }

      const connectivity = (await testProxies([proxy])).results[0];
      let ispinfo;
      if (connectivity.alive === true) {
        ispinfo = await inspectIspInfoThroughProxy(proxy);
      } else {
        ispinfo = { status: 'skipped_no_live_transport', response: {}, normalized: {}, error: connectivity.error || '代理未取得可用连接' };
      }
      upsertInspectionResult({ jobId: job.id, proxyId: proxy.id, source: 'ispinfo', ...ispinfo });

      // ispinfo.io answers from the exit IP itself, so its verdict outranks the
      // testisp.info lookup done on the entry address.
      if (ispinfo.status === 'success') {
        const info = ispinfo.normalized;
        const ipType = ispInfoType(info);
        if (ipType !== 'unknown') proxy.ipType = ipType;
        // A country observed through the proxy itself always wins; ispinfo is
        // only a fallback for proxies whose exit never reported one.
        const ispinfoCountry = normalizeCountryCode(info.countryCode);
        if (ispinfoCountry && proxy.country_source !== 'observed') {
          proxy.country = ispinfoCountry;
          proxy.countryName = info.country || '';
          proxy.countrySource = 'ispinfo';
        }
        if (info.asn) proxy.asn = String(info.asn).startsWith('AS') ? String(info.asn) : `AS${info.asn}`;
        if (info.asnOrg || info.companyName) {
          proxy.asName = info.asnOrg || proxy.asName || '';
          proxy.isp = info.companyName || info.asnOrg || proxy.isp || '';
          proxy.org = info.companyName || info.asnOrg || proxy.org || '';
        }
        proxy.lastClassifiedAt = new Date().toISOString();
      }

      applyTestResult(proxy, connectivity);
      const outcome = proxy.lastTestOutcome;
      return {
        proxyId: proxy.id, outcome, exitIp: connectivity.exitIp || null, responseTime: connectivity.responseTime || null,
        message: connectivity.error || '', testispStatus: testisp.status, ispinfoStatus: ispinfo.status,
      };
    }));
    completeFullInspectionItems(job.id, results);
    finalizeTestJob(job.id);
    computeStats();
  }

  // GET /api/proxies/groups — all configured inventory groups and their proxy counts.
  app.get('/api/proxies/groups', (req, res) => {
    res.json({ groups: getProxyGroups() });
  });

  // GET /api/proxies — list with filters
  app.get('/api/proxies', (req, res) => {
    try {
      const { type, country, protocol, alive, tag, group, search, sort, order, limit, offset, rotation } = req.query;
      if (rotation && !ROTATION_VALUES.has(rotation)) throw new Error('会话类型无效');
      const result = listProxies({ type, country, protocol, alive, tag, group, search, rotation, sort, order, limit: parseInt(limit) || 0, offset: parseInt(offset) || 0 });
      // Convert snake_case to camelCase for API compatibility
      result.proxies = result.proxies.map(proxyToCamel);
      res.json({ ...result, truncated: false });
    } catch (e) {
      res.status(500).json({ error: '加载代理列表失败: ' + (e.message || '内部错误'), proxies: [], total: 0 });
    }
  });

  // POST /api/proxies — add single proxy
  app.post('/api/proxies', (req, res) => {

    const { ip, port, protocol, username, password, tags, group, notes } = req.body;
    if (!ip || !port || !protocol) return res.status(400).json({ error: 'IP, port, protocol are required' });
    if (!isValidIp(ip)) return res.status(400).json({ error: 'Invalid IP address' });
    if (port < 1 || port > 65535) return res.status(400).json({ error: 'Invalid port' });
    if (!['http', 'https', 'socks5'].includes(protocol)) return res.status(400).json({ error: 'Invalid protocol' });

    if (proxyExists(ip, parseInt(port), protocol)) {
      return res.status(409).json({ error: 'Proxy already exists' });
    }

    let groupName;
    try { groupName = normalizeGroup(group); }
    catch (error) { return res.status(400).json({ error: error.message }); }

    const proxy = {
      id: generateId(), ip, port: parseInt(port), protocol, username: username || '', password: password || '',
      ipType: 'unknown', country: 'unknown', countryName: '', asn: '', asName: '', isp: '', org: '',
      alive: null, lastCheckAt: null, exitIp: null, responseTime: null, anonymity: null,
      source: 'manual', tags: tags || [], groupName, notes: notes || '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };

    upsertProxy(proxy);
    computeStats();
    res.status(201).json({ ok: true, proxy: proxyToCamel(proxy) });
  });

  // GET /api/proxies/:id
  app.get('/api/proxies/:id', (req, res) => {
    const proxy = getProxyById(req.params.id);
    if (!proxy) return res.status(404).json({ error: 'Not found' });
    res.json({ proxy: proxyToCamel(proxy) });
  });

  // PUT /api/proxies/:id
  app.put('/api/proxies/:id', (req, res) => {

    const existing = getProxyById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const body = req.body;
    let groupName = existing.group_name || existing.groupName || '';
    if (Object.prototype.hasOwnProperty.call(body, 'group')) {
      try { groupName = normalizeGroup(body.group); }
      catch (error) { return res.status(400).json({ error: error.message }); }
    }
    const updated = {
      ...existing,
      ip: body.ip || existing.ip,
      port: body.port ? parseInt(body.port) : existing.port,
      protocol: body.protocol || existing.protocol,
      username: body.username !== undefined ? body.username : existing.username,
      password: body.password !== undefined ? body.password : existing.password,
      tags: body.tags || existing.tags,
      groupName,
      notes: body.notes !== undefined ? body.notes : existing.notes,
      updatedAt: new Date().toISOString(),
    };

    upsertProxy(updated);
    computeStats();
    res.json({ ok: true, proxy: proxyToCamel(updated) });
  });

  // DELETE /api/proxies/:id
  app.delete('/api/proxies/:id', (req, res) => {
    const deleted = deleteProxyById(req.params.id);
    computeStats();
    res.json({ ok: deleted });
  });

  // POST /api/proxies/batch-delete
  app.post('/api/proxies/batch-delete', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    const deleted = deleteProxiesByIds(ids);
    computeStats();
    res.json({ ok: true, deleted });
  });

  // POST /api/proxies/classify
  app.post('/api/proxies/classify', async (req, res) => {

    const { ids, all } = req.body;
    let toClassify;

    if (ids && ids.length) {
      toClassify = ids.map(id => getProxyById(id)).filter(Boolean);
    } else if (all) {
      // Explicit refresh: re-check every stored proxy through TestISP, not only
      // the ones currently marked unknown.
      const { proxies } = listProxies();
      toClassify = proxies;
    } else {
      const { proxies } = listProxies({ type: 'unknown' });
      toClassify = proxies;
    }

    if (!toClassify.length) {
      return res.json({ message: '没有需要分类的代理', classified: 0 });
    }

    // Classify in background
    const count = toClassify.length;
    (async () => {
      try {
        const classified = await batchClassify(toClassify);
        for (const p of classified) upsertProxy(p);
        computeStats();
      } catch (e) { console.error('[classify] Error:', e.message); }
    })();

    res.json({ message: `正在分类 ${count} 个代理`, classified: 0, total: count });
  });

  // POST /api/proxies/:id/classify
  app.post('/api/proxies/:id/classify', async (req, res) => {

    const proxy = getProxyById(req.params.id);
    if (!proxy) return res.status(404).json({ error: 'Not found' });

    try {
      const classified = await batchClassify([proxy]);
      const updated = classified[0] || proxy;
      upsertProxy(updated);
      computeStats();
      res.json({ ok: true, proxy: proxyToCamel(updated) });
    } catch (e) {
      res.status(500).json({ error: '分类失败: ' + e.message });
    }
  });

  // GET /api/proxies/test/status — persisted batch test progress.
  app.get('/api/proxies/test/status', (req, res) => {
    const job = req.query.jobId ? getTestJob(req.query.jobId) : getLatestTestJob();
    res.json(job || { status: 'idle', total: 0, completed: 0, alive: 0, failed: 0, inconclusive: 0 });
  });

  // POST /api/proxies/full-inspection — durable all-current snapshot using TestISP and ispinfo.
  app.post('/api/proxies/full-inspection', (req, res) => {
    try {
      const active = getActiveFullInspectionJob();
      if (active) return res.status(409).json({ error: '已有全库双来源检测正在运行', job: active });
      const job = createFullInspectionJob(generateId());
      if (!job.total) return res.status(422).json({ error: '暂无可检测代理' });
      processTestQueue();
      res.status(202).json({ ok: true, message: `已创建 ${job.total} 个代理的全库双来源检测任务`, job });
    } catch (error) {
      res.status(500).json({ error: '创建全库检测任务失败: ' + (error.message || '内部错误') });
    }
  });

  app.get('/api/proxies/full-inspection/status', (req, res) => {
    const job = req.query.jobId ? getTestJob(req.query.jobId) : getLatestFullInspectionJob();
    if (!job || job.kind !== 'full_inspection') return res.status(404).json({ error: '未找到全库双来源检测任务' });
    res.json(job);
  });

  app.get('/api/proxies/full-inspection/:jobId/items', (req, res) => {
    const job = getTestJob(req.params.jobId);
    if (!job || job.kind !== 'full_inspection') return res.status(404).json({ error: '未找到全库双来源检测任务' });
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 200));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    res.json({ job, ...listFullInspectionItems(job.id, limit, offset) });
  });

  // POST /api/proxies/test — create a bounded durable snapshot that survives page closes and restarts.
  app.post('/api/proxies/test', (req, res) => {
    try {
      const requestedIds = Array.isArray(req.body.ids) && req.body.ids.length ? [...new Set(req.body.ids)] : null;
      if (requestedIds && requestedIds.length > 1000) {
        return res.status(400).json({ error: '一次最多检测 1000 个代理' });
      }

      let proxyIds;
      let truncated = false;
      let scope = 'untested';
      if (requestedIds) {
        scope = 'selected';
        proxyIds = requestedIds.filter(id => getProxyById(id));
      } else if (req.body.scope === 'filtered') {
        scope = 'filtered';
        const selected = getProxyIdsByFilters(validateTestFilters(req.body.filters), 1000);
        proxyIds = selected.ids;
        truncated = selected.truncated;
      } else {
        const untestedIds = getProxyIdsToTest(null, 1001);
        truncated = untestedIds.length > 1000;
        proxyIds = untestedIds.slice(0, 1000);
      }

      if (!proxyIds.length) return res.json({ message: '没有需要检测的代理', total: 0, limit: 1000, truncated: false });

      const job = createTestJob(generateId(), proxyIds);
      processTestQueue();
      const suffix = truncated ? (scope === 'filtered' ? '（当前筛选超过上限，仅检测前 1000 个）' : '（未检测代理超过上限，仅检测前 1000 个）') : '';
      res.status(202).json({ message: `已创建检测任务：${job.total} 个代理${suffix}`, job, scope, total: job.total, limit: 1000, truncated });
    } catch (error) {
      res.status(400).json({ error: error.message || '创建检测任务失败' });
    }
  });

  // POST /api/proxies/backfill-country — fill in the country of proxies that
  // were never probed successfully, preferring ipinfo.io and falling back to the
  // local MaxMind database. Proxies with an observed country are left alone.
  app.post('/api/proxies/backfill-country', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(parseInt(req.body?.limit, 10) || 2000, 20000));
      const pending = getProxiesWithoutObservedCountry(limit);
      if (!pending.length) return res.json({ checked: 0, updated: 0, bySource: {} });

      const fromIpinfo = await lookupCountryIpinfo(pending.map(proxy => proxy.ip));
      const bySource = { ipinfo: 0, geolite: 0 };
      let updated = 0;

      for (const proxy of pending) {
        // The local database is consulted either way: it is the only source of
        // the registration country, which is what people see on lookup sites.
        const local = await lookupCountryLocal(proxy.ip);
        const hit = fromIpinfo.get(proxy.ip);
        const resolved = hit || local;
        if (!resolved) continue;
        const source = hit ? 'ipinfo' : 'geolite';
        setProxyCountry(proxy.id, {
          countryCode: resolved.countryCode,
          countryName: resolved.countryName || '',
          registeredCountry: local?.registeredCountry || '',
          source,
        });
        bySource[source]++;
        updated++;
      }

      computeStats();
      res.json({ checked: pending.length, updated, bySource, ipinfoConfigured: Boolean(String(process.env.IPINFO_TOKEN || '').trim()) });
    } catch (error) {
      res.status(500).json({ error: error.message || '补齐国家失败' });
    }
  });

  // POST /api/proxies/delete-filtered — remove every proxy matching the filter,
  // so cleaning out a dead pool does not mean paging through it by hand.
  app.post('/api/proxies/delete-filtered', (req, res) => {
    try {
      const filters = validateTestFilters(req.body || {});
      if (!Object.keys(filters).length) return res.status(400).json({ error: '请先设置筛选条件，避免误删全部代理' });
      const deleted = deleteProxiesByFilters(filters);
      computeStats();
      res.json({ deleted });
    } catch (error) {
      res.status(400).json({ error: error.message || '批量删除失败' });
    }
  });

  // POST /api/proxies/rotation — mark proxies as sticky / rotating by hand.
  app.post('/api/proxies/rotation', (req, res) => {
    const { ids, rotation } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '请选择代理' });
    if (!ROTATION_VALUES.has(rotation)) return res.status(400).json({ error: '会话类型无效' });
    let updated = 0;
    for (const id of ids.slice(0, 1000)) {
      try { if (setProxyRotation(id, rotation)) updated++; } catch {}
    }
    res.json({ updated, rotation });
  });

  // POST /api/proxies/:id/test
  app.post('/api/proxies/:id/test', async (req, res) => {

    const proxy = getProxyById(req.params.id);
    if (!proxy) return res.status(404).json({ error: 'Not found' });

    try {
      const result = await testProxies([proxy]);
      if (result.results && result.results[0]) {
        const r = result.results[0];
        applyTestResult(proxy, r);
        computeStats();
        const fresh = getProxyById(proxy.id);
        if (r.alive === true || r.alive === false) {
          return res.json({ proxy: proxyToCamel(fresh), result: r });
        }
        return res.json({ message: `该代理无法检测：${r.error || r.outcome || '协议不受支持'}`, proxy: proxyToCamel(fresh), result: r });
      }
      res.json({ message: '检测完成', proxy: proxyToCamel(proxy) });
    } catch (e) {
      res.status(500).json({ error: '检测失败: ' + e.message });
    }
  });

  // Resume any durable test job left by a previous process or browser session.
  queueMicrotask(() => processTestQueue());
}

// Convert DB snake_case to API camelCase
function proxyToCamel(p) {
  return {
    id: p.id,
    ip: p.ip,
    port: p.port,
    protocol: p.protocol,
    username: p.username,
    password: p.password,
    extra: p.extra || {},
    ipType: p.ipType || p.ip_type,
    country: p.country,
    countryName: p.countryName || p.country_name,
    countrySource: p.countrySource || p.country_source || '',
    registeredCountry: p.registeredCountry || p.registered_country || '',
    asn: p.asn,
    asName: p.asName || p.as_name,
    isp: p.isp,
    org: p.org,
    alive: p.alive,
    exitIp: p.exitIp || p.exit_ip,
    responseTime: p.responseTime || p.response_time,
    anonymity: p.anonymity,
    rotation: p.rotation || 'unknown',
    rotationSource: p.rotationSource || p.rotation_source || '',
    exitIpHistory: p.exitIpHistory || p.exit_ip_history || [],
    lastTestOutcome: p.lastTestOutcome || p.last_test_outcome || '',
    lastTestError: p.lastTestError || p.last_test_error || '',
    lastCheckAt: p.lastCheckAt || p.last_check_at,
    lastClassifiedAt: p.lastClassifiedAt || p.last_classified_at,
    source: p.source,
    tags: p.tags,
    group: p.groupName || p.group_name || '',
    notes: p.notes,
    createdAt: p.createdAt || p.created_at,
    updatedAt: p.updatedAt || p.updated_at,
  };
}
