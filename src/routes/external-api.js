import { randomUUID } from 'node:crypto';
import { listProxies, countProxies, getRandomProxy, getProxyById, getStickySession, saveStickySession, purgeExpiredSessions, ROTATION_VALUES, STICKY_MAX_TTL_SECONDS } from '../db.js';
import { normalizeGroup } from '../utils/helpers.js';

const VALID_TYPES = new Set(['residential', 'datacenter', 'mobile', 'unknown']);
const VALID_PROTOCOLS = new Set(['http', 'https', 'socks5']);
const VALID_ALIVE = new Set(['true', 'false', 'null']);
const STICKY_DEFAULT_TTL_MINUTES = 10;
const STICKY_MAX_TTL_MINUTES = STICKY_MAX_TTL_SECONDS / 60;

function readFilters(rawQuery) {
  const filters = {};
  // An empty value (`?country=`) means "no filter" rather than an invalid one.
  const query = Object.fromEntries(Object.entries(rawQuery).filter(([, value]) => String(value ?? '') !== ''));
  if (query.type !== undefined) {
    if (!VALID_TYPES.has(query.type)) throw new Error('Invalid type');
    filters.type = query.type;
  }
  if (query.country !== undefined) {
    const country = String(query.country).toUpperCase();
    if (country !== 'UNKNOWN' && !/^[A-Z]{2}$/.test(country)) throw new Error('Invalid country');
    filters.country = country === 'UNKNOWN' ? 'unknown' : country;
  }
  if (query.protocol !== undefined) {
    if (!VALID_PROTOCOLS.has(query.protocol)) throw new Error('Invalid protocol');
    filters.protocol = query.protocol;
  }
  if (query.alive !== undefined) {
    if (!VALID_ALIVE.has(String(query.alive))) throw new Error('Invalid alive value');
    filters.alive = String(query.alive);
  }
  if (query.rotation !== undefined) {
    if (!ROTATION_VALUES.has(query.rotation)) throw new Error('Invalid rotation');
    filters.rotation = query.rotation;
  }
  if (query.group !== undefined) filters.group = normalizeGroup(query.group);
  if (query.tag !== undefined) {
    const tag = String(query.tag).trim();
    if (!tag || tag.length > 64) throw new Error('Invalid tag');
    filters.tag = tag;
  }
  return filters;
}

export function setupExternalApiRoutes(app) {
  // GET /api/v1/proxies — list with filters (strips sensitive data)
  app.get('/api/v1/proxies', (req, res) => {
    try {
      const pageSize = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 1000);
      const pageOffset = Math.max(parseInt(req.query.offset) || 0, 0);
      const result = listProxies({ ...readFilters(req.query), limit: pageSize, offset: pageOffset });

      if (req.query.format === 'text') {
        res.type('text/plain').send(result.proxies.map(proxyToUrl).join('\n'));
        return;
      }

      res.json({ proxies: result.proxies.map(proxyToPublicJson), total: result.total, limit: pageSize, offset: pageOffset });
    } catch (error) {
      res.status(400).json({ error: error.message || 'Invalid filter' });
    }
  });

  // GET /api/v1/proxies/random
  app.get('/api/v1/proxies/random', (req, res) => {
    try {
      const proxy = getRandomProxy(readFilters(req.query));
      if (!proxy) return res.status(404).json({ error: 'No matching proxy found' });
      if (req.query.format === 'text') return res.type('text/plain').send(proxyToUrl(proxy));
      res.json(proxyToPublicJson(proxy));
    } catch (error) {
      res.status(400).json({ error: error.message || 'Invalid filter' });
    }
  });

  // GET /api/v1/proxies/sticky — bind one session key to one proxy for up to 120 minutes.
  app.get('/api/v1/proxies/sticky', (req, res) => {
    try {
      const filters = readFilters(req.query);
      const requested = Number.parseFloat(req.query.ttl);
      const ttlMinutes = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, STICKY_MAX_TTL_MINUTES)
        : STICKY_DEFAULT_TTL_MINUTES;
      const sessionKey = String(req.query.session || '').trim().slice(0, 64) || randomUUID();

      purgeExpiredSessions();
      const existing = getStickySession(sessionKey);
      let proxy = existing ? getProxyById(existing.proxy_id) : null;
      let expiresAt = existing?.expires_at || null;

      // Re-bind when the session is new, or its proxy disappeared / went down.
      if (!proxy || proxy.alive === false) {
        proxy = getRandomProxy({ alive: 'true', ...filters });
        if (!proxy) return res.status(404).json({ error: 'No matching proxy found' });
        ({ expiresAt } = saveStickySession(sessionKey, proxy.id, filters, ttlMinutes * 60));
      }

      if (req.query.format === 'text') return res.type('text/plain').send(proxyToUrl(proxy));
      res.json({
        session: sessionKey,
        ttlMinutes,
        maxTtlMinutes: STICKY_MAX_TTL_MINUTES,
        expiresAt,
        proxy: proxyToPublicJson(proxy),
        url: proxyToUrl(proxy),
      });
    } catch (error) {
      res.status(400).json({ error: error.message || 'Invalid filter' });
    }
  });

  // GET /api/v1/proxies/count
  app.get('/api/v1/proxies/count', (req, res) => {
    try {
      res.json({ count: countProxies(readFilters(req.query)) });
    } catch (error) {
      res.status(400).json({ error: error.message || 'Invalid filter' });
    }
  });
}

function proxyToPublicJson(proxy) {
  return {
    id: proxy.id, ip: proxy.ip, port: proxy.port, protocol: proxy.protocol,
    ipType: proxy.ipType || proxy.ip_type, country: proxy.country, countryName: proxy.countryName || proxy.country_name,
    asn: proxy.asn, asName: proxy.asName || proxy.as_name, isp: proxy.isp,
    group: proxy.groupName || proxy.group_name || '', tags: proxy.tags || [],
    rotation: proxy.rotation || 'unknown',
    alive: proxy.alive, responseTime: proxy.responseTime || proxy.response_time, anonymity: proxy.anonymity,
    lastCheckAt: proxy.lastCheckAt || proxy.last_check_at,
  };
}

function proxyToUrl(proxy) {
  const credentials = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  return `${proxy.protocol}://${credentials}${proxy.ip}:${proxy.port}`;
}
