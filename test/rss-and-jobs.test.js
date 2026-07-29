import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-test-'));
const db = await import('../src/db.js');
const {
  addLinuxDoRssFeed,
  extractProxyLinesFromRssContent,
  normalizeLinuxDoRssUrl,
  toLinuxDoRssUrl,
  parseRssItems,
  validateLinuxDoRssUrl,
} = await import('../src/services/rss.js');
const { processImportQueue } = await import('../src/services/scheduler.js');

db.initDb();

function proxy(id, alive = false) {
  const seq = Number(id.slice(1));
  return {
    id, ip: `11.${Math.floor(seq / 250)}.${seq % 250}.1`, port: 8000 + (seq % 1000),
    protocol: 'http', alive, source: 'test', tags: [], createdAt: new Date(2025, 0, 1, 0, 0, seq % 60).toISOString(),
  };
}

test('filtered durable selection snapshots at most 1000 failed proxies', () => {
  for (let index = 0; index < 1001; index++) db.upsertProxy(proxy(`p${index}`));
  const selected = db.getProxyIdsByFilters({ alive: 'false' }, 1000);
  assert.equal(selected.ids.length, 1000);
  assert.equal(selected.truncated, true);
  const job = db.createTestJob('snapshot-job', selected.ids);
  assert.equal(job.total, 1000);
  db.upsertProxy({ ...proxy(selected.ids[0], true), id: selected.ids[0] });
  assert.equal(db.getTestJob('snapshot-job').total, 1000);
});

test('untested batch selection stays bounded and reports overflow', () => {
  const ids = db.getProxyIdsToTest(null, 1001);
  assert.equal(ids.length, 1001);
  assert.equal(new Set(ids).size, 1001);
  assert.equal(db.getProxyIdsToTest(null, 5000).length, 1001);
});

test('filtered selection honours protocol and search filters across pages', () => {
  db.upsertProxy({ id: 'socks-1', ip: '9.9.9.9', port: 1080, protocol: 'socks5', alive: false, source: 'test', tags: [] });
  const socks = db.getProxyIdsByFilters({ protocol: 'socks5', alive: 'false' }, 1000);
  assert.deepEqual(socks.ids, ['socks-1']);
  assert.equal(socks.truncated, false);
  assert.deepEqual(db.getProxyIdsByFilters({ search: '9.9.9.9' }, 1000).ids, ['socks-1']);
  assert.deepEqual(db.getProxyIdsByFilters({ alive: 'true' }, 1000).ids.length, 1);
});

test('RSS extraction accepts code blocks and rejects invalid candidates', () => {
  const lines = extractProxyLinesFromRssContent('<p>ignore 999.9.9.9:80</p><pre>http://1.2.3.4:8080\nhttps://user:pass@5.6.7.8:443</pre><code>http://1.2.3.4:8080</code>');
  assert.deepEqual(lines, ['http://1.2.3.4:8080', 'https://user:pass@5.6.7.8:443']);
});

test('RSS extraction keeps bare ip:port lines and applies the feed default protocol', () => {
  assert.deepEqual(extractProxyLinesFromRssContent('<pre>1.2.3.4:8080\n- 5.6.7.8:1080\n2. 9.8.7.6:3128</pre>', 'socks5'), [
    'socks5://1.2.3.4:8080',
    'socks5://5.6.7.8:1080',
    'socks5://9.8.7.6:3128',
  ]);
  assert.deepEqual(extractProxyLinesFromRssContent('<pre>http://1.2.3.4:8080</pre>', 'socks5'), ['http://1.2.3.4:8080']);
});

test('RSS extraction ignores script content and invalid ports', () => {
  const lines = extractProxyLinesFromRssContent('<script>var a="1.2.3.4:8080";</script><style>x{y:"2.3.4.5:80"}</style><p>6.7.8.9:70000</p><p>7.8.9.10:0</p><p>7.8.9.10:3128</p>');
  assert.deepEqual(lines, ['http://7.8.9.10:3128']);
});

test('RSS extraction drops loopback and LAN addresses found in forum prose', () => {
  // Real linux.do wording; importing this would point the tester at our own host.
  assert.deepEqual(extractProxyLinesFromRssContent('你只需要配置好proxy为127.0.0.1:8999.剩下的就是在他的lpm工具上'), []);
  assert.deepEqual(extractProxyLinesFromRssContent('<p>把 proxy 填 192.168.1.10:7890 就行了</p>'), []);
  assert.deepEqual(
    extractProxyLinesFromRssContent('<pre>127.0.0.1:1080\n10.0.0.5:8080\n172.16.9.9:3128\n169.254.1.1:8080\n203.0.113.9:8080</pre>'),
    ['http://203.0.113.9:8080'],
  );
});

