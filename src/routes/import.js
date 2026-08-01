import { enqueueImport, getImportQueue, upsertProxy, proxyExists, computeStats, createProxyAndEnqueue } from '../db.js';
import { parseProxyLine, parseClashYaml, generateId, isValidIp, proxyKey, normalizeGroup } from '../utils/helpers.js';

const NODE_PROTOCOLS = new Set(['hysteria2', 'hy2', 'vless', 'vmess', 'trojan', 'ss']);
import { batchClassify } from '../services/classifier.js';
import { wakeConnectivityWorker } from '../services/connectivity.js';

export function setupImportRoutes(app) {
  // POST /api/proxies/import — legacy direct import (small batches)
  app.post('/api/proxies/import', (req, res) => {

    try {
      const { text, protocol, skipDuplicates, autoClassify, group } = req.body;
      let groupName;
      try { groupName = normalizeGroup(group); }
      catch (error) { return res.status(400).json({ error: error.message }); }
      const defaultProtocol = protocol || 'http';
      const skipDups = skipDuplicates !== false;

      const lines = (text || '').split(/\r?\n/);
      const parsed = [];
      const errors = [];
      const seen = new Set();

      // Check if Clash YAML
      const isClashYaml = text && text.includes('proxies:') && /\btype:\s*['"]?(ss|ssr|vmess|vless|trojan|hysteria|hysteria2|tuic|wireguard)['"]?/i.test(text);

      if (isClashYaml) {
        const clashProxies = parseClashYaml(text);
        for (const cp of clashProxies) {
          if (!cp.ip || !cp.port) continue;
          const key = proxyKey(cp);
          if (seen.has(key)) continue;
          if (skipDups && proxyExists(cp.ip, cp.port, cp.protocol)) continue;
          seen.add(key);
          parsed.push(cp);
        }
      } else {
        for (let i = 0; i < lines.length; i++) {
          const result = parseProxyLine(lines[i]);
          if (!result) {
            if (lines[i].trim()) errors.push({ line: i + 1, text: lines[i].trim(), error: 'Unrecognized format' });
            continue;
          }
          // Node protocols legitimately use a hostname; only transport proxies
          // must be dialled by literal address.
          const hostOk = NODE_PROTOCOLS.has(result.protocol) ? Boolean(result.ip) : isValidIp(result.ip);
          if (!hostOk) { errors.push({ line: i + 1, text: lines[i].trim(), error: 'Invalid host' }); continue; }
          if (result.port < 1 || result.port > 65535) { errors.push({ line: i + 1, text: lines[i].trim(), error: 'Invalid port' }); continue; }
          if (!result.protocol) result.protocol = defaultProtocol;
          const key = proxyKey(result);
          if (seen.has(key)) continue;
          if (skipDups && proxyExists(result.ip, result.port, result.protocol)) continue;
          seen.add(key);
          parsed.push(result);
        }
      }

      // Keep the legacy endpoint complete as well: every accepted line is stored
      // and enrolled instead of silently dropping everything after the first 15.
      const newProxies = parsed.map(p => ({
        id: generateId(), ip: p.ip, port: p.port, protocol: p.protocol, username: p.username || '', password: p.password || '',
        extra: p.extra || {},
        ipType: 'unknown', country: 'unknown', countryName: '', asn: '', asName: '', isp: '', org: '',
        alive: null, lastCheckAt: null, exitIp: null, responseTime: null, anonymity: null,
        source: 'import', tags: [], groupName, notes: p.name || '',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }));

      let imported = 0;
      for (const p of newProxies) {
        const saved = createProxyAndEnqueue(p, 'legacy_import');
        if (saved.inserted) imported++;
      }
      if (imported > 0) wakeConnectivityWorker();

      // Auto-classify in background
      if (autoClassify && process.env.IPINFO_TOKEN) {
        (async () => {
          try {
            const classified = await batchClassify(newProxies);
            for (const p of classified) upsertProxy(p);
            computeStats();
          } catch (e) { console.error('[import-classify] Error:', e.message); }
        })();
      } else {
        computeStats();
      }

      res.json({
        imported,
        duplicates: lines.length - imported - errors.length,
        errors: errors.slice(0, 20),
        totalLines: lines.length,
        remaining: 0,
        needsMore: false,
      });
    } catch (e) {
      res.status(500).json({ error: '导入失败: ' + (e.message || '内部错误') });
    }
  });

  // POST /api/import/queue — enqueue bulk import
  app.post('/api/import/queue', async (req, res) => {

    try {
      const { text, protocol, skipDuplicates, autoClassify, group } = req.body;
      if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided' });
      let groupName;
      try { groupName = normalizeGroup(group); }
      catch (error) { return res.status(400).json({ error: error.message }); }

      const taskId = generateId();
      const submittedLines = text.split(/\r?\n/).filter(line => line.trim()).length;
      const result = enqueueImport(taskId, [{
        index: 0,
        text,
        lineCount: submittedLines,
        workType: 'resolve_input',
        protocol: protocol || 'http',
        skipDuplicates: skipDuplicates !== false,
        autoClassify: !!autoClassify,
        groupName,
      }]);

      // Parsing, Base64/Clash decoding and subscription downloads happen after
      // the 202 response so a slow provider cannot turn this request into a 502.
      import('../services/scheduler.js').then(({ processImportQueue }) => processImportQueue());

      res.status(202).json({
        ok: true,
        taskId,
        totalLines: result.totalLines,
        totalChunks: result.totalChunks,
        classificationAvailable: true,
        group: groupName,
        subscriptions: [],
        message: '导入任务已提交，服务器正在后台解析代理和订阅',
      });
    } catch (e) {
      res.status(500).json({ error: '提交失败: ' + (e.message || '内部错误') });
    }
  });

  // GET /api/import/queue
  app.get('/api/import/queue', (req, res) => {
    const data = getImportQueue();
    // Convert to camelCase
    const tasks = data.tasks.map(t => ({
      taskId: t.taskId,
      totalLines: t.totalLines,
      totalChunks: t.totalChunks,
      doneChunks: t.doneChunks,
      imported: t.imported,
      duplicates: t.duplicates,
      errors: t.errors,
      group: t.groupName || '',
      sourceType: t.sourceType || 'import',
      sourceRef: t.sourceRef || '',
      status: t.status,
      createdAt: t.createdAt,
    }));
    res.json({ tasks, hasPending: data.hasPending });
  });
}
