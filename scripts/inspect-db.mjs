// Read-only schema/data inspection, run inside the container after deploy.
import Database from 'better-sqlite3';

const db = new Database('/app/data/proxy-pool.db', { readonly: true });
const cols = table => db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
const count = table => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name);
console.log('tables:', tables.join(', '));

for (const table of ['rss_feeds', 'rss_feed_items']) {
  console.log(`${table}:`, tables.includes(table) ? cols(table).join(',') : 'MISSING');
}
console.log('proxies.source_ref present:', cols('proxies').includes('source_ref'));
console.log('import_queue new columns:', ['source_type', 'source_ref', 'rss_feed_item_id'].filter(c => cols('import_queue').includes(c)).join(',') || 'NONE');
console.log('import_summary new columns:', ['source_type', 'source_ref'].filter(c => cols('import_summary').includes(c)).join(',') || 'NONE');

console.log('counts:', ['proxies', 'import_summary', 'import_queue', 'test_jobs', 'test_job_items', 'rss_feeds', 'rss_feed_items']
  .map(t => `${t}=${tables.includes(t) ? count(t) : 'n/a'}`).join(' '));

const alive = db.prepare("SELECT CASE WHEN alive IS NULL THEN 'untested' WHEN alive = 1 THEN 'alive' ELSE 'failed' END AS bucket, COUNT(*) AS c FROM proxies GROUP BY bucket").all();
console.log('alive buckets:', alive.map(r => `${r.bucket}=${r.c}`).join(' '));

console.log('source buckets:', db.prepare('SELECT source, COUNT(*) AS c FROM proxies GROUP BY source ORDER BY c DESC').all()
  .map(r => `${r.source || '(null)'}=${r.c}`).join(' '));

const rss = db.prepare("SELECT protocol, ip, port, source_ref, created_at FROM proxies WHERE source LIKE 'rss:%' ORDER BY created_at DESC LIMIT 5").all();
console.log('recent rss proxies:', rss.length ? JSON.stringify(rss) : 'none yet');

if (tables.includes('rss_feed_items')) {
  console.log('rss item statuses:', db.prepare('SELECT status, COUNT(*) AS c FROM rss_feed_items GROUP BY status').all()
    .map(r => `${r.status}=${r.c}`).join(' ') || 'none yet');
}

console.log('recent import history:', JSON.stringify(db.prepare('SELECT task_id, source_type, source_ref, total_lines, imported, duplicates, errors, status FROM import_summary ORDER BY created_at DESC LIMIT 3').all()));