test('RSS URL policy accepts the documented public Linux.do endpoints', () => {
  for (const url of [
    'https://linux.do/latest.rss',
    'https://linux.do/posts.rss',
    'https://linux.do/top.rss',
    'https://linux.do/t/topic/123.rss',
    'https://linux.do/c/develop/4.rss',
    'https://linux.do/tag/proxy.rss',
  ]) {
    assert.equal(normalizeLinuxDoRssUrl(url), url);
  }
  assert.equal(normalizeLinuxDoRssUrl('https://LINUX.DO/latest.rss'), 'https://linux.do/latest.rss');
});

test('pasted forum URLs are rewritten to their public RSS equivalent', () => {
  const cases = [
    // What the browser address bar actually shows for a topic.
    ['https://linux.do/t/免费代理分享/123456', 'https://linux.do/t/topic/123456.rss'],
    // Deep link to a reply: the post number must not be mistaken for the topic id.
    ['https://linux.do/t/免费代理分享/123456/7', 'https://linux.do/t/topic/123456.rss'],
    ['https://linux.do/t/2026/123456/7', 'https://linux.do/t/topic/123456.rss'],
    ['https://linux.do/t/topic/123456', 'https://linux.do/t/topic/123456.rss'],
    ['https://linux.do/t/123456', 'https://linux.do/t/topic/123456.rss'],
    // Share links carry ?u=<username>, in-thread anchors carry #post_N.
    ['https://linux.do/t/slug/123456?u=someone', 'https://linux.do/t/topic/123456.rss'],
    ['https://linux.do/t/slug/123456#post_7', 'https://linux.do/t/topic/123456.rss'],
    ['linux.do/t/slug/123456', 'https://linux.do/t/topic/123456.rss'],
    ['  https://linux.do/t/slug/123456/  ', 'https://linux.do/t/topic/123456.rss'],
    ['https://linux.do/c/develop/4', 'https://linux.do/c/develop/4.rss'],
    ['https://linux.do/c/develop/4/l/latest', 'https://linux.do/c/develop/4.rss'],
    ['https://linux.do/tag/proxy', 'https://linux.do/tag/proxy.rss'],
    ['https://linux.do/tag/代理', 'https://linux.do/tag/%E4%BB%A3%E7%90%86.rss'],
    ['https://linux.do/latest', 'https://linux.do/latest.rss'],
    // Already a feed URL: returned untouched, including the parts policy rejects.
    ['https://linux.do/latest.rss', 'https://linux.do/latest.rss'],
    ['https://linux.do/latest.rss?x=1', 'https://linux.do/latest.rss?x=1'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(toLinuxDoRssUrl(input), expected, `rewrite failed: ${input}`);
  }
  // Every rewrite must still satisfy the strict policy that fetch time enforces.
  for (const [input, expected] of cases.filter(([, out]) => !out.includes('?'))) {
    assert.equal(normalizeLinuxDoRssUrl(toLinuxDoRssUrl(input)), expected);
  }
  // The convenience layer must not become a way in for anything else.
  for (const url of [
    'https://evil.com/t/slug/123456',
    'https://linux.do.evil.com/t/slug/123456',
    'http://linux.do/t/slug/123456',
    'https://linux.do:8443/t/slug/123456',
    'https://user:pass@linux.do/t/slug/123456',
    'https://linux.do/admin/backups',
    'https://linux.do/t/slug-without-id',
    'https://linux.do/u/someone/summary',
    'not-a-url',
  ]) {
    assert.throws(() => normalizeLinuxDoRssUrl(toLinuxDoRssUrl(url)), undefined, `expected rejection: ${url}`);
  }
});

test('adding a feed accepts a browser topic URL and validates fields before duplicates', async () => {
  const input = { url: 'https://linux.do/t/a-shared-proxy-list/987654321/5', protocol: 'http', pollIntervalMinutes: 60 };
  const feed = await addLinuxDoRssFeed(input);
  assert.equal(feed.url, 'https://linux.do/t/topic/987654321.rss');

  await assert.rejects(
    addLinuxDoRssFeed({ ...input, protocol: 'ftp' }),
    /默认协议无效/,
  );
  await assert.rejects(
    addLinuxDoRssFeed({ ...input, pollIntervalMinutes: 5 }),
    /轮询间隔应在 15 到 1440 分钟之间/,
  );
  await assert.rejects(addLinuxDoRssFeed(input), /该 RSS 来源已存在/);
});

test('RSS URL policy rejects non-public Linux.do variants before fetch', async () => {
  for (const url of [
    'http://linux.do/latest.rss',
    'https://example.com/latest.rss',
    'https://evil.linux.do/latest.rss',
    'https://linux.do.evil.com/latest.rss',
    'https://linux.do:8443/latest.rss',
    'https://user:pass@linux.do/latest.rss',
    'https://linux.do/latest.rss?x=1',
    'https://linux.do/latest.rss#frag',
    'https://linux.do/latest',
    'https://linux.do/admin/backups.rss',
    'https://127.0.0.1/latest.rss',
    'not-a-url',
  ]) {
    assert.throws(() => normalizeLinuxDoRssUrl(url), undefined, `expected rejection: ${url}`);
    await assert.rejects(validateLinuxDoRssUrl(url), undefined, `expected async rejection: ${url}`);
  }
});

test('RSS XML parsing handles CDATA, content:encoded and Atom entries', () => {
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <item>
      <title><![CDATA[免费 HTTP 代理分享]]></title>
      <link>https://linux.do/t/topic/1001</link>
      <guid isPermaLink="false">topic-1001</guid>
      <pubDate>Sat, 25 Jul 2026 08:00:00 +0000</pubDate>
      <content:encoded><![CDATA[<pre><code>http://1.2.3.4:8080
5.6.7.8:1080</code></pre>]]></content:encoded>
    </item>
    <item>
      <title>No proxies here</title>
      <link>javascript:alert(1)</link>
      <description><![CDATA[<p>just chatting</p>]]></description>
    </item>
  </channel>
</rss>`;
  const items = parseRssItems(rss);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '免费 HTTP 代理分享');
  assert.equal(items[0].itemUrl, 'https://linux.do/t/topic/1001');
  assert.deepEqual(extractProxyLinesFromRssContent(items[0].content), ['http://1.2.3.4:8080', 'http://5.6.7.8:1080']);
  assert.equal(items[1].itemUrl, '', 'non-Linux.do item links must be dropped');
  assert.deepEqual(extractProxyLinesFromRssContent(items[1].content), []);

  const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>atom-1</id>
    <title>Atom proxy post</title>
    <link rel="alternate" href="https://linux.do/t/topic/2002"/>
    <updated>2026-07-25T09:00:00Z</updated>
    <summary type="html">&lt;pre&gt;socks5://9.9.9.9:1080&lt;/pre&gt;</summary>
  </entry>
</feed>`;
  const atomItems = parseRssItems(atom);
  assert.equal(atomItems.length, 1);
  assert.equal(atomItems[0].itemUrl, 'https://linux.do/t/topic/2002');
  assert.deepEqual(extractProxyLinesFromRssContent(atomItems[0].content), ['socks5://9.9.9.9:1080']);
});

test('RSS XML parsing rejects entity declarations', () => {
  assert.throws(() => parseRssItems('<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><item><title>&x;</title></item></channel></rss>'), /实体/);
});

test('RSS items dedupe by key and only re-import when content changes', () => {
  const feed = db.createRssFeed({ id: 'feed-dedupe', url: 'https://linux.do/latest.rss', label: 'latest', protocol: 'http', pollIntervalMinutes: 60 });
  const base = { feedId: feed.id, itemKey: 'key-1', itemUrl: 'https://linux.do/t/topic/1', title: 't', publishedAt: null, status: 'pending' };

  const first = db.upsertRssFeedItem({ ...base, contentHash: 'hash-a' });
  assert.equal(first.isNew, true);
  assert.equal(first.changed, true);
  db.updateRssFeedItem(first.id, { status: 'imported', extracted_count: 2, import_task_id: 'task-a' });

  const unchanged = db.upsertRssFeedItem({ ...base, contentHash: 'hash-a' });
  assert.equal(unchanged.isNew, false);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.status, 'imported', 'terminal state must survive an unchanged re-poll');
  assert.equal(unchanged.import_task_id, 'task-a');

  const changed = db.upsertRssFeedItem({ ...base, contentHash: 'hash-b' });
  assert.equal(changed.changed, true);
  assert.equal(changed.status, 'pending', 'changed content must become importable again');
  assert.equal(db.listRssFeedItems(feed.id, 10).length, 1, 'the same item key must never duplicate');

  db.updateRssFeedItem(changed.id, { status: 'error', error: 'boom' });
  const retryable = db.upsertRssFeedItem({ ...base, contentHash: 'hash-b' });
  assert.equal(retryable.changed, false);
  assert.equal(retryable.status, 'error', 'failed items stay retryable rather than terminal');
});

