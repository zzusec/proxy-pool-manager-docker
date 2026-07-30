import crypto from 'crypto';

const SESSION_MAX_AGE = 8 * 60 * 60; // 8 hours
const SESSION_COOKIE = 'proxy_pool_session';
const PASSWORD_HASH_PREFIX = 'scrypt$v1';
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

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

// Legacy password hashes were HMACs tied to SESSION_SECRET. Keep this exported
// for validating and migrating existing records only; never use it for new ones.
function hashPassword(password, secret) {
  return hmacSign(secret, password);
}

function parsePasswordHash(value) {
  if (typeof value !== 'string' || !value) return null;
  if (!value.startsWith(`${PASSWORD_HASH_PREFIX}$`)) return null;

  const parts = value.split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== 'v1') return null;
  const [n, r, p] = parts.slice(2, 5).map(Number);
  const [saltB64, derivedKeyB64] = parts.slice(5);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(saltB64) || !/^[A-Za-z0-9_-]+$/.test(derivedKeyB64)) return null;

  try {
    const salt = Buffer.from(saltB64, 'base64url');
    const derivedKey = Buffer.from(derivedKeyB64, 'base64url');
    if (salt.length < 16 || salt.length > 64 || derivedKey.length !== SCRYPT_KEY_LENGTH) return null;
    return { salt, derivedKey };
  } catch {
    return null;
  }
}

function passwordHashType(value) {
  if (!value) return 'environment';
  if (parsePasswordHash(value)) return 'scrypt';
  // A SHA-256 base64url HMAC is always 43 characters. Do not attempt recovery
  // from arbitrary stored values because that could conceal corrupt settings.
  if (/^[A-Za-z0-9_-]{43}$/.test(value)) return 'legacy';
  return 'unsupported';
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAX_MEMORY,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export async function hashAdminPassword(password) {
  if (typeof password !== 'string' || !password) throw new Error('管理员密码不能为空');
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt);
  return `${PASSWORD_HASH_PREFIX}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
}

async function verifyScryptPassword(password, storedHash) {
  const parsed = parsePasswordHash(storedHash);
  if (!parsed || typeof password !== 'string') return false;
  const derivedKey = await scrypt(password, parsed.salt);
  return crypto.timingSafeEqual(derivedKey, parsed.derivedKey);
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
  if (typeof password !== 'string' || !password) return false;

  const { getAdminSettings, setAdminSettings } = await import('../db.js');
  const adminSettings = getAdminSettings();
  const storedHash = adminSettings.passwordHash;
  const type = passwordHashType(storedHash);

  if (type === 'environment') return secureEqual(password, process.env.ADMIN_PASSWORD);
  if (type === 'scrypt') return verifyScryptPassword(password, storedHash);
  if (type === 'unsupported') return false;

  // Legacy HMAC hashes can be upgraded after a normal login. When SESSION_SECRET
  // was rotated before this upgrade, ADMIN_PASSWORD is the local break-glass
  // credential and can establish a new durable verifier exactly once.
  const legacyMatches = secureEqual(hashPassword(password, process.env.SESSION_SECRET), storedHash);
  const recoveryMatches = secureEqual(password, process.env.ADMIN_PASSWORD);
  if (!legacyMatches && !recoveryMatches) return false;

  const passwordHash = await hashAdminPassword(password);
  setAdminSettings({ ...adminSettings, passwordHash });
  return true;
}

export async function validateAuthConfiguration() {
  const username = process.env.ADMIN_USERNAME?.trim();
  if (!username) throw new Error('Authentication configuration invalid: ADMIN_USERNAME is required');

  const sessionSecret = process.env.SESSION_SECRET || '';
  if (sessionSecret.length < 32) throw new Error('Authentication configuration invalid: SESSION_SECRET must be at least 32 characters');

  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (!adminPassword) throw new Error('Authentication configuration invalid: ADMIN_PASSWORD is required');

  if (process.env.NODE_ENV === 'production') {
    if (adminPassword === 'change-me') throw new Error('Authentication configuration invalid: ADMIN_PASSWORD must not use the example value');
    if (sessionSecret === 'please-replace-with-a-random-32plus-char-string') throw new Error('Authentication configuration invalid: SESSION_SECRET must not use the example value');
  }

  const { getAdminSettings } = await import('../db.js');
  let adminSettings;
  try {
    adminSettings = getAdminSettings();
  } catch {
    throw new Error('Authentication configuration invalid: persisted admin settings cannot be read');
  }

  const source = passwordHashType(adminSettings.passwordHash);
  if (source === 'unsupported') throw new Error('Authentication configuration invalid: persisted password hash format is unsupported');
  return { passwordSource: source };
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

export { SESSION_COOKIE, SESSION_MAX_AGE, hashPassword, passwordHashType, secureEqual };
