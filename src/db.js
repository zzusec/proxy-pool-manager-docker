import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db = null;

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
      tags TEXT DEFAULT '[]',
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS test_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      total INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      alive INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
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
  `);

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

export function listProxies({ type, country, protocol, alive, tag, search, sort = 'created_at', order = 'desc', limit = 0, offset = 0 } = {}) {
  const conditions = [];
  const params = {};

  if (type && type !== 'unknown') { conditions.push('ip_type = @type'); params.type = type; }
  if (country && country !== 'unknown') { conditions.push('country = @country'); params.country = country; }
  if (protocol) { conditions.push('protocol = @protocol'); params.protocol = protocol; }
  if (alive !== undefined && alive !== null && alive !== '') {
    if (alive === 'true' || alive === true) conditions.push('alive = 1');
    else if (alive === 'false' || alive === false) conditions.push('alive = 0');
    else conditions.push('alive IS NULL');
  }
  if (tag) { conditions.push("tags LIKE '%' || @tag || '%'"); params.tag = `"${tag}"`; }
  if (search) {
    conditions.push('(ip LIKE @search OR asn LIKE @search OR isp LIKE @search OR as_name LIKE @search)');
    params.search = `%${search}%`;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  // Count
  const countSql = `SELECT COUNT(*) as total FROM proxies ${where}`;
  const { total } = getDb().prepare(countSql).get(params);

  // Sort
  const allowedSorts = ['created_at', 'updated_at', 'ip', 'port', 'country', 'ip_type', 'alive', 'response_time', 'last_check_at'];
  const sortCol = allowedSorts.includes(sort) ? sort : 'created_at';
  const sortDir = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  // Query
  let sql = `SELECT * FROM proxies ${where} ORDER BY ${sortCol} ${sortDir}`;
  if (limit > 0) sql += ' LIMIT @limit OFFSET @offset';
  if (limit > 0) { params.limit = limit; params.offset = offset; }

  const proxies = getDb().prepare(sql).all(params);

  // Convert alive from integer to boolean/null
  for (const p of proxies) {
    p.alive = p.alive === 1 ? true : p.alive === 0 ? false : null;
    try { p.tags = JSON.parse(p.tags || '[]'); } catch { p.tags = []; }
  }

  return { proxies, total };
}

export function getProxyById(id) {
  const p = getDb().prepare('SELECT * FROM proxies WHERE id = ?').get(id);
  if (!p) return null;
  p.alive = p.alive === 1 ? true : p.alive === 0 ? false : null;
  try { p.tags = JSON.parse(p.tags || '[]'); } catch { p.tags = []; }
  return p;
}

export function upsertProxy(proxy) {
  const p = {
    id: proxy.id,
    ip: proxy.ip,
    port: proxy.port,
    protocol: proxy.protocol || 'http',
    username: proxy.username || '',
    password: proxy.password || '',
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
    tags: JSON.stringify(proxy.tags || []),
    notes: proxy.notes || '',
    last_check_at: proxy.lastCheckAt || proxy.last_check_at || null,
    last_classified_at: proxy.lastClassifiedAt || proxy.last_classified_at || null,
    created_at: proxy.createdAt || proxy.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  getDb().prepare(`
    INSERT OR REPLACE INTO proxies (id, ip, port, protocol, username, password, country, country_name, ip_type, asn, as_name, isp, org, alive, exit_ip, response_time, anonymity, source, tags, notes, last_check_at, last_classified_at, created_at, updated_at)
    VALUES (@id, @ip, @port, @protocol, @username, @password, @country, @country_name, @ip_type, @asn, @as_name, @isp, @org, @alive, @exit_ip, @response_time, @anonymity, @source, @tags, @notes, @last_check_at, @last_classified_at, @created_at, @updated_at)
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

export function countProxies({ type, country, protocol, alive } = {}) {
  const conditions = [];
  const params = [];

  if (type) { conditions.push('ip_type = ?'); params.push(type); }
  if (country) { conditions.push('country = ?'); params.push(country); }
  if (protocol) { conditions.push('protocol = ?'); params.push(protocol); }
  if (alive === 'true' || alive === true) conditions.push('alive = 1');
  else if (alive === 'false' || alive === false) conditions.push('alive = 0');

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { total } = getDb().prepare(`SELECT COUNT(*) as total FROM proxies ${where}`).get(...params);
  return total;
}

