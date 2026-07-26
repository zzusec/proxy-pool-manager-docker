import { verifySessionToken } from '../utils/crypto.js';

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token || !verifySessionToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}
