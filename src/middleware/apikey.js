import { secureEqual } from '../utils/crypto.js';

export function requireApiKey(req, res, next) {
  const apiKey = process.env.API_KEY;
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
  const queryKey = req.query.api_key;
  if (queryKey && secureEqual(queryKey, apiKey)) return next();

  return res.status(401).json({ error: 'Unauthorized' });
}
