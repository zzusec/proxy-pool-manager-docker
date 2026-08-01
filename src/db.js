import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { DEFAULT_TEST_TARGETS, LEGACY_TEST_TARGETS, ipToHex, cidrToRange } from './utils/helpers.js';

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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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

    -- ipdata answers survive restarts here. Rows are keyed by the network the
    -- answer describes (asn.route / company.network) so one paid lookup covers
    -- every address in that block; a row with net_start = net_end is a single
    -- address, used when ipdata reported no route.
    CREATE TABLE IF NOT EXISTS ipdata_cache (
      cache_key TEXT PRIMARY KEY,
      family INTEGER NOT NULL DEFAULT 4,
      net_start TEXT NOT NULL DEFAULT '',
      net_end TEXT NOT NULL DEFAULT '',
      cidr TEXT NOT NULL DEFAULT '',
      normalized_json TEXT NOT NULL DEFAULT '{}',
      hits INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ipdata_cache_range ON ipdata_cache(family, net_start, net_end);
    CREATE INDEX IF NOT EXISTS idx_ipdata_cache_expiry ON ipdata_cache(expires_at);

    -- One row per UTC day: how many addresses were actually billed to ipdata,
    -- so the remaining free allowance is visible in the settings page.
    CREATE TABLE IF NOT EXISTS ipdata_usage (
      day TEXT PRIMARY KEY,
      calls INTEGER NOT NULL DEFAULT 0,
      saved_by_cache INTEGER NOT NULL DEFAULT 0,
      saved_by_prefilter INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    INSERT OR IGNORE INTO settings (key, value) VALUES ('autoDeleteDead', 'true');
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
  // Which provider decided residential/datacenter, and the raw evidence behind
  // it (ipdata's asn.type / company.type), so the verdict stays auditable.
  ensureColumn('proxies', 'ip_type_source', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('proxies', 'ip_type_detail', "TEXT NOT NULL DEFAULT ''");
  // ipdata's risk view: how many threat signals fired, the 0-100 trust score
  // and which signals they were, so the table can show it without a re-query.
  ensureColumn('proxies', 'threat_count', 'INTEGER DEFAULT NULL');
  ensureColumn('proxies', 'trust_score', 'INTEGER DEFAULT NULL');
  ensureColumn('proxies', 'threat_flags', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('proxies', 'risk_level', "TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_proxies_trust_score ON proxies(trust_score)');
  ensureColumn('import_queue', 'group_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('import_queue', 'source_type', "TEXT NOT NULL DEFAULT 'import'");
  ensureColumn('import_queue', 'source_ref', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('import_summary', 'source_type', "TEXT NOT NULL DEFAULT 'import'");
  ensureColumn('import_summary', 'source_ref', "TEXT NOT NULL DEFAULT ''");
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
  ensureColumn('test_jobs', 'ipdata_completed', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('test_jobs', 'ipdata_success', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('test_jobs', 'ipdata_failed', 'INTEGER NOT NULL DEFAULT 0');
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
  // Move installations that never customised the targets onto the current
  // defaults; anything an operator edited by hand is left alone.
  const moveTargets = db.prepare("UPDATE settings SET value = ? WHERE key = 'testTargets' AND value = ?");
  for (const legacy of LEGACY_TEST_TARGETS) moveTargets.run(JSON.stringify(DEFAULT_TEST_TARGETS), JSON.stringify(legacy));
  ensureColumn('proxies', 'country_source', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('proxies', 'registered_country', "TEXT NOT NULL DEFAULT ''");

  // A container restart can interrupt a background import between its start and completion.
  // Re-queue that chunk safely; the unique proxy index prevents duplicate records.
  db.prepare("UPDATE import_queue SET status = 'pending' WHERE status = 'processing'").run();
  db.prepare("UPDATE test_job_items SET status = 'pending' WHERE status = 'processing'").run();
  db.prepare("UPDATE test_jobs SET status = 'pending' WHERE status = 'running'").run();

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
  const allowedSorts = ['created_at', 'updated_at', 'ip', 'port', 'country', 'ip_type', 'group_name', 'alive', 'response_time', 'last_check_at', 'trust_score', 'threat_count'];
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

// limit = 0 means "every match" (LIMIT -1 in SQLite), used when a batch test is
// meant to cover the whole filter instead of the first page of it.
export function getProxyIdsByFilters(filters = {}, limit = 1000) {
  const parsed = parseInt(limit);
  const unbounded = parsed === 0;
  const boundedLimit = unbounded ? -1 : Math.max(1, Math.min(parsed || 1000, 200000));
  const { where, params } = buildProxyFilter(filters);
  const rows = getDb().prepare(`SELECT id FROM proxies ${where} ORDER BY created_at DESC, id DESC LIMIT @limit`).all({ ...params, limit: unbounded ? -1 : boundedLimit + 1 });
  if (unbounded) return { ids: rows.map(row => row.id), truncated: false };
  return {
    ids: rows.slice(0, boundedLimit).map(row => row.id),
    truncated: rows.length > boundedLimit,
  };
}

export function getProxyById(id) {
  return hydrateProxy(getDb().prepare('SELECT * FROM proxies WHERE id = ?').get(id));
}

function numberOrNull(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
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
    country_source: proxy.countrySource || proxy.country_source || '',
    registered_country: proxy.registeredCountry || proxy.registered_country || '',
    country_name: proxy.countryName || proxy.country_name || '',
    ip_type: proxy.ipType || proxy.ip_type || 'unknown',
    ip_type_source: proxy.ipTypeSource || proxy.ip_type_source || '',
    ip_type_detail: proxy.ipTypeDetail || proxy.ip_type_detail || '',
    threat_count: numberOrNull(proxy.threatCount ?? proxy.threat_count),
    trust_score: numberOrNull(proxy.trustScore ?? proxy.trust_score),
    threat_flags: Array.isArray(proxy.threatFlags) ? proxy.threatFlags.join(',') : (proxy.threatFlags || proxy.threat_flags || ''),
    risk_level: proxy.riskLevel || proxy.risk_level || '',
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
    INSERT OR REPLACE INTO proxies (id, ip, port, protocol, username, password, extra, country, country_source, registered_country, country_name, ip_type, ip_type_source, ip_type_detail, threat_count, trust_score, threat_flags, risk_level, asn, as_name, isp, org, alive, exit_ip, response_time, anonymity, source, source_ref, tags, group_name, notes, rotation, rotation_source, exit_ip_history, rotation_checked_at, last_check_at, last_test_outcome, last_test_error, last_classified_at, created_at, updated_at)
    VALUES (@id, @ip, @port, @protocol, @username, @password, @extra, @country, @country_source, @registered_country, @country_name, @ip_type, @ip_type_source, @ip_type_detail, @threat_count, @trust_score, @threat_flags, @risk_level, @asn, @as_name, @isp, @org, @alive, @exit_ip, @response_time, @anonymity, @source, @source_ref, @tags, @group_name, @notes, @rotation, @rotation_source, @exit_ip_history, @rotation_checked_at, @last_check_at, @last_test_outcome, @last_test_error, @last_classified_at, @created_at, @updated_at)
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

/**
 * Delete every proxy matching a filter, not just the current page. A filter is
 * mandatory: an empty one would silently wipe the whole pool.
 */
export function deleteProxiesByFilters(filters = {}) {
  const { where, params } = buildProxyFilter(filters);
  if (!where) throw new Error('必须指定筛选条件');
  return getDb().prepare(`DELETE FROM proxies ${where}`).run(params).changes;
}

/** Proxies whose country was never observed through the proxy itself. */
export function getProxiesWithoutObservedCountry(limit = 2000) {
  return getDb().prepare(`
    SELECT id, ip, country, country_source FROM proxies
    WHERE country_source != 'observed'
    ORDER BY CASE WHEN country = 'unknown' THEN 0 ELSE 1 END, updated_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(limit, 20000))).map(hydrateProxy);
}

export function setProxyCountry(id, { countryCode, countryName, registeredCountry, source }) {
  return getDb().prepare(`
    UPDATE proxies SET country = @country, country_name = @countryName,
      registered_country = @registered, country_source = @source, updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id, country: countryCode, countryName: countryName || '',
    registered: registeredCountry || '', source: source || 'geolite',
  }).changes > 0;
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
  const insertChunk = d.prepare(`
    INSERT INTO import_queue (task_id, chunk_index, total_chunks, raw_text, protocol, skip_duplicates, auto_classify, group_name, source_type, source_ref)
    VALUES (@taskId, @chunkIndex, @totalChunks, @rawText, @protocol, @skipDuplicates, @autoClassify, @groupName, @sourceType, @sourceRef)
  `);

  const totalLines = chunks.reduce((sum, c) => sum + c.lineCount, 0);

  const transaction = d.transaction(() => {
    d.prepare(`
      INSERT INTO import_summary (task_id, total_lines, total_chunks, status, source_type, source_ref)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(taskId, totalLines, chunks.length, sourceType, sourceRef);

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

// ─── Persistent Test Queue ─────────────────────────────────────────────────

export function createTestJob(id, proxyIds, scope = 'untested') {
  const d = getDb();
  const insertJob = d.prepare('INSERT INTO test_jobs (id, total, scope) VALUES (?, ?, ?)');
  const insertItem = d.prepare('INSERT OR IGNORE INTO test_job_items (job_id, proxy_id) VALUES (?, ?)');

  d.transaction(() => {
    insertJob.run(id, proxyIds.length, scope);
    for (const proxyId of proxyIds) insertItem.run(id, proxyId);
  })();

  return getTestJob(id);
}

/**
 * Stop a running batch: pending items are dropped and the job is parked in a
 * terminal state. Items already handed to the tester finish on their own, so
 * their results are still written; the queue simply never claims more.
 */
export function cancelTestJob(jobId) {
  const d = getDb();
  const job = d.prepare("SELECT * FROM test_jobs WHERE id = ?").get(jobId);
  if (!job) return null;
  if (!['pending', 'running'].includes(job.status)) return testJobToCamel(job);
  d.transaction(() => {
    d.prepare("UPDATE test_job_items SET status = 'canceled' WHERE job_id = ? AND status = 'pending'").run(jobId);
    d.prepare("UPDATE test_jobs SET status = 'canceled', finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(jobId);
  })();
  return getTestJob(jobId);
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
      // Only a job that actually got work moves to running, so a canceled or
      // drained job is never dragged back out of its terminal state.
      d.prepare("UPDATE test_jobs SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status IN ('pending', 'running')").run(jobId);
    }
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
    const ipdataSuccess = results.filter(result => result.ipdataStatus === 'success').length;
    const ipdataFailed = results.filter(result => result.ipdataStatus && result.ipdataStatus !== 'success' && !result.ipdataStatus.startsWith('skipped')).length;
    d.prepare(`
      UPDATE test_jobs SET completed = completed + ?, alive = alive + ?, failed = failed + ?,
        inconclusive = inconclusive + ?, unsupported = unsupported + ?,
        testisp_completed = testisp_completed + ?, testisp_success = testisp_success + ?, testisp_failed = testisp_failed + ?,
        ispinfo_completed = ispinfo_completed + ?, ispinfo_success = ispinfo_success + ?, ispinfo_failed = ispinfo_failed + ?,
        ispinfo_skipped = ispinfo_skipped + ?,
        ipdata_completed = ipdata_completed + ?, ipdata_success = ipdata_success + ?, ipdata_failed = ipdata_failed + ?,
        updated_at = datetime('now') WHERE id = ?
    `).run(results.length, alive, failed, inconclusive, unsupported, results.length, testispSuccess, testispFailed,
      results.length, ispinfoSuccess, ispinfoFailed, ispinfoSkipped,
      results.length, ipdataSuccess, ipdataFailed, jobId);
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
  // A canceled job stays canceled even when its last in-flight batch reports back.
  const current = d.prepare('SELECT status FROM test_jobs WHERE id = ?').get(jobId);
  if (current?.status === 'canceled') return getTestJob(jobId);
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
    ipdataCompleted: job.ipdata_completed || 0,
    ipdataSuccess: job.ipdata_success || 0,
    ipdataFailed: job.ipdata_failed || 0,
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

// limit = 0 means "every match": SQLite reads LIMIT -1 as unbounded, which is
// how the dashboard queues all untested proxies in one durable job.
export function getProxyIdsToTest(intervalSeconds = null, limit = 1000) {
  const parsed = parseInt(limit);
  const boundedLimit = parsed === 0 ? -1 : Math.max(1, Math.min(parsed || 1000, 200000));
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

// ─── ipdata cache & quota accounting ────────────────────────────────────────

/**
 * Find a cached verdict covering this address. Exact rows and network rows live
 * in the same table, and the narrowest match wins so a /32 correction always
 * beats the /24 it sits inside.
 */
export function lookupIpdataCache(ip) {
  const hex = ipToHex(ip);
  if (!hex) return null;
  const family = hex.length === 8 ? 4 : 6;
  const row = getDb().prepare(`
    SELECT * FROM ipdata_cache
    WHERE family = ? AND net_start <= ? AND net_end >= ? AND expires_at > datetime('now')
    ORDER BY net_start DESC, net_end ASC
    LIMIT 1
  `).get(family, hex, hex);
  if (!row) return null;
  getDb().prepare('UPDATE ipdata_cache SET hits = hits + 1 WHERE cache_key = ?').run(row.cache_key);
  try {
    return { normalized: JSON.parse(row.normalized_json), cidr: row.cidr, fetchedAt: row.fetched_at };
  } catch {
    return null;
  }
}

/**
 * Store one answer. When ipdata reported the owning network, the whole block is
 * cached — that is what makes a single lookup cover a neighbourhood of proxies.
 */
export function putIpdataCache(ip, normalized, ttlDays = 30) {
  const ttl = Math.max(1, Math.min(Number(ttlDays) || 30, 365));
  const network = normalized?.route ? cidrToRange(normalized.route) : null;
  const hex = ipToHex(ip);
  if (!network && !hex) return null;

  const family = network ? network.family : (hex.length === 8 ? 4 : 6);
  const start = network ? network.start : hex;
  const end = network ? network.end : hex;
  const cidr = network ? network.cidr : String(ip);
  getDb().prepare(`
    INSERT INTO ipdata_cache (cache_key, family, net_start, net_end, cidr, normalized_json, hits, fetched_at, expires_at)
    VALUES (@key, @family, @start, @end, @cidr, @normalized, 0, datetime('now'), datetime('now', @ttl))
    ON CONFLICT(cache_key) DO UPDATE SET
      normalized_json = excluded.normalized_json, net_start = excluded.net_start, net_end = excluded.net_end,
      cidr = excluded.cidr, fetched_at = datetime('now'), expires_at = excluded.expires_at
  `).run({
    key: `${family}:${start}-${end}`, family, start, end, cidr,
    normalized: JSON.stringify(normalized || {}), ttl: `+${ttl} days`,
  });
  return cidr;
}

export function clearIpdataCacheRows() {
  return getDb().prepare('DELETE FROM ipdata_cache').run().changes;
}

export function pruneIpdataCache() {
  return getDb().prepare("DELETE FROM ipdata_cache WHERE expires_at <= datetime('now')").run().changes;
}

export function getIpdataCacheStats() {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS entries,
      SUM(CASE WHEN net_start != net_end THEN 1 ELSE 0 END) AS networks,
      COALESCE(SUM(hits), 0) AS hits
    FROM ipdata_cache WHERE expires_at > datetime('now')
  `).get();
  return { entries: row?.entries || 0, networks: row?.networks || 0, hits: row?.hits || 0 };
}

/** Bill lookups against the current UTC day — ipdata resets quotas at UTC midnight. */
export function recordIpdataUsage({ calls = 0, savedByCache = 0, savedByPrefilter = 0 } = {}) {
  if (!calls && !savedByCache && !savedByPrefilter) return;
  const day = new Date().toISOString().slice(0, 10);
  getDb().prepare(`
    INSERT INTO ipdata_usage (day, calls, saved_by_cache, saved_by_prefilter, updated_at)
    VALUES (@day, @calls, @cache, @prefilter, datetime('now'))
    ON CONFLICT(day) DO UPDATE SET
      calls = calls + excluded.calls, saved_by_cache = saved_by_cache + excluded.saved_by_cache,
      saved_by_prefilter = saved_by_prefilter + excluded.saved_by_prefilter, updated_at = datetime('now')
  `).run({ day, calls, cache: savedByCache, prefilter: savedByPrefilter });
}

export function getIpdataUsage() {
  const day = new Date().toISOString().slice(0, 10);
  const today = getDb().prepare('SELECT * FROM ipdata_usage WHERE day = ?').get(day);
  const total = getDb().prepare('SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(saved_by_cache), 0) AS cache, COALESCE(SUM(saved_by_prefilter), 0) AS prefilter FROM ipdata_usage').get();
  return {
    day,
    calls: today?.calls || 0,
    savedByCache: today?.saved_by_cache || 0,
    savedByPrefilter: today?.saved_by_prefilter || 0,
    lifetimeCalls: total?.calls || 0,
    lifetimeSavedByCache: total?.cache || 0,
    lifetimeSavedByPrefilter: total?.prefilter || 0,
  };
}
