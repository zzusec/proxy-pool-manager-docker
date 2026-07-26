import { getAdminSettings } from '../db.js';
import { secureEqual } from '../utils/crypto.js';

export function requireApiKey(req, res, next) {
  const adminSettings = getAdminSettings();
  if (adminSettings.apiEnabled === false) {
    return res.status(503).json({ error: 'External API is disabled' });
  }

  const apiKey = adminSettings.apiKey || process.env.API_KEY;
  if (!apiKey) {
    return res.status(401).json({ error: 'API key not configured' });
  }

  // Check Authorization: Bearer <key>
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const provided = authHeader.slice(7);
    if (secureEqual(provided, apiKey)) return next();
  }

  // Check ?api_key=<key>
  const queryKey = req.query.api_key || req.query.key;
  if (queryKey && secureEqual(queryKey, apiKey)) return next();

  return res.status(401).json({ error: 'Unauthorized' });
}
