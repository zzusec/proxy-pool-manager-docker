import { listProxies, getProxyById, getProxiesWithoutObservedCountry, setProxyCountry, upsertProxy, deleteProxyById, deleteProxiesByIds, deleteProxiesByFilters, countProxies, proxyExists, computeStats, createTestSelectionJob, createFullInspectionJob, getActiveFullInspectionJob, getLatestFullInspectionJob, getTestJob, getLatestTestJob, getNextFullInspectionJob, claimFullInspectionItems, completeFullInspectionItems, upsertInspectionResult, listFullInspectionItems, finalizeTestJob, getProxyGroups, getSetting, recordIpdataUsage, setProxyRotation, ROTATION_VALUES, createProxyAndEnqueue, resetProxyConnectivityAndEnqueue, materializeTestJobSelection, proxyEndpointKey } from '../db.js';
import { generateId, isValidIp, normalizeGroup, normalizeCountryCode } from '../utils/helpers.js';
import { batchClassify, lookupTestIsp, ispInfoType, lookupCountryIpinfo, lookupCountryLocal, prefilterDatacenter } from '../services/classifier.js';
import { lookupIpdata, ipdataDetail, isIpdataConfigured } from '../services/ipdata.js';
import { inspectIspInfoThroughProxy, testProxies } from '../services/tester.js';
import { applyTestResult, wakeConnectivityWorker } from '../services/connectivity.js';

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

