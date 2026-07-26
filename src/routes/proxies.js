import { listProxies, getProxyById, upsertProxy, deleteProxyById, deleteProxiesByIds, proxyExists, computeStats, getProxyIdsToTest, createTestJob, getTestJob, getLatestTestJob, getNextTestJob, claimTestJobItems, completeTestJobItems, finalizeTestJob } from '../db.js';
import { generateId, isValidIp } from '../utils/helpers.js';
import { batchClassify } from '../services/classifier.js';
import { testProxies } from '../services/tester.js';

export function setupProxyRoutes(app) {
  let testQueueProcessing = false;

  async function processTestQueue() {
    if (testQueueProcessing) return;
    testQueueProcessing = true;

    try {
      while (true) {
        const job = getNextTestJob();
        if (!job) break;

        const proxyIds = claimTestJobItems(job.id, 20);
        if (!proxyIds.length) {
          finalizeTestJob(job.id);
          continue;
        }

        const proxies = proxyIds.map(getProxyById).filter(Boolean);
        const result = proxies.length ? await testProxies(proxies) : { results: [] };
        const resultById = new Map((result.results || []).filter(item => item?.id).map(item => [item.id, item]));
        const completed = proxyIds.map(id => resultById.get(id) || ({ id, alive: false, exitIp: null, responseTime: null, anonymity: null }));

        for (const item of completed) {
          const proxy = getProxyById(item.id);
          if (!proxy) continue;
          proxy.alive = item.alive;
          proxy.exitIp = item.exitIp || null;
          proxy.responseTime = item.responseTime || null;
          proxy.anonymity = item.anonymity || null;
          proxy.lastCheckAt = new Date().toISOString();
          proxy.updatedAt = new Date().toISOString();
          upsertProxy(proxy);
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

  // GET /api/proxies — list with filters
  app.get('/api/proxies', (req, res) => {
    try {
      const { type, country, protocol, alive, tag, search, sort, order, limit, offset } = req.query;
      const result = listProxies({ type, country, protocol, alive, tag, search, sort, order, limit: parseInt(limit) || 0, offset: parseInt(offset) || 0 });
      // Convert snake_case to camelCase for API compatibility
      result.proxies = result.proxies.map(proxyToCamel);
      res.json({ ...result, truncated: false });
    } catch (e) {
      res.status(500).json({ error: '加载代理列表失败: ' + (e.message || '内部错误'), proxies: [], total: 0 });
    }
  });

  // POST /api/proxies — add single proxy
  app.post('/api/proxies', (req, res) => {

    const { ip, port, protocol, username, password, tags, notes } = req.body;
    if (!ip || !port || !protocol) return res.status(400).json({ error: 'IP, port, protocol are required' });
    if (!isValidIp(ip)) return res.status(400).json({ error: 'Invalid IP address' });
    if (port < 1 || port > 65535) return res.status(400).json({ error: 'Invalid port' });
    if (!['http', 'https', 'socks5'].includes(protocol)) return res.status(400).json({ error: 'Invalid protocol' });

    if (proxyExists(ip, parseInt(port), protocol)) {
      return res.status(409).json({ error: 'Proxy already exists' });
    }

    const proxy = {
      id: generateId(), ip, port: parseInt(port), protocol, username: username || '', password: password || '',
      ipType: 'unknown', country: 'unknown', countryName: '', asn: '', asName: '', isp: '', org: '',
      alive: null, lastCheckAt: null, exitIp: null, responseTime: null, anonymity: null,
      source: 'manual', tags: tags || [], notes: notes || '',
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
    const updated = {
      ...existing,
      ip: body.ip || existing.ip,
      port: body.port ? parseInt(body.port) : existing.port,
      protocol: body.protocol || existing.protocol,
      username: body.username !== undefined ? body.username : existing.username,
      password: body.password !== undefined ? body.password : existing.password,
      tags: body.tags || existing.tags,
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
      const { proxies } = listProxies({ type: 'unknown' });
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
    res.json(job || { status: 'idle', total: 0, completed: 0, alive: 0, failed: 0 });
  });

  // POST /api/proxies/test — enqueue a durable test job that survives page closes and restarts.
  app.post('/api/proxies/test', (req, res) => {
    const requestedIds = Array.isArray(req.body.ids) && req.body.ids.length ? req.body.ids : null;
    const proxyIds = requestedIds
      ? requestedIds.filter(id => getProxyById(id))
      : getProxyIdsToTest(0);

    if (!proxyIds.length) {
      return res.json({ message: '没有需要检测的代理' });
    }

    const job = createTestJob(generateId(), [...new Set(proxyIds)]);
    processTestQueue();
    res.status(202).json({ message: `已创建检测任务：${job.total} 个代理`, job });
  });

  // POST /api/proxies/:id/test
  app.post('/api/proxies/:id/test', async (req, res) => {

    const proxy = getProxyById(req.params.id);
    if (!proxy) return res.status(404).json({ error: 'Not found' });

    try {
      const result = await testProxies([proxy]);
      if (result.results && result.results[0]) {
        const r = result.results[0];
        proxy.alive = r.alive;
        proxy.exitIp = r.exitIp || null;
        proxy.responseTime = r.responseTime || null;
        proxy.anonymity = r.anonymity || null;
        proxy.lastCheckAt = new Date().toISOString();
        proxy.updatedAt = new Date().toISOString();
        upsertProxy(proxy);
        computeStats();
        return res.json({ proxy: proxyToCamel(proxy) });
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
    ipType: p.ipType || p.ip_type,
    country: p.country,
    countryName: p.countryName || p.country_name,
    asn: p.asn,
    asName: p.asName || p.as_name,
    isp: p.isp,
    org: p.org,
    alive: p.alive,
    exitIp: p.exitIp || p.exit_ip,
    responseTime: p.responseTime || p.response_time,
    anonymity: p.anonymity,
    lastCheckAt: p.lastCheckAt || p.last_check_at,
    lastClassifiedAt: p.lastClassifiedAt || p.last_classified_at,
    source: p.source,
    tags: p.tags,
    notes: p.notes,
    createdAt: p.createdAt || p.created_at,
    updatedAt: p.updatedAt || p.updated_at,
  };
}
