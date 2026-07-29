import { deleteRssFeed, getRssFeed, listRssFeedItems, listRssFeeds, updateRssFeed } from '../db.js';
import { normalizeGroup } from '../utils/helpers.js';
import { addLinuxDoRssFeed, canStartRssFetch, fetchRssFeed, isRssFeedFetching } from '../services/rss.js';

function readFeedUpdate(body = {}) {
  const updates = {};
  if (Object.prototype.hasOwnProperty.call(body, 'label')) updates.label = String(body.label || '').trim().slice(0, 100);
  if (Object.prototype.hasOwnProperty.call(body, 'enabled')) updates.enabled = body.enabled ? 1 : 0;
  if (Object.prototype.hasOwnProperty.call(body, 'group')) updates.groupName = normalizeGroup(body.group || '');
  if (Object.prototype.hasOwnProperty.call(body, 'protocol')) {
    if (!['http', 'https', 'socks5'].includes(body.protocol)) throw new Error('默认协议无效');
    updates.protocol = body.protocol;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'skipDuplicates')) updates.skipDuplicates = body.skipDuplicates ? 1 : 0;
  if (Object.prototype.hasOwnProperty.call(body, 'autoClassify')) updates.autoClassify = body.autoClassify ? 1 : 0;
  if (Object.prototype.hasOwnProperty.call(body, 'pollIntervalMinutes')) {
    const interval = parseInt(body.pollIntervalMinutes);
    if (!Number.isInteger(interval) || interval < 15 || interval > 1440) throw new Error('轮询间隔应在 15 到 1440 分钟之间');
    updates.pollIntervalMinutes = interval;
  }
  return updates;
}

export function setupRssRoutes(app) {
  app.get('/api/rss/feeds', (req, res) => {
    const feeds = listRssFeeds().map(feed => ({ ...feed, items: listRssFeedItems(feed.id, 8).map(item => ({
      id: item.id, title: item.title, url: item.item_url, publishedAt: item.published_at,
      extractedCount: item.extracted_count, status: item.status, importTaskId: item.import_task_id,
      error: item.error, lastSeenAt: item.last_seen_at,
    })) }));
    res.json({ feeds });
  });

  app.post('/api/rss/feeds', async (req, res) => {
    try {
      const feed = await addLinuxDoRssFeed(req.body || {});
      res.status(201).json({ ok: true, feed, message: 'RSS 来源已添加，可点击“立即抓取”读取公开内容' });
    } catch (error) {
      res.status(400).json({ error: error.message || 'RSS 来源添加失败' });
    }
  });

  app.put('/api/rss/feeds/:id', (req, res) => {
    try {
      if (!getRssFeed(req.params.id)) return res.status(404).json({ error: 'RSS 来源不存在' });
      const feed = updateRssFeed(req.params.id, readFeedUpdate(req.body));
      res.json({ ok: true, feed });
    } catch (error) {
      res.status(400).json({ error: error.message || 'RSS 来源更新失败' });
    }
  });

  app.post('/api/rss/feeds/:id/fetch', (req, res) => {
    if (!getRssFeed(req.params.id)) return res.status(404).json({ error: 'RSS 来源不存在' });
    if (isRssFeedFetching(req.params.id)) return res.status(409).json({ error: '该 RSS 来源正在抓取' });
    if (!canStartRssFetch()) return res.status(429).json({ error: 'RSS 抓取任务繁忙，请稍后重试' });
    fetchRssFeed(req.params.id)
      .then(async result => {
        if (result.queuedTasks) {
          const { processImportQueue } = await import('../services/scheduler.js');
          await processImportQueue();
        }
      })
      .catch(error => console.error(`[RSS] Manual fetch failed: ${error.message}`));
    res.status(202).json({ ok: true, message: 'RSS 正在后台抓取，请稍后刷新状态' });
  });

  app.delete('/api/rss/feeds/:id', (req, res) => {
    const deleted = deleteRssFeed(req.params.id);
    res.json({ ok: deleted });
  });
}