test('due feed selection respects interval, enabled flag and failure backoff', () => {
  const now = Date.UTC(2026, 6, 25, 12, 0, 0);
  const fresh = db.createRssFeed({ id: 'feed-due', url: 'https://linux.do/top.rss', protocol: 'http', pollIntervalMinutes: 60 });
  assert.ok(db.getDueRssFeeds(now).some(item => item.id === fresh.id), 'never-checked feeds are due');

  db.updateRssFeedFetchState(fresh.id, { last_checked_at: new Date(now - 30 * 60_000).toISOString(), last_status: 'success', consecutive_failures: 0 });
  assert.equal(db.getDueRssFeeds(now).some(item => item.id === fresh.id), false, 'inside the interval it is not due');

  db.updateRssFeedFetchState(fresh.id, { last_checked_at: new Date(now - 90 * 60_000).toISOString() });
  assert.ok(db.getDueRssFeeds(now).some(item => item.id === fresh.id), 'past the interval it is due again');

  db.updateRssFeedFetchState(fresh.id, { consecutive_failures: 3 });
  assert.equal(db.getDueRssFeeds(now).some(item => item.id === fresh.id), false, 'repeated failures back off');

  db.updateRssFeed(fresh.id, { enabled: 0 });
  db.updateRssFeedFetchState(fresh.id, { last_checked_at: null, consecutive_failures: 0 });
  assert.equal(db.getDueRssFeeds(now).some(item => item.id === fresh.id), false, 'disabled feeds are never fetched');
});

