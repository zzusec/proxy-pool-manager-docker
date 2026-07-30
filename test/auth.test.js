import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-auth-test-'));
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'environment-password';
process.env.SESSION_SECRET = 'test-session-secret-that-is-longer-than-32-characters';
process.env.NODE_ENV = 'test';

const db = await import('../src/db.js');
db.initDb();
const {
  createSessionToken,
  hashAdminPassword,
  hashPassword,
  validateAuthConfiguration,
  verifyAdminPassword,
  verifySessionToken,
} = await import('../src/utils/crypto.js');
const { setupAuthRoutes } = await import('../src/routes/auth.js');
const { setupSettingsRoutes } = await import('../src/routes/settings.js');

function resetAdminSettings() {
  db.setAdminSettings({});
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'environment-password';
  process.env.SESSION_SECRET = 'test-session-secret-that-is-longer-than-32-characters';
  process.env.NODE_ENV = 'test';
}

async function withServer(app, run) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function withLoginServer(run) {
  const app = express();
  setupAuthRoutes(app);
  return withServer(app, run);
}

test('login accepts JSON and URL-encoded requests without caching responses', async () => {
  resetAdminSettings();

  await withLoginServer(async baseUrl => {
    const page = await fetch(`${baseUrl}/login`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');

    const jsonLogin = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'environment-password' }),
    });
    assert.equal(jsonLogin.status, 200);
    assert.equal(jsonLogin.headers.get('cache-control'), 'no-store');
    assert.equal((await jsonLogin.json()).ok, true);

    const formLogin = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'environment-password' }),
    });
    assert.equal(formLogin.status, 200);

    const rejected = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
    });
    assert.equal(rejected.status, 401);
    assert.deepEqual(await rejected.json(), { error: '用户名或密码错误' });
    assert.equal(rejected.headers.get('cache-control'), 'no-store');
  });
});

test('a verified legacy password migrates to a durable scrypt hash', async () => {
  resetAdminSettings();
  const legacyPassword = 'legacy-password';
  const legacyHash = hashPassword(legacyPassword, process.env.SESSION_SECRET);
  db.setAdminSettings({ apiEnabled: false, passwordHash: legacyHash });

  assert.equal(await verifyAdminPassword(legacyPassword), true);
  const adminSettings = db.getAdminSettings();
  assert.match(adminSettings.passwordHash, /^scrypt\$v1\$/);
  assert.equal(adminSettings.apiEnabled, false);

  const token = createSessionToken();
  process.env.SESSION_SECRET = 'rotated-session-secret-that-is-longer-than-32-characters';
  assert.equal(verifySessionToken(token), false);
  assert.equal(await verifyAdminPassword(legacyPassword), true);
});

test('an invalidated legacy hash can recover once with ADMIN_PASSWORD', async () => {
  resetAdminSettings();
  db.setAdminSettings({ passwordHash: hashPassword('old-dashboard-password', 'old-session-secret-that-is-longer-than-32-characters') });
  process.env.ADMIN_PASSWORD = 'recovery-password';

  assert.equal(await verifyAdminPassword('old-dashboard-password'), false);
  assert.equal(await verifyAdminPassword('recovery-password'), true);
  assert.match(db.getAdminSettings().passwordHash, /^scrypt\$v1\$/);
});

test('a durable dashboard password remains authoritative over ADMIN_PASSWORD', async () => {
  resetAdminSettings();
  db.setAdminSettings({ passwordHash: await hashAdminPassword('dashboard-password') });
  process.env.ADMIN_PASSWORD = 'recovery-password';

  assert.equal(await verifyAdminPassword('recovery-password'), false);
  assert.equal(await verifyAdminPassword('dashboard-password'), true);
});

test('changing the dashboard password creates a durable verifier', async () => {
  resetAdminSettings();
  const app = express();
  app.use(express.json());
  setupSettingsRoutes(app);

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/account/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: 'environment-password',
        newPassword: 'dashboard-password',
        confirmPassword: 'dashboard-password',
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  assert.match(db.getAdminSettings().passwordHash, /^scrypt\$v1\$/);
  assert.equal(await verifyAdminPassword('environment-password'), false);
  assert.equal(await verifyAdminPassword('dashboard-password'), true);
});

test('authentication configuration rejects malformed persisted credentials without exposing values', async () => {
  resetAdminSettings();
  db.setSetting('admin', '{not-json');
  await assert.rejects(validateAuthConfiguration(), error => {
    assert.match(error.message, /persisted admin settings cannot be read/);
    assert.doesNotMatch(error.message, /environment-password/);
    return true;
  });

  resetAdminSettings();
  process.env.SESSION_SECRET = 'short';
  await assert.rejects(validateAuthConfiguration(), /SESSION_SECRET must be at least 32 characters/);
});