export function setupProxyRoutes(app) {
  let fullInspectionProcessing = false;

  async function processFullInspectionQueue() {
    if (fullInspectionProcessing) return;
    fullInspectionProcessing = true;
    try {
      while (true) {
        const job = getNextFullInspectionJob();
        if (!job) break;
        if (job.selectionStatus !== 'done') {
          materializeTestJobSelection(job.id, 500);
          await new Promise(resolve => setImmediate(resolve));
          continue;
        }
        await processFullInspectionJob(job);
        await new Promise(resolve => setImmediate(resolve));
      }
    } catch (error) {
      const job = getNextFullInspectionJob();
      if (job) finalizeTestJob(job.id, error.message || '全库检测失败');
      console.error('[full-inspection] Error:', error.message);
    } finally {
      fullInspectionProcessing = false;
      if (getNextFullInspectionJob()) setImmediate(processFullInspectionQueue);
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
      const expectedEndpointKey = proxyEndpointKey(proxy);

      const testisp = await lookupTestIsp(item.endpoint_ip || proxy.ip);
      upsertInspectionResult({ jobId: job.id, proxyId: proxy.id, source: 'testisp', ...testisp });
      if (testisp.status === 'success') {
        const info = testisp.normalized;
        proxy.ipType = info.ipType;
        proxy.ipTypeSource = 'testisp';
        proxy.ipTypeDetail = '';
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
        if (ipType !== 'unknown') {
          proxy.ipType = ipType;
          proxy.ipTypeSource = 'ispinfo';
          proxy.ipTypeDetail = '';
        }
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

      // ipdata.co has the final word on 机房 vs ISP. It is asked about the real
      // exit address when one was observed, falling back to the entry endpoint.
      // A proxy that definitively failed will be deleted, so skip spending the
      // daily quota on an address that will no longer remain in the pool.
      const willBeDeleted = connectivity.alive === false;
      const subjectIp = connectivity.exitIp || item.endpoint_ip || proxy.ip;
      let ipdata = { status: 'skipped_dead', response: {}, normalized: {}, error: '代理已失效，跳过 ipdata 查询' };
      if (!willBeDeleted) {
        // Known hosting ASNs are decided from the local database — no quota spent.
        const local = await prefilterDatacenter(subjectIp);
        if (local) {
          recordIpdataUsage({ savedByPrefilter: 1 });
          ipdata = { status: 'skipped_prefilter', response: {}, normalized: {}, error: local.prefilterNote };
          proxy.ipType = 'datacenter';
          proxy.ipTypeSource = 'local-asn';
          proxy.ipTypeDetail = local.prefilterNote;
          if (local.asn) proxy.asn = local.asn;
          if (local.asName) proxy.asName = local.asName;
          proxy.lastClassifiedAt = new Date().toISOString();
        } else {
          ipdata = await lookupIpdata(subjectIp);
        }
        upsertInspectionResult({ jobId: job.id, proxyId: proxy.id, source: 'ipdata', ...ipdata });
      }
      if (ipdata.status === 'success' && ipdata.normalized.ipType !== 'unknown') {
        const info = ipdata.normalized;
        // Mobile carriers are ISPs to ipdata; keep the finer label when the exit
        // probe already recognised a mobile network.
        const mobileSeen = ispinfo.status === 'success' && ispinfo.normalized?.isMobile;
        proxy.ipType = info.ipType === 'residential' && mobileSeen ? 'mobile' : info.ipType;
        proxy.ipTypeSource = 'ipdata';
        proxy.ipTypeDetail = ipdataDetail(info);
        proxy.threatCount = info.threatCount ?? null;
        proxy.trustScore = info.trustScore ?? null;
        proxy.threatFlags = info.threatFlags || [];
        proxy.riskLevel = info.riskLevel || '';
        if (info.asn) proxy.asn = info.asn;
        if (info.asName) proxy.asName = info.asName;
        if (info.isp) proxy.isp = info.isp;
        if (info.org) proxy.org = info.org;
        const ipdataCountry = normalizeCountryCode(info.countryCode);
        if (ipdataCountry && (proxy.countrySource || proxy.country_source) !== 'observed') {
          proxy.country = ipdataCountry;
          proxy.countryName = info.country || '';
          proxy.countrySource = 'ipdata';
        }
        proxy.lastClassifiedAt = new Date().toISOString();
      }

      const { outcome } = applyTestResult(proxy, connectivity, expectedEndpointKey);
      return {
        proxyId: proxy.id, outcome, exitIp: connectivity.exitIp || null, responseTime: connectivity.responseTime || null,
        message: connectivity.error || '', testispStatus: testisp.status, ispinfoStatus: ispinfo.status,
        ipdataStatus: ipdata.status,
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

    createProxyAndEnqueue(proxy, 'manual_create');
    wakeConnectivityWorker();
    computeStats();
    res.status(201).json({ ok: true, proxy: proxyToCamel(getProxyById(proxy.id)) });
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
      extra: body.extra !== undefined ? body.extra : existing.extra,
      tags: body.tags || existing.tags,
      groupName,
      notes: body.notes !== undefined ? body.notes : existing.notes,
      updatedAt: new Date().toISOString(),
    };

    if (!updated.ip || !updated.port || !updated.protocol) return res.status(400).json({ error: 'IP, port, protocol are required' });
    if (updated.port < 1 || updated.port > 65535) return res.status(400).json({ error: 'Invalid port' });
    const endpointChanged = ['ip', 'port', 'protocol', 'username', 'password'].some(key => String(updated[key] ?? '') !== String(existing[key] ?? ''))
      || JSON.stringify(updated.extra || {}) !== JSON.stringify(existing.extra || {});
    if (endpointChanged && proxyExists(updated.ip, updated.port, updated.protocol)
      && (updated.ip !== existing.ip || updated.port !== existing.port || updated.protocol !== existing.protocol)) {
      return res.status(409).json({ error: 'Proxy already exists' });
    }

    const saved = endpointChanged
      ? resetProxyConnectivityAndEnqueue(updated, 'endpoint_edit')
      : (upsertProxy(updated), getProxyById(updated.id));
    if (endpointChanged) wakeConnectivityWorker();
    computeStats();
    res.json({ ok: true, proxy: proxyToCamel(saved) });
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
      // Explicit refresh: re-check every stored proxy through ipdata, not only
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

    const provider = isIpdataConfigured() ? 'ipdata.co' : '未配置 ipdata API Key，回退 TestISP/GeoLite';
    res.json({ message: `正在分类 ${count} 个代理（${provider}）`, classified: 0, total: count });
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
      processFullInspectionQueue();
      res.status(202).json({ ok: true, message: '已创建全库双来源检测任务，正在准备全部代理', job });
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

  // POST /api/proxies/test — create an unlimited logical snapshot. Matching IDs
  // are materialized in bounded background pages so this request stays fast.
  app.post('/api/proxies/test', (req, res) => {
    try {
      const body = req.body || {};
      const requestedIds = Array.isArray(body.ids) && body.ids.length ? [...new Set(body.ids.map(String))] : null;
      let mode = 'untested';
      let scope = 'untested';
      let filters = {};
      let ids = [];

      if (requestedIds) {
        mode = 'selected';
        scope = 'selected';
        ids = requestedIds;
      } else if (body.scope === 'filtered') {
        mode = 'filtered';
        scope = 'filtered';
        filters = validateTestFilters(body.filters);
      }

      const job = createTestSelectionJob(generateId(), { mode, scope, filters, ids });
      wakeConnectivityWorker();
      res.status(202).json({
        message: scope === 'filtered' ? '已创建全部筛选结果检测任务，正在准备队列' : scope === 'selected' ? `已创建 ${ids.length} 个选中代理的检测任务` : '已创建全部未检测代理任务，正在准备队列',
        job,
        scope,
        truncated: false,
      });
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

  // POST /api/proxies/:id/test — single checks use the same durable worker so a
  // slow/dead proxy cannot hold the HTTP request open until a reverse proxy 502.
  app.post('/api/proxies/:id/test', (req, res) => {
    const proxy = getProxyById(req.params.id);
    if (!proxy) return res.status(404).json({ error: 'Not found' });
    try {
      const job = createTestSelectionJob(generateId(), { mode: 'selected', scope: 'single', ids: [proxy.id] });
      wakeConnectivityWorker();
      res.status(202).json({ ok: true, message: '已加入后台检测队列', job });
    } catch (error) {
      res.status(400).json({ error: '创建检测任务失败: ' + (error.message || '内部错误') });
    }
  });

  // Resume any durable full-inspection job left by a previous process or browser session.
  setImmediate(processFullInspectionQueue);
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
    ipTypeSource: p.ipTypeSource || p.ip_type_source || '',
    ipTypeDetail: p.ipTypeDetail || p.ip_type_detail || '',
    threatCount: p.threatCount ?? p.threat_count ?? null,
    trustScore: p.trustScore ?? p.trust_score ?? null,
    threatFlags: Array.isArray(p.threatFlags) ? p.threatFlags : String(p.threat_flags || '').split(',').filter(Boolean),
    riskLevel: p.riskLevel || p.risk_level || '',
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
