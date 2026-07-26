import { verifySessionToken, getSessionFromRequest } from '../utils/crypto.js';

export function requireAuth(req, res, next) {
  const token = getSessionFromRequest(req);
  if (!token || !verifySessionToken(token)) {
    // For API requests, return 401; for page requests, redirect to login
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect(302, '/login');
  }
  next();
}

export function requireAuthOrRedirect(req, res, next) {
  const token = getSessionFromRequest(req);
  if (!token || !verifySessionToken(token)) {
    return res.redirect(302, '/login');
  }
  next();
}