test('RSS queue metadata is retained in import history', () => {
  db.enqueueImport('rss-task', [{ index: 0, text: 'http://1.2.3.4:8080', lineCount: 1, protocol: 'http', skipDuplicates: true, autoClassify: true, groupName: 'public-http' }], { sourceType: 'rss', sourceRef: 'https://linux.do/t/example', rssFeedItemId: 7 });
  const task = db.getImportQueue().tasks.find(item => item.taskId === 'rss-task');
  assert.equal(task.sourceType, 'rss');
  assert.equal(task.sourceRef, 'https://linux.do/t/example');
});

test('processing an RSS import task stamps provenance and closes only that task', async () => {
  const feed = db.createRssFeed({ id: 'feed-e2e', url: 'https://linux.do/posts.rss', protocol: 'socks5', pollIntervalMinutes: 30 });
  const item = db.upsertRssFeedItem({
    feedId: feed.id, itemKey: crypto.createHash('sha256').update('e2e').digest('hex'),
    itemUrl: 'https://linux.do/t/topic/4242', title: 'share', contentHash: 'hash-e2e', status: 'pending',
  });

  db.enqueueImport('rss-e2e', [{ index: 0, text: 'socks5://203.0.113.7:1080', lineCount: 1, protocol: 'socks5', skipDuplicates: true, autoClassify: true, groupName: 'linuxdo' }], {
    sourceType: 'rss', sourceRef: 'https://linux.do/t/topic/4242', rssFeedItemId: item.id,
  });
  db.updateRssFeedItem(item.id, { status: 'queued', import_task_id: 'rss-e2e', extracted_count: 1 });
  db.enqueueImport('paste-e2e', [{ index: 0, text: '198.51.100.9:3128', lineCount: 1, protocol: 'http', skipDuplicates: true, autoClassify: true, groupName: '' }]);

  await processImportQueue();

  const imported = db.listProxies({ search: '203.0.113.7' }).proxies[0];
  assert.ok(imported, 'RSS proxy row was created');
  assert.equal(imported.protocol, 'socks5');
  assert.equal(imported.source, 'rss:linux.do');
  assert.equal(imported.source_ref, 'https://linux.do/t/topic/4242');
  assert.equal(imported.group_name, 'linuxdo');

  const pasted = db.listProxies({ search: '198.51.100.9' }).proxies[0];
  assert.ok(pasted, 'plain import still works alongside RSS');
  assert.equal(pasted.source, 'import');
  assert.equal(pasted.source_ref, '');

  assert.equal(db.getImportTask('rss-e2e').status, 'done');
  assert.equal(db.getImportTaskState('rss-e2e').terminal, true);
  assert.equal(db.listRssFeedItems(feed.id, 10).find(row => row.id === item.id).status, 'imported');
});
