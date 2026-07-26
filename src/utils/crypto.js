import crypto from 'crypto';

const SESSION_MAX_AGE = 8 * 60 * 60; // 8 hours
const SESSION_COOKIE = 'proxy_pool_session';

// ─── HMAC Helpers ───────────────────────────────────────────────────────────

function hmacSign(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function secureEqual(actual, expected) {
  // Timing-safe comparison using HMAC signatures
  const key = crypto.randomBytes(32);
  const sigA = crypto.createHmac('sha256', key).update(String(actual)).digest();
  const sigB = crypto.createHmac('sha256', key).update(String(expected)).digest();
  return crypto.timingSafeEqual(sigA, sigB);
}

function hashPassword(password, secret) {
  return hmacSign(secret, password);
}

// ─── Session Management ─────────────────────────────────────────────────────

export function createSessionToken() {
  const secret = process.env.SESSION_SECRET;
  const payload = {
    username: process.env.ADMIN_USERNAME,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
    nonce: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = hmacSign(secret, payloadB64);
  return payloadB64 + '.' + sig;
}

export function verifySessionToken(token) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;

  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const secret = process.env.SESSION_SECRET;
  const expectedSig = hmacSign(secret, payloadB64);

  if (!secureEqual(sigB64, expectedSig)) return false;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (payload.username !== process.env.ADMIN_USERNAME) return false;
    if (payload.expiresAt < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function verifyAdminPassword(password) {
  const secret = process.env.SESSION_SECRET;
  // Check stored hash first
  const { getAdminSettings } = await import('../db.js');
  const adminSettings = getAdminSettings();
  if (adminSettings.passwordHash) {
    const hash = hashPassword(password, secret);
    return secureEqual(hash, adminSettings.passwordHash);
  }
  return secureEqual(password, process.env.ADMIN_PASSWORD);
}

// ─── Cookie Helpers ─────────────────────────────────────────────────────────

export function getCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(name + '=')) return trimmed.slice(name.length + 1);
  }
  return null;
}

export function getSessionFromRequest(req) {
  const cookieHeader = req.headers.cookie || '';
  return getCookie(cookieHeader, SESSION_COOKIE);
}

export function setSessionCookie(token, maxAge = SESSION_MAX_AGE) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=0`;
}

export { SESSION_COOKIE, SESSION_MAX_AGE, hashPassword, secureEqual };
