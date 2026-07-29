import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { DEFAULT_TEST_TARGETS, LEGACY_TEST_TARGETS } from './utils/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db = null;

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(item => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function initDb() {
  const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'proxy-pool.db');
  db = new Database(dbPath);

  // Performance PRAGMAs
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxies (
      id TEXT PRIMARY KEY,
      ip TEXT NOT NULL,
      port INTEGER NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'http',
      username TEXT DEFAULT '',
      password TEXT DEFAULT '',
      extra TEXT DEFAULT '{}',
      country TEXT DEFAULT 'unknown',
      country_name TEXT DEFAULT '',
      ip_type TEXT DEFAULT 'unknown',
      asn TEXT DEFAULT '',
      as_name TEXT DEFAULT '',
      isp TEXT DEFAULT '',
      org TEXT DEFAULT '',
      alive INTEGER DEFAULT NULL,
      exit_ip TEXT DEFAULT NULL,
      response_time INTEGER DEFAULT NULL,
      anonymity TEXT DEFAULT NULL,
      source TEXT DEFAULT 'manual',
      source_ref TEXT NOT NULL DEFAULT '',
      tags TEXT DEFAULT '[]',
      group_name TEXT NOT NULL DEFAULT '',
      notes TEXT DEFAULT '',
      last_check_at TEXT DEFAULT NULL,
      last_classified_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_proxies_unique ON proxies(ip, port, protocol);
    CREATE INDEX IF NOT EXISTS idx_proxies_country ON proxies(country);
    CREATE INDEX IF NOT EXISTS idx_proxies_ip_type ON proxies(ip_type);
    CREATE INDEX IF NOT EXISTS idx_proxies_protocol ON proxies(protocol);
    CREATE INDEX IF NOT EXISTS idx_proxies_alive ON proxies(alive);
    CREATE INDEX IF NOT EXISTS idx_proxies_last_check ON proxies(last_check_at);

    CREATE TABLE IF NOT EXISTS import_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      total_chunks INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      raw_text TEXT NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'http',
      skip_duplicates INTEGER NOT NULL DEFAULT 1,
      auto_classify INTEGER NOT NULL DEFAULT 1,
      group_name TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'import',
      source_ref TEXT NOT NULL DEFAULT '',
      rss_feed_item_id INTEGER DEFAULT NULL,
      imported INTEGER DEFAULT 0,
      duplicates INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      error_msg TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_import_queue_task ON import_queue(task_id, status);

    CREATE TABLE IF NOT EXISTS import_summary (
      task_id TEXT PRIMARY KEY,
      total_lines INTEGER DEFAULT 0,
      total_chunks INTEGER DEFAULT 1,
      imported INTEGER DEFAULT 0,
      duplicates INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      source_type TEXT NOT NULL DEFAULT 'import',
      source_ref TEXT NOT NULL DEFAULT '',
      rss_feed_item_id INTEGER DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rss_feeds (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      group_name TEXT NOT NULL DEFAULT '',
      protocol TEXT NOT NULL DEFAULT 'http',
      skip_duplicates INTEGER NOT NULL DEFAULT 1,
      auto_classify INTEGER NOT NULL DEFAULT 1,
      poll_interval_minutes INTEGER NOT NULL DEFAULT 60,
      etag TEXT NOT NULL DEFAULT '',
      last_modified TEXT NOT NULL DEFAULT '',
      last_checked_at TEXT DEFAULT NULL,
      last_success_at TEXT DEFAULT NULL,
      last_status TEXT NOT NULL DEFAULT 'idle',
      last_error TEXT NOT NULL DEFAULT '',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_rss_feeds_due ON rss_feeds(enabled, last_checked_at);

    CREATE TABLE IF NOT EXISTS rss_feed_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      item_url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      published_at TEXT DEFAULT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      extracted_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      import_task_id TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(feed_id, item_key),
      FOREIGN KEY (feed_id) REFERENCES rss_feeds(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_rss_feed_items_feed ON rss_feed_items(feed_id, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS test_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      total INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      alive INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      inconclusive INTEGER NOT NULL DEFAULT 0,
      error TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS test_job_items (
      job_id TEXT NOT NULL,
      proxy_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY (job_id, proxy_id),
      FOREIGN KEY (job_id) REFERENCES test_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_test_job_items_status ON test_job_items(job_id, status);

    CREATE TABLE IF NOT EXISTS proxy_inspection_results (
      job_id TEXT NOT NULL,
      proxy_id TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      queried_ip TEXT NOT NULL DEFAULT '',
      observed_ip TEXT NOT NULL DEFAULT '',
      http_status INTEGER DEFAULT NULL,
      normalized_json TEXT NOT NULL DEFAULT '{}',
      response_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (job_id, proxy_id, source),
      FOREIGN KEY (job_id) REFERENCES test_jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_inspection_results_job ON proxy_inspection_results(job_id, proxy_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cron_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'idle',
      last_run_at TEXT DEFAULT NULL,
      last_classify_at TEXT DEFAULT NULL,
      last_test_at TEXT DEFAULT NULL,
      classify_count INTEGER DEFAULT 0,
      test_count INTEGER DEFAULT 0,
      error TEXT DEFAULT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO cron_state (id, status) VALUES (1, 'idle');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('checkInterval', '600');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('autoClassify', 'true');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('autoTestEnabled', 'true');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('classifyBatchSize', '200');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('testBatchSize', '20');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('testConcurrency', '10');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('testTimeout', '10000');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('testTargets', '${JSON.stringify(DEFAULT_TEST_TARGETS)}');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('primaryColor', '#07c160');
  `);

  // Sticky sessions bind one API caller session key to one proxy for a bounded TTL.
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_sessions (
      session_key TEXT PRIMARY KEY,
      proxy_id TEXT NOT NULL,
      filters TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_api_sessions_expires ON api_sessions(expires_at);
  `);

  // Migrate existing installations created before proxy groups were introduced.
  ensureColumn('proxies', 'group_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('proxies', 'source_ref', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('proxies', 'extra', "TEXT DEFAULT '{}'");
  // sticky / rotating classification: rotation_source records whether an operator
  // set it manually or the exit-IP observer inferred it.
  ensureColumn('proxies', 'rotation', "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn('proxies', 'rotation_source', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('proxies', 'exit_ip_history', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('proxies', 'rotation_checked_at', 'TEXT DEFAULT NULL');
  ensureColumn('import_queue', 'group_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('import_queue', 'source_type', "TEXT NOT NULL DEFAULT 'import'");
  ensureColumn('import_queue', 'source_ref', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('import_queue', 'rss_feed_item_id', 'INTEGER DEFAULT NULL');
  ensureColumn('import_summary', 'source_type', "TEXT NOT NULL DEFAULT 'import'");
  ensureColumn('import_summary', 'source_ref', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('import_summary', 'rss_feed_item_id', 'INTEGER DEFAULT NULL');
  ensureColumn('test_jobs', 'inconclusive', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('test_jobs', 'kind', "TEXT NOT NULL DEFAULT 'connectivity'");
  ensureColumn('test_jobs', 'scope', "TEXT NOT NULL DEFAULT 'untested'");
  ensureColumn('test_jobs', 'supported', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('test_jobs', 'unsupported', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('test_jobs', 'testisp_completed', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('test_jobs', 'testisp_success', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('test_jobs', 'testisp_failed', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('test_jobs', 'ispinfo_completed', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('test_jobs', 'ispinfo_success', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('test_jobs', 'ispinfo_failed', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('test_jobs', 'ispinfo_skipped', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('test_jobs', 'started_at', 'TEXT DEFAULT NULL');
  ensureColumn('test_jobs', 'finished_at', 'TEXT DEFAULT NULL');
  ensureColumn('test_job_items', 'protocol', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('test_job_items', 'endpoint_ip', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('test_job_items', 'outcome', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('test_job_items', 'exit_ip', 'TEXT DEFAULT NULL');
  ensureColumn('test_job_items', 'response_time', 'INTEGER DEFAULT NULL');
  ensureColumn('test_job_items', 'message', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('test_job_items', 'started_at', 'TEXT DEFAULT NULL');
  ensureColumn('test_job_items', 'finished_at', 'TEXT DEFAULT NULL');
  ensureColumn('proxies', 'last_test_outcome', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('proxies', 'last_test_error', "TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_proxies_group_name ON proxies(group_name)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_proxies_rotation ON proxies(rotation)');
  // Move installations that never customised the targets onto the HTTPS defaults.
  db.prepare("UPDATE settings SET value = ? WHERE key = 'testTargets' AND value = ?")
    .run(JSON.stringify(DEFAULT_TEST_TARGETS), JSON.stringify(LEGACY_TEST_TARGETS));

  // A container restart can interrupt a background import between its start and completion.
  // Re-queue that chunk safely; the unique proxy index prevents duplicate records.
  db.prepare("UPDATE import_queue SET status = 'pending' WHERE status = 'processing'").run();
  db.prepare("UPDATE test_job_items SET status = 'pending' WHERE status = 'processing'").run();
  db.prepare("UPDATE test_jobs SET status = 'pending' WHERE status = 'running'").run();
  db.prepare("UPDATE rss_feeds SET last_status = 'idle' WHERE last_status = 'fetching'").run();

  console.log(`[DB] Initialized: ${dbPath}`);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

// ─── Proxy DAO ──────────────────────────────────────────────────────────────

function buildProxyFilter({ type, country, protocol, alive, tag, group, search, rotation } = {}) {
  const conditions = [];
  const params = {};

  if (type !== undefined && type !== null && type !== '') { conditions.push('ip_type = @type'); params.type = type; }
  if (rotation !== undefined && rotation !== null && rotation !== '') { conditions.push('rotation = @rotation'); params.rotation = rotation; }
  if (country !== undefined && country !== null && country !== '') { conditions.push('country = @country'); params.country = country; }
  if (group !== undefined && group !== null && group !== '') { conditions.push('group_name = @group'); params.group = group; }
  if (protocol) { conditions.push('protocol = @protocol'); params.protocol = protocol; }
  if (alive !== undefined && alive !== null && alive !== '') {
    if (alive === 'true' || alive === true) conditions.push('alive = 1');
    else if (alive === 'false' || alive === false) conditions.push('alive = 0');
    else if (alive === 'null') conditions.push('alive IS NULL');
  }
  if (tag) {
    conditions.push("EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(tags) THEN tags ELSE '[]' END) WHERE value = @tag)");
    params.tag = tag;
  }
  if (search) {
    conditions.push('(ip LIKE @search OR asn LIKE @search OR isp LIKE @search OR as_name LIKE @search)');
    params.search = `%${search}%`;
  }

  return { where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '', params };
}

function hydrateProxy(proxy) {
  if (!proxy) return proxy;
  proxy.alive = proxy.alive === 1 ? true : proxy.alive === 0 ? false : null;
  try { proxy.tags = JSON.parse(proxy.tags || '[]'); } catch { proxy.tags = []; }
  try { proxy.extra = JSON.parse(proxy.extra || '{}'); } catch { proxy.extra = {}; }
  try { proxy.exit_ip_history = JSON.parse(proxy.exit_ip_history || '[]'); } catch { proxy.exit_ip_history = []; }
  proxy.rotation = proxy.rotation || 'unknown';
  return proxy;
}

export function listProxies({ sort = 'created_at', order = 'desc', limit = 0, offset = 0, ...filters } = {}) {
  const { where, params } = buildProxyFilter(filters);
  const { total } = getDb().prepare(`SELECT COUNT(*) as total FROM proxies ${where}`).get(params);
  const allowedSorts = ['created_at', 'updated_at', 'ip', 'port', 'country', 'ip_type', 'group_name', 'alive', 'response_time', 'last_check_at'];
  const sortCol = allowedSorts.includes(sort) ? sort : 'created_at';
  const sortDir = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  let sql = `SELECT * FROM proxies ${where} ORDER BY ${sortCol} ${sortDir}`;
  if (limit > 0) {
    sql += ' LIMIT @limit OFFSET @offset';
    params.limit = limit;
    params.offset = offset;
  }
  return { proxies: getDb().prepare(sql).all(params).map(hydrateProxy), total };
}

export function getProxyIdsByFilters(filters = {}, limit = 1000) {
  const boundedLimit = Math.max(1, Math.min(parseInt(limit) || 1000, 1000));
  const { where, params } = buildProxyFilter(filters);
  const rows = getDb().prepare(`SELECT id FROM proxies ${where} ORDER BY created_at DESC, id DESC LIMIT @limit`).all({ ...params, limit: boundedLimit + 1 });
  return {
    ids: rows.slice(0, boundedLimit).map(row => row.id),
    truncated: rows.length > boundedLimit,
  };
}

export function getProxyById(id) {
  return hydrateProxy(getDb().prepare('SELECT * FROM proxies WHERE id = ?').get(id));
}

export function upsertProxy(proxy) {
  const p = {
    id: proxy.id,
    ip: proxy.ip,
    port: proxy.port,
    protocol: proxy.protocol || 'http',
    username: proxy.username || '',
    password: proxy.password || '',
    extra: typeof proxy.extra === 'string' ? proxy.extra : JSON.stringify(proxy.extra || {}),
    country: proxy.country || 'unknown',
    country_name: proxy.countryName || proxy.country_name || '',
    ip_type: proxy.ipType || proxy.ip_type || 'unknown',
    asn: proxy.asn || '',
    as_name: proxy.asName || proxy.as_name || '',
    isp: proxy.isp || '',
    org: proxy.org || '',
    alive: proxy.alive === true ? 1 : proxy.alive === false ? 0 : null,
    exit_ip: proxy.exitIp || proxy.exit_ip || null,
    response_time: proxy.responseTime || proxy.response_time || null,
    anonymity: proxy.anonymity || null,
    source: proxy.source || 'manual',
    source_ref: proxy.sourceRef || proxy.source_ref || '',
    tags: JSON.stringify(proxy.tags || []),
    group_name: proxy.group ?? proxy.groupName ?? proxy.group_name ?? '',
    notes: proxy.notes || '',
    rotation: proxy.rotation || 'unknown',
    rotation_source: proxy.rotationSource || proxy.rotation_source || '',
    exit_ip_history: JSON.stringify(proxy.exitIpHistory || proxy.exit_ip_history || []),
    rotation_checked_at: proxy.rotationCheckedAt || proxy.rotation_checked_at || null,
    last_check_at: proxy.lastCheckAt || proxy.last_check_at || null,
    last_test_outcome: proxy.lastTestOutcome || proxy.last_test_outcome || '',
    last_test_error: proxy.lastTestError || proxy.last_test_error || '',
    last_classified_at: proxy.lastClassifiedAt || proxy.last_classified_at || null,
    created_at: proxy.createdAt || proxy.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  getDb().prepare(`
    INSERT OR REPLACE INTO proxies (id, ip, port, protocol, username, password, extra, country, country_name, ip_type, asn, as_name, isp, org, alive, exit_ip, response_time, anonymity, source, source_ref, tags, group_name, notes, rotation, rotation_source, exit_ip_history, rotation_checked_at, last_check_at, last_test_outcome, last_test_error, last_classified_at, created_at, updated_at)
    VALUES (@id, @ip, @port, @protocol, @username, @password, @extra, @country, @country_name, @ip_type, @asn, @as_name, @isp, @org, @alive, @exit_ip, @response_time, @anonymity, @source, @source_ref, @tags, @group_name, @notes, @rotation, @rotation_source, @exit_ip_history, @rotation_checked_at, @last_check_at, @last_test_outcome, @last_test_error, @last_classified_at, @created_at, @updated_at)
  `).run(p);

  return p;
}

export function deleteProxyById(id) {
  return getDb().prepare('DELETE FROM proxies WHERE id = ?').run(id).changes > 0;
}

export function deleteProxiesByIds(ids) {
  const placeholders = ids.map(() => '?').join(',');
  return getDb().prepare(`DELETE FROM proxies WHERE id IN (${placeholders})`).run(...ids).changes;
}

export function countProxies(filters = {}) {
  const { where, params } = buildProxyFilter(filters);
  return getDb().prepare(`SELECT COUNT(*) as total FROM proxies ${where}`).get(params).total;
}

export function getRandomProxy(filters = {}) {
  const { where, params } = buildProxyFilter(filters);
  return hydrateProxy(getDb().prepare(`SELECT * FROM proxies ${where} ORDER BY RANDOM() LIMIT 1`).get(params));
}

// ─── Rotation (sticky / rotating) ───────────────────────────────────────────

export const ROTATION_VALUES = new Set(['sticky', 'rotating', 'unknown']);
const ROTATION_HISTORY_LIMIT = 6;
const ROTATION_MIN_SAMPLES = 3;

/**
 * Remember one observed exit IP and re-infer whether the proxy keeps a stable
 * exit (sticky) or hands out a new IP per request (rotating). A value set by an
 * operator wins: automatic inference never overwrites `rotation_source = manual`.
 */
export function recordExitIpObservation(proxyId, exitIp) {
  if (!exitIp) return null;
  const proxy = getProxyById(proxyId);
  if (!proxy) return null;

  const history = [...(proxy.exit_ip_history || []), String(exitIp)].slice(-ROTATION_HISTORY_LIMIT);
  let rotation = proxy.rotation || 'unknown';
  let rotationSource = proxy.rotation_source || '';

  if (rotationSource !== 'manual' && history.length >= ROTATION_MIN_SAMPLES) {
    const unique = new Set(history);
    rotation = unique.size === 1 ? 'sticky' : 'rotating';
    rotationSource = 'auto';
  }

  getDb().prepare(`
    UPDATE proxies
    SET exit_ip_history = @history, rotation = @rotation, rotation_source = @source,
        rotation_checked_at = datetime('now'), updated_at = datetime('now')
    WHERE id = @id
  `).run({ id: proxyId, history: JSON.stringify(history), rotation, source: rotationSource });

  return { rotation, rotationSource, history };
}

export function setProxyRotation(proxyId, rotation) {
  if (!ROTATION_VALUES.has(rotation)) throw new Error('代理类型无效');
  const source = rotation === 'unknown' ? '' : 'manual';
  return getDb().prepare(`
    UPDATE proxies SET rotation = ?, rotation_source = ?, rotation_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
  `).run(rotation, source, proxyId).changes > 0;
}

// ─── Sticky API sessions ────────────────────────────────────────────────────

export const STICKY_MAX_TTL_SECONDS = 120 * 60; // 120 minutes

export function purgeExpiredSessions() {
  return getDb().prepare("DELETE FROM api_sessions WHERE expires_at <= datetime('now')").run().changes;
}

export function getStickySession(sessionKey) {
  return getDb().prepare("SELECT * FROM api_sessions WHERE session_key = ? AND expires_at > datetime('now')").get(sessionKey) || null;
}

export function saveStickySession(sessionKey, proxyId, filters, ttlSeconds) {
  const ttl = Math.max(1, Math.min(Math.floor(ttlSeconds), STICKY_MAX_TTL_SECONDS));
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  getDb().prepare(`
    INSERT OR REPLACE INTO api_sessions (session_key, proxy_id, filters, created_at, expires_at)
    VALUES (@key, @proxyId, @filters, datetime('now'), @expiresAt)
  `).run({ key: sessionKey, proxyId, filters: JSON.stringify(filters || {}), expiresAt });
  return { sessionKey, proxyId, expiresAt, ttl };
}

export function getProxyGroups() {
  return getDb().prepare(`
    SELECT group_name AS name, COUNT(*) AS count
    FROM proxies
    WHERE group_name != ''
    GROUP BY group_name
    ORDER BY group_name COLLATE NOCASE ASC
  `).all();
}

export function computeStats() {
  const d = getDb();
  const base = d.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN alive = 1 THEN 1 ELSE 0 END) as alive,
      SUM(CASE WHEN alive = 0 THEN 1 ELSE 0 END) as dead,
      SUM(CASE WHEN alive IS NULL THEN 1 ELSE 0 END) as untested
    FROM proxies
  `).get();

  const byType = {};
  for (const row of d.prepare('SELECT ip_type, COUNT(*) as count FROM proxies GROUP BY ip_type').all()) {
    byType[row.ip_type] = row.count;
  }

  const byProtocol = {};
  for (const row of d.prepare('SELECT protocol, COUNT(*) as count FROM proxies GROUP BY protocol').all()) {
    byProtocol[row.protocol] = row.count;
  }

  const byCountry = {};
  for (const row of d.prepare("SELECT country, COUNT(*) as count FROM proxies WHERE country != 'unknown' GROUP BY country").all()) {
    byCountry[row.country] = row.count;
  }

  const cronState = getCronState();

  const stats = {
    total: base.total,
    alive: base.alive || 0,
    dead: base.dead || 0,
    untested: base.untested || 0,
    byType,
    byProtocol,
    byCountry,
    lastCronRun: cronState?.last_run_at || null,
    updatedAt: new Date().toISOString(),
  };

  return stats;
}

// ─── Settings DAO ───────────────────────────────────────────────────────────

export function getSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const row of rows) obj[row.key] = row.value;
  return obj;
}

export function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

export function getAdminSettings() {
  const val = getSetting('admin');
  return val ? JSON.parse(val) : {};
}

export function setAdminSettings(data) {
  setSetting('admin', JSON.stringify(data));
}

// ─── Cron State DAO ─────────────────────────────────────────────────────────

export function getCronState() {
  return getDb().prepare('SELECT * FROM cron_state WHERE id = 1').get();
}

export function setCronState(state) {
  const existing = getCronState();
  const updated = { ...existing, ...state, updated_at: new Date().toISOString() };
  getDb().prepare(`
    UPDATE cron_state SET
      status = @status, last_run_at = @last_run_at, last_classify_at = @last_classify_at,
      last_test_at = @last_test_at, classify_count = @classify_count, test_count = @test_count,
      error = @error, updated_at = @updated_at
    WHERE id = 1
  `).run(updated);
  return updated;
}

// ─── Import Queue DAO ───────────────────────────────────────────────────────

export function enqueueImport(taskId, chunks, metadata = {}) {
  const d = getDb();
  const sourceType = metadata.sourceType || 'import';
  const sourceRef = metadata.sourceRef || '';
  const rssFeedItemId = metadata.rssFeedItemId || null;
  const insertChunk = d.prepare(`
    INSERT INTO import_queue (task_id, chunk_index, total_chunks, raw_text, protocol, skip_duplicates, auto_classify, group_name, source_type, source_ref, rss_feed_item_id)
    VALUES (@taskId, @chunkIndex, @totalChunks, @rawText, @protocol, @skipDuplicates, @autoClassify, @groupName, @sourceType, @sourceRef, @rssFeedItemId)
  `);

  const totalLines = chunks.reduce((sum, c) => sum + c.lineCount, 0);

  const transaction = d.transaction(() => {
    d.prepare(`
      INSERT INTO import_summary (task_id, total_lines, total_chunks, status, source_type, source_ref, rss_feed_item_id)
      VALUES (?, ?, ?, 'pending', ?, ?, ?)
    `).run(taskId, totalLines, chunks.length, sourceType, sourceRef, rssFeedItemId);

    for (const chunk of chunks) {
      insertChunk.run({
        taskId,
        chunkIndex: chunk.index,
        totalChunks: chunks.length,
        rawText: chunk.text,
        protocol: chunk.protocol || 'http',
        skipDuplicates: chunk.skipDuplicates ? 1 : 0,
        autoClassify: chunk.autoClassify ? 1 : 0,
        groupName: chunk.groupName || '',
        sourceType,
        sourceRef,
        rssFeedItemId,
      });
    }
  });

  transaction();
  return { taskId, totalLines, totalChunks: chunks.length };
}

export function getImportTask(taskId) {
  const summary = getDb().prepare('SELECT * FROM import_summary WHERE task_id = ?').get(taskId);
  if (!summary) return null;
  return {
    taskId: summary.task_id,
    imported: summary.imported || 0,
    duplicates: summary.duplicates || 0,
    errors: summary.errors || 0,
    status: summary.status,
  };
}

export function getImportQueue() {
  const d = getDb();
  const summaries = d.prepare('SELECT * FROM import_summary ORDER BY created_at DESC LIMIT 20').all();

  const tasks = summaries.map(s => {
    const chunks = d.prepare('SELECT * FROM import_queue WHERE task_id = ? ORDER BY chunk_index').all(s.task_id);
    const doneChunks = chunks.filter(c => c.status === 'done' || c.status === 'error').length;
    return {
      taskId: s.task_id,
      totalLines: s.total_lines,
      totalChunks: s.total_chunks,
      doneChunks,
      imported: s.imported,
      duplicates: s.duplicates,
      errors: s.errors,
      groupName: chunks[0]?.group_name || '',
      sourceType: s.source_type || chunks[0]?.source_type || 'import',
      sourceRef: s.source_ref || chunks[0]?.source_ref || '',
      rssFeedItemId: s.rss_feed_item_id || chunks[0]?.rss_feed_item_id || null,
      status: chunks.some(c => c.status === 'pending' || c.status === 'processing')
        ? 'processing'
        : chunks.some(c => c.status === 'error') ? 'error' : 'done',
      createdAt: s.created_at,
    };
  });

  const hasPending = d.prepare("SELECT 1 FROM import_queue WHERE status = 'pending' OR status = 'processing' LIMIT 1").get() != null;

  return { tasks, hasPending };
}

export function getNextPendingChunk() {
  return getDb().prepare("SELECT * FROM import_queue WHERE status = 'pending' ORDER BY id ASC LIMIT 1").get();
}

export function getImportTaskState(taskId) {
  const row = getDb().prepare(`
    SELECT
      SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed
    FROM import_queue WHERE task_id = ?
  `).get(taskId);
  return { terminal: (row?.active || 0) === 0, hasErrors: (row?.failed || 0) > 0 };
}

export function isImportTaskTerminal(taskId) {
  return getImportTaskState(taskId).terminal;
}

export function updateImportChunk(id, updates) {
  const sets = [];
  const params = {};
  for (const [key, val] of Object.entries(updates)) {
    sets.push(`${key} = @${key}`);
    params[key] = val;
  }
  params.id = id;
  getDb().prepare(`UPDATE import_queue SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id`).run(params);
}

export function updateImportSummary(taskId, updates) {
  const sets = [];
  const params = {};
  for (const [key, val] of Object.entries(updates)) {
    sets.push(`${key} = @${key}`);
    params[key] = val;
  }
  params.taskId = taskId;
  getDb().prepare(`UPDATE import_summary SET ${sets.join(', ')} WHERE task_id = @taskId`).run(params);
}

// ─── Linux.do RSS DAO ───────────────────────────────────────────────────────

export function listRssFeeds() {
  const d = getDb();
  return d.prepare(`
    SELECT f.*, (
      SELECT COUNT(*) FROM rss_feed_items i WHERE i.feed_id = f.id
    ) AS item_count, (
      SELECT COUNT(*) FROM rss_feed_items i WHERE i.feed_id = f.id AND i.status = 'queued'
    ) AS queued_item_count
    FROM rss_feeds f ORDER BY f.created_at DESC
  `).all().map(rssFeedToCamel);
}

export function getRssFeed(id) {
  const row = getDb().prepare('SELECT * FROM rss_feeds WHERE id = ?').get(id);
  return row ? rssFeedToCamel(row) : null;
}

export function createRssFeed(feed) {
  getDb().prepare(`
    INSERT INTO rss_feeds (id, url, label, enabled, group_name, protocol, skip_duplicates, auto_classify, poll_interval_minutes)
    VALUES (@id, @url, @label, @enabled, @groupName, @protocol, @skipDuplicates, @autoClassify, @pollIntervalMinutes)
  `).run({
    id: feed.id,
    url: feed.url,
    label: feed.label || '',
    enabled: feed.enabled === false ? 0 : 1,
    groupName: feed.groupName || '',
    protocol: feed.protocol || 'http',
    skipDuplicates: feed.skipDuplicates === false ? 0 : 1,
    autoClassify: feed.autoClassify === false ? 0 : 1,
    pollIntervalMinutes: feed.pollIntervalMinutes || 60,
  });
  return getRssFeed(feed.id);
}

export function updateRssFeed(id, updates) {
  const allowed = {
    label: 'label', enabled: 'enabled', groupName: 'group_name', protocol: 'protocol',
    skipDuplicates: 'skip_duplicates', autoClassify: 'auto_classify', pollIntervalMinutes: 'poll_interval_minutes',
  };
  const sets = [];
  const params = { id };
  for (const [key, column] of Object.entries(allowed)) {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    sets.push(`${column} = @${key}`);
    params[key] = updates[key];
  }
  if (!sets.length) return getRssFeed(id);
  sets.push("updated_at = datetime('now')");
  getDb().prepare(`UPDATE rss_feeds SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getRssFeed(id);
}

export function deleteRssFeed(id) {
  return getDb().prepare('DELETE FROM rss_feeds WHERE id = ?').run(id).changes > 0;
}

export function getDueRssFeeds(now = Date.now()) {
  return listRssFeeds().filter(feed => feed.enabled && (
    !feed.lastCheckedAt || now >= new Date(feed.lastCheckedAt).getTime() + feed.pollIntervalMinutes * 60_000 * Math.min(Math.max(1, 2 ** Math.min(feed.consecutiveFailures, 6)), 24)
  ));
}

export function updateRssFeedFetchState(id, updates) {
  const allowed = ['etag', 'last_modified', 'last_checked_at', 'last_success_at', 'last_status', 'last_error', 'consecutive_failures'];
  const sets = [];
  const params = { id };
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    sets.push(`${key} = @${key}`);
    params[key] = updates[key];
  }
  if (!sets.length) return getRssFeed(id);
  sets.push("updated_at = datetime('now')");
  getDb().prepare(`UPDATE rss_feeds SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getRssFeed(id);
}

export function upsertRssFeedItem(item) {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM rss_feed_items WHERE feed_id = ? AND item_key = ?').get(item.feedId, item.itemKey);
  if (!existing) {
    const info = d.prepare(`
      INSERT INTO rss_feed_items (feed_id, item_key, item_url, title, published_at, content_hash, extracted_count, status, import_task_id, error)
      VALUES (@feedId, @itemKey, @itemUrl, @title, @publishedAt, @contentHash, @extractedCount, @status, @importTaskId, @error)
    `).run({
      feedId: item.feedId, itemKey: item.itemKey, itemUrl: item.itemUrl || '', title: item.title || '',
      publishedAt: item.publishedAt || null, contentHash: item.contentHash || '', extractedCount: item.extractedCount || 0,
      status: item.status || 'pending', importTaskId: item.importTaskId || '', error: item.error || '',
    });
    return { ...d.prepare('SELECT * FROM rss_feed_items WHERE id = ?').get(info.lastInsertRowid), isNew: true, changed: true };
  }
  const changed = existing.content_hash !== (item.contentHash || '');
  d.prepare(`
    UPDATE rss_feed_items SET item_url = @itemUrl, title = @title, published_at = @publishedAt,
      last_seen_at = datetime('now')${changed ? ', content_hash = @contentHash, extracted_count = @extractedCount, status = @status, import_task_id = @importTaskId, error = @error' : ''}
    WHERE id = @id
  `).run({
    id: existing.id, itemUrl: item.itemUrl || '', title: item.title || '', publishedAt: item.publishedAt || null,
    contentHash: item.contentHash || '', extractedCount: item.extractedCount || 0, status: item.status || 'pending',
    importTaskId: item.importTaskId || '', error: item.error || '',
  });
  return { ...d.prepare('SELECT * FROM rss_feed_items WHERE id = ?').get(existing.id), isNew: false, changed };
}

export function updateRssFeedItem(id, updates) {
  const allowed = ['extracted_count', 'status', 'import_task_id', 'error'];
  const sets = [];
  const params = { id };
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    sets.push(`${key} = @${key}`);
    params[key] = updates[key];
  }
  if (sets.length) getDb().prepare(`UPDATE rss_feed_items SET ${sets.join(', ')}, last_seen_at = datetime('now') WHERE id = @id`).run(params);
}

export function updateRssFeedItemByTaskId(taskId, status, error = '') {
  getDb().prepare(`
    UPDATE rss_feed_items SET status = ?, error = ?, last_seen_at = datetime('now')
    WHERE import_task_id = ?
  `).run(status, error, taskId);
}

export function listRssFeedItems(feedId, limit = 10) {
  return getDb().prepare('SELECT * FROM rss_feed_items WHERE feed_id = ? ORDER BY last_seen_at DESC LIMIT ?').all(feedId, Math.max(1, Math.min(limit, 50)));
}

function rssFeedToCamel(feed) {
  return {
    id: feed.id, url: feed.url, label: feed.label, enabled: !!feed.enabled, group: feed.group_name || '',
    protocol: feed.protocol, skipDuplicates: !!feed.skip_duplicates, autoClassify: !!feed.auto_classify,
    pollIntervalMinutes: feed.poll_interval_minutes, etag: feed.etag || '', lastModified: feed.last_modified || '',
    lastCheckedAt: feed.last_checked_at, lastSuccessAt: feed.last_success_at, lastStatus: feed.last_status,
    lastError: feed.last_error || '', consecutiveFailures: feed.consecutive_failures || 0,
    itemCount: feed.item_count || 0, queuedItemCount: feed.queued_item_count || 0,
    createdAt: feed.created_at, updatedAt: feed.updated_at,
  };
}

// ─── Persistent Test Queue ─────────────────────────────────────────────────

export function createTestJob(id, proxyIds) {
  const d = getDb();
  const insertJob = d.prepare('INSERT INTO test_jobs (id, total) VALUES (?, ?)');
  const insertItem = d.prepare('INSERT OR IGNORE INTO test_job_items (job_id, proxy_id) VALUES (?, ?)');

  d.transaction(() => {
    insertJob.run(id, proxyIds.length);
    for (const proxyId of proxyIds) insertItem.run(id, proxyId);
  })();

  return getTestJob(id);
}

export function createFullInspectionJob(id) {
  const d = getDb();
  const proxies = d.prepare('SELECT id, ip, protocol FROM proxies ORDER BY created_at DESC, id DESC').all();
  const insertJob = d.prepare(`
    INSERT INTO test_jobs (id, kind, scope, total, supported, unsupported)
    VALUES (?, 'full_inspection', 'all_current', ?, ?, ?)
  `);
  const insertItem = d.prepare(`
    INSERT INTO test_job_items (job_id, proxy_id, protocol, endpoint_ip)
    VALUES (?, ?, ?, ?)
  `);
  const supportedProtocols = new Set(['http', 'https', 'socks5', 'hysteria2', 'hy2', 'vless', 'vmess', 'trojan', 'ss']);
  const supported = proxies.filter(proxy => supportedProtocols.has(proxy.protocol)).length;

  d.transaction(() => {
    insertJob.run(id, proxies.length, supported, proxies.length - supported);
    for (const proxy of proxies) insertItem.run(id, proxy.id, proxy.protocol, proxy.ip);
  })();
  return getTestJob(id);
}

export function getActiveFullInspectionJob() {
  const job = getDb().prepare(`
    SELECT * FROM test_jobs WHERE kind = 'full_inspection' AND status IN ('pending', 'running')
    ORDER BY created_at DESC LIMIT 1
  `).get();
  return job ? testJobToCamel(job) : null;
}

export function getLatestFullInspectionJob() {
  const job = getDb().prepare(`
    SELECT * FROM test_jobs WHERE kind = 'full_inspection' ORDER BY created_at DESC LIMIT 1
  `).get();
  return job ? testJobToCamel(job) : null;
}

export function getTestJob(id) {
  const job = getDb().prepare('SELECT * FROM test_jobs WHERE id = ?').get(id);
  return job ? testJobToCamel(job) : null;
}

export function getLatestTestJob() {
  const job = getDb().prepare(`
    SELECT * FROM test_jobs
    ORDER BY CASE WHEN status IN ('pending', 'running') THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1
  `).get();
  return job ? testJobToCamel(job) : null;
}

export function getNextTestJob() {
  const job = getDb().prepare(`
    SELECT * FROM test_jobs
    WHERE status IN ('pending', 'running')
    ORDER BY created_at ASC
    LIMIT 1
  `).get();
  return job ? testJobToCamel(job) : null;
}

export function claimTestJobItems(jobId, limit = 20) {
  const d = getDb();
  const claim = d.transaction(() => {
    const items = d.prepare(`
      SELECT proxy_id FROM test_job_items
      WHERE job_id = ? AND status = 'pending'
      ORDER BY proxy_id
      LIMIT ?
    `).all(jobId, limit);
    if (items.length) {
      const markProcessing = d.prepare("UPDATE test_job_items SET status = 'processing' WHERE job_id = ? AND proxy_id = ?");
      for (const item of items) markProcessing.run(jobId, item.proxy_id);
    }
    d.prepare("UPDATE test_jobs SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(jobId);
    return items.map(item => item.proxy_id);
  });
  return claim();
}

export function claimFullInspectionItems(jobId, limit = 10) {
  const d = getDb();
  return d.transaction(() => {
    const items = d.prepare(`
      SELECT * FROM test_job_items WHERE job_id = ? AND status = 'pending'
      ORDER BY proxy_id LIMIT ?
    `).all(jobId, limit);
    const mark = d.prepare(`
      UPDATE test_job_items SET status = 'processing', started_at = datetime('now')
      WHERE job_id = ? AND proxy_id = ?
    `);
    for (const item of items) mark.run(jobId, item.proxy_id);
    if (items.length) d.prepare(`
      UPDATE test_jobs SET status = 'running', started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now')
      WHERE id = ?
    `).run(jobId);
    return items;
  })();
}

export function upsertInspectionResult(result) {
  const raw = JSON.stringify(result.response || {}).slice(0, 64 * 1024);
  const normalized = JSON.stringify(result.normalized || {}).slice(0, 16 * 1024);
  getDb().prepare(`
    INSERT INTO proxy_inspection_results (
      job_id, proxy_id, source, status, queried_ip, observed_ip, http_status,
      normalized_json, response_json, error, checked_at, updated_at
    ) VALUES (@jobId, @proxyId, @source, @status, @queriedIp, @observedIp, @httpStatus,
      @normalized, @response, @error, datetime('now'), datetime('now'))
    ON CONFLICT(job_id, proxy_id, source) DO UPDATE SET
      status = excluded.status, queried_ip = excluded.queried_ip, observed_ip = excluded.observed_ip,
      http_status = excluded.http_status, normalized_json = excluded.normalized_json,
      response_json = excluded.response_json, error = excluded.error, checked_at = datetime('now'), updated_at = datetime('now')
  `).run({
    jobId: result.jobId, proxyId: result.proxyId, source: result.source, status: result.status,
    queriedIp: result.queriedIp || '', observedIp: result.observedIp || '', httpStatus: result.httpStatus || null,
    normalized, response: raw, error: String(result.error || '').slice(0, 240),
  });
}

export function completeFullInspectionItems(jobId, results) {
  if (!results.length) return getTestJob(jobId);
  const d = getDb();
  d.transaction(() => {
    const mark = d.prepare(`
      UPDATE test_job_items SET status = 'done', outcome = @outcome, exit_ip = @exitIp,
        response_time = @responseTime, message = @message, finished_at = datetime('now')
      WHERE job_id = @jobId AND proxy_id = @proxyId
    `);
    for (const result of results) {
      mark.run({ jobId, proxyId: result.proxyId, outcome: result.outcome, exitIp: result.exitIp || null,
        responseTime: result.responseTime || null, message: String(result.message || '').slice(0, 240) });
    }
    // `alive_no_exit_ip` is a live proxy whose exit IP the target refused to
    // echo — counting it as inconclusive made healthy proxies look unverifiable.
    const alive = results.filter(result => result.outcome === 'alive' || result.outcome === 'alive_no_exit_ip').length;
    const failed = results.filter(result => result.outcome === 'dead' || result.outcome === 'tunnel_error').length;
    const unsupported = results.filter(result => result.outcome.startsWith('unsupported')).length;
    const inconclusive = results.length - alive - failed - unsupported;
    const testispSuccess = results.filter(result => result.testispStatus === 'success').length;
    const testispFailed = results.filter(result => result.testispStatus && result.testispStatus !== 'success').length;
    const ispinfoSuccess = results.filter(result => result.ispinfoStatus === 'success').length;
    const ispinfoFailed = results.filter(result => result.ispinfoStatus && ['skipped_unsupported', 'skipped_no_live_transport'].includes(result.ispinfoStatus) === false && result.ispinfoStatus !== 'success').length;
    const ispinfoSkipped = results.filter(result => ['skipped_unsupported', 'skipped_no_live_transport'].includes(result.ispinfoStatus)).length;
    d.prepare(`
      UPDATE test_jobs SET completed = completed + ?, alive = alive + ?, failed = failed + ?,
        inconclusive = inconclusive + ?, unsupported = unsupported + ?,
        testisp_completed = testisp_completed + ?, testisp_success = testisp_success + ?, testisp_failed = testisp_failed + ?,
        ispinfo_completed = ispinfo_completed + ?, ispinfo_success = ispinfo_success + ?, ispinfo_failed = ispinfo_failed + ?,
        ispinfo_skipped = ispinfo_skipped + ?, updated_at = datetime('now') WHERE id = ?
    `).run(results.length, alive, failed, inconclusive, unsupported, results.length, testispSuccess, testispFailed,
      results.length, ispinfoSuccess, ispinfoFailed, ispinfoSkipped, jobId);
  })();
  return getTestJob(jobId);
}

export function listFullInspectionItems(jobId, limit = 50, offset = 0) {
  const d = getDb();
  const total = d.prepare('SELECT COUNT(*) AS total FROM test_job_items WHERE job_id = ?').get(jobId).total;
  const items = d.prepare(`
    SELECT item.proxy_id, item.protocol, item.endpoint_ip, item.status, item.outcome, item.exit_ip,
      item.response_time, item.message, item.started_at, item.finished_at,
      proxy_inspection_results.source, proxy_inspection_results.status AS source_status,
      proxy_inspection_results.queried_ip, proxy_inspection_results.observed_ip,
      proxy_inspection_results.http_status, proxy_inspection_results.normalized_json,
      proxy_inspection_results.error AS source_error
    FROM test_job_items item
    LEFT JOIN proxy_inspection_results ON proxy_inspection_results.job_id = item.job_id
      AND proxy_inspection_results.proxy_id = item.proxy_id
    WHERE item.job_id = ? ORDER BY item.proxy_id, proxy_inspection_results.source LIMIT ? OFFSET ?
  `).all(jobId, Math.max(1, Math.min(limit, 200)), Math.max(0, offset));
  const grouped = new Map();
  for (const item of items) {
    if (!grouped.has(item.proxy_id)) grouped.set(item.proxy_id, {
      proxyId: item.proxy_id, protocol: item.protocol, endpointIp: item.endpoint_ip, status: item.status,
      outcome: item.outcome, exitIp: item.exit_ip, responseTime: item.response_time, message: item.message,
      startedAt: item.started_at, finishedAt: item.finished_at, sources: {},
    });
    if (item.source) {
      let normalized = {};
      try { normalized = JSON.parse(item.normalized_json || '{}'); } catch {}
      grouped.get(item.proxy_id).sources[item.source] = {
        status: item.source_status, queriedIp: item.queried_ip, observedIp: item.observed_ip,
        httpStatus: item.http_status, data: normalized, error: item.source_error,
      };
    }
  }
  return { total, items: [...grouped.values()] };
}

export function completeTestJobItems(jobId, results) {
  if (!results.length) return getTestJob(jobId);
  const d = getDb();
  d.transaction(() => {
    const markDone = d.prepare("UPDATE test_job_items SET status = 'done' WHERE job_id = ? AND proxy_id = ?");
    for (const result of results) markDone.run(jobId, result.id);
    const alive = results.filter(result => result.alive === true).length;
    const failed = results.filter(result => result.alive === false).length;
    const inconclusive = results.length - alive - failed;
    d.prepare(`
      UPDATE test_jobs SET
        completed = completed + ?, alive = alive + ?, failed = failed + ?, inconclusive = inconclusive + ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(results.length, alive, failed, inconclusive, jobId);
  })();
  return getTestJob(jobId);
}

export function finalizeTestJob(jobId, error = null) {
  const d = getDb();
  const pending = d.prepare("SELECT 1 FROM test_job_items WHERE job_id = ? AND status IN ('pending', 'processing') LIMIT 1").get(jobId);
  const status = error ? 'error' : pending ? 'running' : 'done';
  d.prepare("UPDATE test_jobs SET status = ?, error = ?, finished_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE finished_at END, updated_at = datetime('now') WHERE id = ?").run(status, error, status, jobId);
  return getTestJob(jobId);
}

function testJobToCamel(job) {
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    alive: job.alive,
    failed: job.failed,
    inconclusive: job.inconclusive || 0,
    kind: job.kind || 'connectivity',
    scope: job.scope || 'untested',
    supported: job.supported || 0,
    unsupported: job.unsupported || 0,
    testispCompleted: job.testisp_completed || 0,
    testispSuccess: job.testisp_success || 0,
    testispFailed: job.testisp_failed || 0,
    ispinfoCompleted: job.ispinfo_completed || 0,
    ispinfoSuccess: job.ispinfo_success || 0,
    ispinfoFailed: job.ispinfo_failed || 0,
    ispinfoSkipped: job.ispinfo_skipped || 0,
    error: job.error,
    startedAt: job.started_at || null,
    finishedAt: job.finished_at || null,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

// ─── Utility ────────────────────────────────────────────────────────────────

export function proxyExists(ip, port, protocol) {
  const row = getDb().prepare('SELECT 1 FROM proxies WHERE ip = ? AND port = ? AND protocol = ?').get(ip, port, protocol);
  return !!row;
}

export function getUnclassifiedProxies(limit = 200) {
  const rows = getDb().prepare("SELECT * FROM proxies WHERE ip_type = 'unknown' OR country = 'unknown' OR country IS NULL ORDER BY created_at DESC LIMIT ?").all(limit);
  for (const p of rows) {
    p.alive = p.alive === 1 ? true : p.alive === 0 ? false : null;
    try { p.tags = JSON.parse(p.tags || '[]'); } catch { p.tags = []; }
  }
  return rows;
}

export function getProxyIdsToTest(intervalSeconds = null, limit = 1000) {
  const boundedLimit = Math.max(1, Math.min(parseInt(limit) || 1000, 1001));
  if (intervalSeconds === null || intervalSeconds === undefined) {
    return getDb().prepare('SELECT id FROM proxies WHERE last_check_at IS NULL ORDER BY created_at ASC LIMIT ?').all(boundedLimit).map(row => row.id);
  }
  const cutoff = new Date(Date.now() - intervalSeconds * 1000).toISOString();
  return getDb().prepare('SELECT id FROM proxies WHERE last_check_at IS NULL OR last_check_at < ? ORDER BY created_at ASC LIMIT ?').all(cutoff, boundedLimit).map(row => row.id);
}

export function getProxiesToTest(intervalSeconds, limit = 50) {
  const cutoff = new Date(Date.now() - intervalSeconds * 1000).toISOString();
  const rows = getDb().prepare('SELECT * FROM proxies WHERE last_check_at IS NULL OR last_check_at < ? ORDER BY last_check_at ASC LIMIT ?').all(cutoff, Math.max(1, Math.min(parseInt(limit) || 50, 1000)));
  for (const p of rows) {
    p.alive = p.alive === 1 ? true : p.alive === 0 ? false : null;
    try { p.tags = JSON.parse(p.tags || '[]'); } catch { p.tags = []; }
  }
  return rows;
}
