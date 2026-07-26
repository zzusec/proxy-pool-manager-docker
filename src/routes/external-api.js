import { listProxies, countProxies, getRandomProxy } from '../db.js';
import { normalizeGroup } from '../utils/helpers.js';

const VALID_TYPES = new Set(['residential', 'datacenter', 'mobile', 'unknown']);
const VALID_PROTOCOLS = new Set(['http', 'https', 'socks5']);
const VALID_ALIVE = new Set(['true', 'false', 'null']);

function readFilters(query) {
  const filters = {};
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
