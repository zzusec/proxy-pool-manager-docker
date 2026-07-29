import { enqueueImport, getImportQueue, upsertProxy, proxyExists, computeStats } from '../db.js';
import { parseProxyLine, parseClashYaml, generateId, isValidIp, proxyKey, normalizeGroup } from '../utils/helpers.js';
import { batchClassify } from '../services/classifier.js';
import { resolveSubscriptionLinks } from '../services/subscription.js';

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
          const key = proxyKey(cp.ip, cp.port, cp.protocol);
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
          if (!isValidIp(result.ip)) { errors.push({ line: i + 1, text: lines[i].trim(), error: 'Invalid IP' }); continue; }
          if (result.port < 1 || result.port > 65535) { errors.push({ line: i + 1, text: lines[i].trim(), error: 'Invalid port' }); continue; }
          if (!result.protocol) result.protocol = defaultProtocol;
          const key = proxyKey(result.ip, result.port, result.protocol);
          if (seen.has(key)) continue;
          if (skipDups && proxyExists(result.ip, result.port, result.protocol)) continue;
          seen.add(key);
          parsed.push(result);
        }
      }

      // Create proxy objects (limit to 15 for legacy endpoint)
      const toWrite = parsed.slice(0, 15);
      const newProxies = toWrite.map(p => ({
        id: generateId(), ip: p.ip, port: p.port, protocol: p.protocol, username: p.username || '', password: p.password || '',
        extra: p.extra || {},
        ipType: 'unknown', country: 'unknown', countryName: '', asn: '', asName: '', isp: '', org: '',
        alive: null, lastCheckAt: null, exitIp: null, responseTime: null, anonymity: null,
        source: 'import', tags: [], groupName, notes: p.name || '',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }));

      for (const p of newProxies) upsertProxy(p);

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
        imported: newProxies.length,
        duplicates: lines.length - newProxies.length - errors.length,
        errors: errors.slice(0, 20),
        totalLines: lines.length,
        remaining: Math.max(0, parsed.length - 15),
        needsMore: parsed.length > 15,
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

      const { proxyLines, subscriptions } = await resolveSubscriptionLinks(text);
      const lines = proxyLines.filter(l => l.trim());
      if (!lines.length) {
        const failed = subscriptions.filter(item => !item.ok);
        const detail = failed.length
          ? failed.map(item => item.error).join('；')
          : '订阅已读取，但未发现可导入的代理（支持 HTTP/SOCKS5/Hysteria2/VMess/VLESS/Trojan/SS）';
        return res.status(422).json({ error: detail, subscriptions });
      }

      const CHUNK_SIZE = 200;
      const chunks = [];

      for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
        chunks.push({
          index: chunks.length,
          text: lines.slice(i, i + CHUNK_SIZE).join('\n'),
          lineCount: Math.min(CHUNK_SIZE, lines.length - i),
          protocol: protocol || 'http',
          skipDuplicates: skipDuplicates !== false,
          autoClassify: !!autoClassify,
          groupName,
        });
      }

      const taskId = generateId();
      const result = enqueueImport(taskId, chunks);

      // Trigger processing in background
      import('../services/scheduler.js').then(({ processImportQueue }) => processImportQueue());

      res.json({
        ok: true,
        taskId,
        totalLines: result.totalLines,
        totalChunks: result.totalChunks,
        classificationAvailable: true,
        group: groupName,
        subscriptions,
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
