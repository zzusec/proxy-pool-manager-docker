import { listProxies, countProxies, getRandomProxy } from '../db.js';

export function setupExternalApiRoutes(app) {
  // GET /api/v1/proxies — list with filters (strips sensitive data)
  app.get('/api/v1/proxies', (req, res) => {
    const { type, country, protocol, alive, limit, offset, format } = req.query;
    const pageSize = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
    const pageOffset = Math.max(parseInt(offset) || 0, 0);
    const result = listProxies({
      type, country, protocol, alive,
      limit: pageSize,
      offset: pageOffset,
    });

    // Plain-text output is convenient for clients that expect one usable proxy per line.
    if (format === 'text') {
      res.type('text/plain').send(result.proxies.map(proxyToUrl).join('\n'));
      return;
    }

    // JSON deliberately omits proxy credentials. Use format=text when credentials are needed.
    const proxies = result.proxies.map(proxyToPublicJson);
    res.json({ proxies, total: result.total, limit: pageSize, offset: pageOffset });
  });

  // GET /api/v1/proxies/random
  app.get('/api/v1/proxies/random', (req, res) => {
    const { type, country, protocol, alive, format } = req.query;
    const proxy = getRandomProxy({ type, country, protocol, alive });
    if (!proxy) return res.status(404).json({ error: 'No matching proxy found' });

    if (format === 'text') {
      res.type('text/plain').send(proxyToUrl(proxy));
      return;
    }

    res.json(proxyToPublicJson(proxy));
  });

  // GET /api/v1/proxies/count
  app.get('/api/v1/proxies/count', (req, res) => {
    const { type, country, protocol, alive } = req.query;
    const count = countProxies({ type, country, protocol, alive });
    res.json({ count });
  });
}

function proxyToPublicJson(proxy) {
  return {
    id: proxy.id, ip: proxy.ip, port: proxy.port, protocol: proxy.protocol,
    ipType: proxy.ipType || proxy.ip_type, country: proxy.country, countryName: proxy.countryName || proxy.country_name,
    asn: proxy.asn, asName: proxy.asName || proxy.as_name, isp: proxy.isp,
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
