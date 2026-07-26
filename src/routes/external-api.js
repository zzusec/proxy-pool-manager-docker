import { listProxies, countProxies, getRandomProxy } from '../db.js';

export function setupExternalApiRoutes(app) {
  // GET /api/v1/proxies — list with filters (strips sensitive data)
  app.get('/api/v1/proxies', (req, res) => {
    const { type, country, protocol, alive, limit, offset } = req.query;
    const result = listProxies({
      type, country, protocol, alive,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
    });

    // Strip sensitive data for external API
    const proxies = result.proxies.map(p => ({
      id: p.id, ip: p.ip, port: p.port, protocol: p.protocol,
      ipType: p.ipType || p.ip_type, country: p.country, countryName: p.countryName || p.country_name,
      asn: p.asn, asName: p.asName || p.as_name, isp: p.isp,
      alive: p.alive, responseTime: p.responseTime || p.response_time, anonymity: p.anonymity,
      lastCheckAt: p.lastCheckAt || p.last_check_at,
    }));

    res.json({ proxies, total: result.total, limit: parseInt(limit) || 50, offset: parseInt(offset) || 0 });
  });

  // GET /api/v1/proxies/random
  app.get('/api/v1/proxies/random', (req, res) => {
    const { type, country, protocol, alive } = req.query;
    const proxy = getRandomProxy({ type, country, protocol, alive });
    if (!proxy) return res.status(404).json({ error: 'No matching proxy found' });

    res.json({
      id: proxy.id, ip: proxy.ip, port: proxy.port, protocol: proxy.protocol,
      ipType: proxy.ipType || proxy.ip_type, country: proxy.country, countryName: proxy.countryName || proxy.country_name,
      asn: proxy.asn, asName: proxy.asName || proxy.as_name, isp: proxy.isp,
      alive: proxy.alive, responseTime: proxy.responseTime || proxy.response_time, anonymity: proxy.anonymity,
    });
  });

  // GET /api/v1/proxies/count
  app.get('/api/v1/proxies/count', (req, res) => {
    const { type, country, protocol, alive } = req.query;
    const count = countProxies({ type, country, protocol, alive });
    res.json({ count });
  });
}