export function getRandomProxy({ type, country, protocol, alive } = {}) {
  const conditions = [];
  const params = [];

  if (type) { conditions.push('ip_type = ?'); params.push(type); }
  if (country) { conditions.push('country = ?'); params.push(country); }
  if (protocol) { conditions.push('protocol = ?'); params.push(protocol); }
  if (alive === 'true' || alive === true) conditions.push('alive = 1');

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const p = getDb().prepare(`SELECT * FROM proxies ${where} ORDER BY RANDOM() LIMIT 1`).get(...params);
  if (!p) return null;
  p.alive = p.alive === 1 ? true : p.alive === 0 ? false : null;
  try { p.tags = JSON.parse(p.tags || '[]'); } catch { p.tags = []; }
  return p;
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

export function enqueueImport(taskId, chunks) {
  const d = getDb();
  const insertChunk = d.prepare(`
    INSERT INTO import_queue (task_id, chunk_index, total_chunks, raw_text, protocol, skip_duplicates, auto_classify)
    VALUES (@taskId, @chunkIndex, @totalChunks, @rawText, @protocol, @skipDuplicates, @autoClassify)
  `);

  const totalLines = chunks.reduce((sum, c) => sum + c.lineCount, 0);

  const transaction = d.transaction(() => {
    d.prepare(`
      INSERT INTO import_summary (task_id, total_lines, total_chunks, status)
      VALUES (?, ?, ?, 'pending')
    `).run(taskId, totalLines, chunks.length);

    for (const chunk of chunks) {
      insertChunk.run({
        taskId,
        chunkIndex: chunk.index,
        totalChunks: chunks.length,
        rawText: chunk.text,
        protocol: chunk.protocol || 'http',
        skipDuplicates: chunk.skipDuplicates ? 1 : 0,
        autoClassify: chunk.autoClassify ? 1 : 0,
      });
    }
  });

  transaction();
  return { taskId, totalLines, totalChunks: chunks.length };
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

export function completeTestJobItems(jobId, results) {
  if (!results.length) return getTestJob(jobId);
  const d = getDb();
  d.transaction(() => {
    const markDone = d.prepare("UPDATE test_job_items SET status = 'done' WHERE job_id = ? AND proxy_id = ?");
    for (const result of results) markDone.run(jobId, result.id);
    const alive = results.filter(result => result.alive).length;
    d.prepare(`
      UPDATE test_jobs SET
        completed = completed + ?, alive = alive + ?, failed = failed + ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(results.length, alive, results.length - alive, jobId);
  })();
  return getTestJob(jobId);
}

export function finalizeTestJob(jobId, error = null) {
  const d = getDb();
  const pending = d.prepare("SELECT 1 FROM test_job_items WHERE job_id = ? AND status IN ('pending', 'processing') LIMIT 1").get(jobId);
  const status = error ? 'error' : pending ? 'running' : 'done';
  d.prepare("UPDATE test_jobs SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?").run(status, error, jobId);
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
    error: job.error,
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

export function getProxyIdsToTest(intervalSeconds = null) {
  if (intervalSeconds === null || intervalSeconds === undefined) {
    return getDb().prepare('SELECT id FROM proxies WHERE last_check_at IS NULL ORDER BY created_at ASC').all().map(row => row.id);
  }
  const cutoff = new Date(Date.now() - intervalSeconds * 1000).toISOString();
  return getDb().prepare('SELECT id FROM proxies WHERE last_check_at IS NULL OR last_check_at < ? ORDER BY created_at ASC').all(cutoff).map(row => row.id);
}

export function getProxiesToTest(intervalSeconds) {
  const cutoff = new Date(Date.now() - intervalSeconds * 1000).toISOString();
  const rows = getDb().prepare('SELECT * FROM proxies WHERE last_check_at IS NULL OR last_check_at < ? LIMIT 50').all(cutoff);
  for (const p of rows) {
    p.alive = p.alive === 1 ? true : p.alive === 0 ? false : null;
    try { p.tags = JSON.parse(p.tags || '[]'); } catch { p.tags = []; }
  }
  return rows;
}
