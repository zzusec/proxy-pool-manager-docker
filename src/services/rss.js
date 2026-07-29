import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { XMLParser } from 'fast-xml-parser';
import { load } from 'cheerio';
import { Agent, fetch as h2Fetch } from 'undici';
import {
  createRssFeed,
  getRssFeed,
  listRssFeeds,
  updateRssFeedFetchState,
  upsertRssFeedItem,
  updateRssFeedItem,
  enqueueImport,
} from '../db.js';
import { generateId, isValidIp, normalizeGroup, parseProxyLine } from '../utils/helpers.js';
import { resolveSubscriptionLinks, extractSupportedProxyLines } from './subscription.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_ITEMS_PER_FEED = 100;
const MAX_PROXY_LINES_PER_ITEM = 1000;

// Tag/category/latest feeds only carry the first post's excerpt ("阅读完整话题"),
// so shared node lists never appear in them. For promising topics we fetch the
// per-topic feed, which does contain every post in full.
// linux.do rate-limits per IP and answers with a Cloudflare challenge once the
// budget is spent — which also blocks plain feed fetches. Keep topic reads rare
// and back off hard as soon as we are throttled.
const TOPIC_FETCH_LIMIT = Number.parseInt(process.env.RSS_TOPIC_FETCH_LIMIT || '', 10) || 4;
const TOPIC_FETCH_DELAY_MS = Number.parseInt(process.env.RSS_TOPIC_FETCH_DELAY_MS || '', 10) || 4000;
const TOPIC_COOLDOWN_MS = Number.parseInt(process.env.RSS_TOPIC_COOLDOWN_MS || '', 10) || 30 * 60 * 1000;
// The budget is global, not per feed: several feeds refreshing in the same
// minute is exactly what trips linux.do's per-IP limiter.
const TOPIC_WINDOW_MS = 10 * 60 * 1000;
const TOPIC_WINDOW_LIMIT = Number.parseInt(process.env.RSS_TOPIC_WINDOW_LIMIT || '', 10) || 6;
let topicCooldownUntil = 0;
let topicFetchTimes = [];

function takeTopicFetchSlot() {
  const now = Date.now();
  topicFetchTimes = topicFetchTimes.filter(time => now - time < TOPIC_WINDOW_MS);
  if (topicFetchTimes.length >= TOPIC_WINDOW_LIMIT) return false;
  topicFetchTimes.push(now);
  return true;
}

export function getTopicFetchCooldown() {
  return Math.max(0, topicCooldownUntil - Date.now());
}
// Unambiguous signals of a proxy/node-sharing post.
const TOPIC_STRONG_HINT = /(vmess|vless|trojan|hysteria|hy2|shadowsocks|ssr?:\/\/|clash|v2ray|sing-?box|shadowrocket|订阅链接|免费节点|节点分享|分享节点|公益节点|免费机场|白嫖节点|免费代理|机场分享|每日节点|住宅代理|静态住宅|住宅\s*ip|代理池|ip\s*池|http\s*代理|https\s*代理|socks5?\s*代理|代理分享|proxy\s*(?:list|pool))/i;
// Weaker words count when a proxy noun and a "free/share" word co-occur.
const TOPIC_SUBJECT = /(节点|机场|代理|订阅|住宅|proxy|socks|https?)/i;
const TOPIC_INTENT = /(免费|分享|白嫖|公益|自取|直连|无限|试用|领取|福利|测试)/i;

/** 2 = obvious sharing post, 1 = plausible, 0 = ignore. */
export function topicScore(text) {
  if (TOPIC_STRONG_HINT.test(text)) return 2;
  return TOPIC_SUBJECT.test(text) && TOPIC_INTENT.test(text) ? 1 : 0;
}
const activeFeeds = new Set();

// linux.do sits behind Cloudflare, which answers HTTP/1.1 clients with a JS
// challenge page ("Just a moment...", HTTP 403) and only lets HTTP/2 through.
// Node's global fetch is HTTP/1.1-only, so RSS requests go through an undici
// dispatcher with h2 enabled; it falls back to HTTP/1.1 via ALPN if a host
// does not offer h2. No cookie jar is attached — requests stay anonymous.
const rssDispatcher = new Agent({
  allowH2: true,
  connectTimeout: 10_000,
  headersTimeout: FETCH_TIMEOUT_MS,
  bodyTimeout: FETCH_TIMEOUT_MS,
});

function isPrivateAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIP(address) === 6) {
    const value = address.toLowerCase();
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
      value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') ||
      value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.');
  }
  return true;
}

export function normalizeLinuxDoRssUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('RSS 地址格式无效'); }

  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'linux.do' || url.port || url.username || url.password || url.search || url.hash) {
    throw new Error('仅支持不带参数的 https://linux.do 公共 RSS 地址');
  }
  const allowed = url.pathname === '/latest.rss' || url.pathname === '/posts.rss' || url.pathname === '/top.rss' ||
    (/^\/(?:t|c|tag)\/[^?#]+\.rss$/.test(url.pathname));
  if (!allowed) throw new Error('只支持 latest/posts/top 或话题、分类、标签的 .rss 地址');
  return url.toString();
}

// What people actually copy out of a browser is the forum URL, not the feed URL:
// a topic reads `https://linux.do/t/<slug>/<id>` (sometimes with a trailing post
// number), a tag reads `https://linux.do/tag/<name>`. Rewrite those few shapes to
// the matching public RSS path so nobody has to hand-edit them; anything else
// falls through unchanged and is rejected by normalizeLinuxDoRssUrl() as before.
//
// Only the operator-facing "add feed" path uses this. Fetch time and every
// redirect target still go through the strict normalizer, so this leniency
// cannot widen what the fetcher is willing to request.
export function toLinuxDoRssUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { return raw; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'linux.do' || url.port || url.username || url.password) return raw;
  if (url.pathname.endsWith('.rss')) return url.toString();

  // Share links carry `?u=<username>` and in-thread links carry `#post_7`; both
  // are noise for a feed URL, so drop them rather than making the user do it.
  url.search = '';
  url.hash = '';
  // Category and tag pages carry a trailing listing suffix, e.g.
  // /c/develop/4/l/latest — strip only that exact trailing pair.
  const [head, ...rest] = url.pathname.replace(/\/l\/[a-z-]+\/?$/i, '').split('/').filter(Boolean);

  if (head === 't') {
    // Discourse routes topics as /t/<slug>/<id>[/<post>]. Use the fixed id
    // position rather than scanning for a number: a numeric slug or trailing
    // post number must not be mistaken for the topic id. /t/<id> short links
    // are accepted as well.
    const topicId = rest.length === 1 ? rest[0] : rest[1];
    if (!/^\d+$/.test(topicId || '')) return raw;
    url.pathname = `/t/topic/${topicId}.rss`;
    return url.toString();
  }
  if ((head === 'c' || head === 'tag') && rest.length) {
    url.pathname = `/${[head, ...rest].join('/')}.rss`;
    return url.toString();
  }
  if (!rest.length && ['latest', 'posts', 'top'].includes(head)) {
    url.pathname = `/${head}.rss`;
    return url.toString();
  }
  return raw;
}

export async function validateLinuxDoRssUrl(value) {
  const normalized = normalizeLinuxDoRssUrl(value);
  const url = new URL(normalized);
  const resolved = await dns.lookup(url.hostname, { all: true });
  if (!resolved.length || resolved.some(entry => isPrivateAddress(entry.address))) {
    throw new Error('RSS 域名未解析到公网地址，已拒绝抓取');
  }
  return normalized;
}

// Release the socket for responses we are not going to read (redirects, errors),
// otherwise the keep-alive dispatcher holds the stream open until it times out.
async function discardBody(response) {
  try { await response.body?.cancel(); } catch { /* already closed */ }
}

async function readResponseText(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await discardBody(response);
    throw new Error('RSS 内容超过 5MB 限制');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_RESPONSE_BYTES) throw new Error('RSS 内容超过 5MB 限制');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
}

async function fetchPublicRss(feed) {
  let url = new URL(feed.url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await validateLinuxDoRssUrl(url.toString());
    const headers = {
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9',
      'User-Agent': 'Proxy-Pool-Manager/1.0 (+public-rss)',
    };
    if (feed.etag) headers['If-None-Match'] = feed.etag;
    if (feed.lastModified) headers['If-Modified-Since'] = feed.lastModified;
    const response = await h2Fetch(url, {
      dispatcher: rssDispatcher,
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers,
    });
    if (response.status === 304) {
      await discardBody(response);
      return { status: 304, etag: feed.etag || '', lastModified: feed.lastModified || '' };
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await discardBody(response);
      if (!location) throw new Error('RSS 重定向缺少目标地址');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      await discardBody(response);
      if (response.status === 429) throw new Error(`Linux.do 限流 (429)${retryAfter ? `，${retryAfter} 秒后重试` : '，请稍后重试'}`);
      if (response.status === 403 || response.status === 503) {
        throw new Error(`Linux.do 拒绝抓取 (${response.status})，可能触发了 Cloudflare 人机验证，稍后会自动重试`);
      }
      throw new Error(`RSS 请求失败 (${response.status})`);
    }
    return {
      status: response.status,
      text: await readResponseText(response),
      etag: response.headers.get('etag') || '',
      lastModified: response.headers.get('last-modified') || '',
    };
  }
  throw new Error('RSS 重定向次数过多');
}

function toArray(value) { return Array.isArray(value) ? value : value ? [value] : []; }
function nodeText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return value['#text'] || value.__cdata || value['@_href'] || '';
  return String(value);
}

function safeLinuxDoItemUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'linux.do' || url.username || url.password) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

export function parseRssItems(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('RSS XML 包含不允许的实体声明');
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: false, parseTagValue: false, trimValues: false, cdataPropName: '__cdata' });
  const parsed = parser.parse(xml);
  const rssItems = toArray(parsed?.rss?.channel?.item);
  const atomItems = toArray(parsed?.feed?.entry);
  const items = rssItems.length ? rssItems : atomItems;
  if (!items.length && !parsed?.rss && !parsed?.feed) throw new Error('RSS XML 格式无效');
  return items.slice(0, MAX_ITEMS_PER_FEED).map((item, index) => {
    const linkValue = item.link;
    const rawLink = typeof linkValue === 'object' ? (linkValue['@_href'] || nodeText(linkValue)) : nodeText(linkValue);
    const link = safeLinuxDoItemUrl(rawLink);
    const title = nodeText(item.title);
    const content = nodeText(item['content:encoded']) || nodeText(item.content) || nodeText(item.summary) || nodeText(item.description);
    const guid = nodeText(item.guid) || nodeText(item.id) || link || `${title}:${index}`;
    return { itemKey: crypto.createHash('sha256').update(guid).digest('hex'), itemUrl: link, title, publishedAt: nodeText(item.pubDate) || nodeText(item.published) || nodeText(item.updated) || null, content };
  });
}

function htmlToLines(value) {
  const $ = load(value || '', { xmlMode: false, decodeEntities: true });
  $('script, style, noscript, iframe, object, embed').remove();
  $('br').replaceWith('\n');
  $('pre, code, p, li, div, blockquote').each((_, element) => $(element).after('\n'));
  return $.root().text().replace(/\r/g, '').split('\n');
}

function extractSubscriptionUrlsFromRssContent(content) {
  const urls = new Set();
  const $ = load(content || '', { xmlMode: false, decodeEntities: true });
  $('script, style, noscript, iframe, object, embed').remove();

  // Subscription URLs are often linked behind a button/text, so include hrefs as
  // well as plain text. Linux.do topic links are deliberately ignored: those are
  // discussion links, not proxy subscription endpoints.
  $('a[href]').each((_, element) => {
    const href = ($(element).attr('href') || '').trim();
    if (/^https?:\/\//i.test(href) && !/^https:\/\/linux\.do(?:\/|$)/i.test(href)) urls.add(href);
  });
  const text = $.root().text();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'，；]+/gi)) {
    const url = match[0].replace(/[),.，。；;]+$/, '');
    if (!/^https:\/\/linux\.do(?:\/|$)/i.test(url)) urls.add(url);
  }

  // A full topic body links to images, docs and unrelated sites. Prefer links
  // that look like subscription endpoints so one post cannot trigger dozens of
  // pointless outbound fetches.
  const candidates = [...urls].filter(url => !/\.(?:png|jpe?g|gif|webp|svg|ico|css|js|mp4|webm|pdf|zip)(?:\?|$)/i.test(url));
  const hinted = candidates.filter(url => /(sub|subscribe|clash|v2ray|sing-?box|shadowrocket|token=|\/link\/|proxies|nodes?)/i.test(url));
  return (hinted.length ? hinted : candidates).slice(0, 8);
}

function canonicalProxyLine(proxy) {
  const credentials = proxy.username ? `${proxy.username}:${proxy.password || ''}@` : '';
  const host = net.isIP(proxy.ip) === 6 ? `[${proxy.ip}]` : proxy.ip;
  return `${proxy.protocol || 'http'}://${credentials}${host}:${proxy.port}`;
}

function candidateStrings(rawLine) {
  const cleaned = rawLine.trim()
    .replace(/^(?:[>*•-]\s*)+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^```(?:\w+)?\s*$/i, '')
    .replace(/[，,;；。]+$/, '')
    .trim();
  if (!cleaned) return [];
  const candidates = [cleaned];
  const tokenPattern = /(?:https?|socks[45]):\/\/[^\s<>"'，；]+|(?:[^\s:@]{1,64}:[^\s@]{1,64}@)?(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}(?::[^\s:]{1,64}:[^\s]{1,64})?/gi;
  for (const match of cleaned.matchAll(tokenPattern)) candidates.push(match[0]);
  return [...new Set(candidates)];
}

/**
 * Node-sharing posts carry vmess/vless/trojan/hysteria2/ss URIs or a base64 /
 * Clash blob rather than bare `ip:port`. Reuse the subscription parser for those
 * and keep the original URI so its parameters (uuid, sni, path…) survive.
 */
function extractNativeUriLines(text, seen, lines) {
  // Posts either list URIs directly or paste one long base64 subscription blob;
  // hand both shapes to the subscription parser.
  const blocks = [text];
  for (const rawLine of text.split(/\r?\n/)) {
    const compact = rawLine.trim();
    if (compact.length >= 64 && /^[A-Za-z0-9+/_=-]+$/.test(compact)) blocks.push(compact);
    if (blocks.length > 20) break;
  }

  const candidates = [];
  for (const block of blocks) {
    try { candidates.push(...extractSupportedProxyLines(block)); } catch { /* unparsable block */ }
  }
  for (const line of candidates) {
    const parsed = parseProxyLine(line);
    if (!parsed || parsed.port < 1 || parsed.port > 65535) continue;
    // Bare ip:port lines and http/socks URIs are handled by the caller's
    // stricter prose-aware pass; this one only owns the node protocols.
    if (!/^[a-z0-9+.-]+:\/\//i.test(line.trim())) continue;
    if (/^(?:https?|socks[45]):\/\//i.test(line.trim())) continue;
    if (net.isIP(parsed.ip) && isPrivateAddress(parsed.ip)) continue;
    const key = `${parsed.protocol}|${parsed.ip}|${parsed.port}|${parsed.username || ''}|${parsed.password || ''}|${JSON.stringify(parsed.extra || {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line.trim());
    if (lines.length >= MAX_PROXY_LINES_PER_ITEM) return;
  }
}

export function extractProxyLinesFromRssContent(content, defaultProtocol = 'http') {
  const seen = new Set();
  const lines = [];
  const plainText = htmlToLines(content).join('\n');
  extractNativeUriLines(plainText, seen, lines);
  if (lines.length >= MAX_PROXY_LINES_PER_ITEM) return lines;

  for (const rawLine of htmlToLines(content)) {
    for (const line of candidateStrings(rawLine)) {
      // A native node URI was already captured above; re-reading it here would
      // downgrade e.g. vmess:// into a bogus http:// entry for the same host.
      if (/^[a-z0-9+.-]+:\/\//i.test(line) && !/^(?:https?|socks[45]):\/\//i.test(line)) continue;
      const parsed = parseProxyLine(line);
      if (!parsed || !isValidIp(parsed.ip) || parsed.port < 1 || parsed.port > 65535) continue;
      // Forum prose is full of loopback/LAN examples ("配置 proxy 为 127.0.0.1:8999").
      // Such an address is never a usable shared proxy, and importing one would
      // point the tester at our own container/LAN, turning any post into an
      // internal port probe. Paste imports are unaffected — a LAN proxy there is
      // the operator's own deliberate choice.
      if (isPrivateAddress(parsed.ip)) continue;
      if (!/^(?:https?|socks[45]):\/\//i.test(line)) parsed.protocol = defaultProtocol;
      if (!['http', 'https', 'socks5'].includes(parsed.protocol)) continue;
      const key = `${parsed.protocol}|${parsed.ip}|${parsed.port}|${parsed.username || ''}|${parsed.password || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(canonicalProxyLine(parsed));
      if (lines.length >= MAX_PROXY_LINES_PER_ITEM) return lines;
    }
  }
  return lines;
}

function isTopicFeedUrl(value) {
  return /^https:\/\/linux\.do\/t\/topic\/\d+(?:\.rss)?(?:\?|$)/i.test(String(value || ''));
}

/**
 * Pull the posts of one topic. Both the tag feed and the per-topic feed only
 * carry excerpts ("阅读完整话题"), so the shared node lists are only reachable
 * through Discourse's public topic JSON. Failures are swallowed: one
 * unreachable topic must not fail the whole run.
 */
export async function fetchTopicContent(itemUrl) {
  const match = String(itemUrl || '').match(/^https:\/\/linux\.do\/t\/topic\/(\d+)/i);
  if (!match) return '';
  if (Date.now() < topicCooldownUntil) return '';
  if (!takeTopicFetchSlot()) return '';
  try {
    const resolved = await dns.lookup('linux.do', { all: true });
    if (!resolved.length || resolved.some(entry => isPrivateAddress(entry.address))) return '';
    const response = await h2Fetch(`https://linux.do/t/topic/${match[1]}.json`, {
      dispatcher: rssDispatcher,
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json', 'User-Agent': 'Proxy-Pool-Manager/1.0 (+public-rss)' },
    });
    if (!response.ok) {
      await discardBody(response);
      // 429/403 means the whole IP is throttled; pause topic reads so feed
      // fetching itself keeps working.
      if ([403, 429, 503].includes(response.status)) topicCooldownUntil = Date.now() + TOPIC_COOLDOWN_MS;
      return '';
    }
    const body = await readResponseText(response);
    if (body.includes('Just a moment')) {
      topicCooldownUntil = Date.now() + TOPIC_COOLDOWN_MS;
      return '';
    }
    const data = JSON.parse(body);
    return (data?.post_stream?.posts || []).map(post => post?.cooked || '').join('\n');
  } catch {
    return '';
  }
}

function makeChunks(lines, feed) {
  const chunks = [];
  for (let start = 0; start < lines.length; start += 200) {
    chunks.push({
      index: chunks.length,
      text: lines.slice(start, start + 200).join('\n'),
      lineCount: Math.min(200, lines.length - start),
      protocol: feed.protocol,
      skipDuplicates: feed.skipDuplicates,
      autoClassify: feed.autoClassify,
      groupName: feed.group || '',
    });
  }
  return chunks;
}

// Configuration only enforces the static URL policy; DNS/public-IP checks run at
// fetch time (and on every redirect) so a resolver hiccup cannot block setup and
// cannot bypass SSRF protection either.
export async function addLinuxDoRssFeed(input) {
  if (listRssFeeds().length >= 20) throw new Error('最多配置 20 个 RSS 来源');
  const url = normalizeLinuxDoRssUrl(toLinuxDoRssUrl(input.url));
  const groupName = normalizeGroup(input.group || '');
  const protocol = input.protocol || 'http';
  if (!['http', 'https', 'socks5'].includes(protocol)) throw new Error('默认协议无效');
  const pollIntervalMinutes = input.pollIntervalMinutes === undefined || input.pollIntervalMinutes === '' ? 60 : Number(input.pollIntervalMinutes);
  if (!Number.isInteger(pollIntervalMinutes) || pollIntervalMinutes < 15 || pollIntervalMinutes > 1440) throw new Error('轮询间隔应在 15 到 1440 分钟之间');
  // Duplicate check comes last so a bad interval/protocol reports the field error
  // instead of being masked by "该 RSS 来源已存在".
  if (listRssFeeds().some(feed => feed.url === url)) throw new Error('该 RSS 来源已存在');
  return createRssFeed({ id: generateId(), url, label: String(input.label || '').trim().slice(0, 100), enabled: input.enabled !== false, groupName, protocol, skipDuplicates: input.skipDuplicates !== false, autoClassify: input.autoClassify !== false, pollIntervalMinutes });
}

export function isRssFeedFetching(feedId) {
  return activeFeeds.has(feedId);
}

export function canStartRssFetch() {
  return activeFeeds.size < 2;
}

export async function fetchRssFeed(feedId) {
  if (activeFeeds.has(feedId)) throw new Error('该 RSS 来源正在抓取');
  if (activeFeeds.size >= 2) throw new Error('RSS 抓取任务繁忙，请稍后重试');
  const feed = getRssFeed(feedId);
  if (!feed) throw new Error('RSS 来源不存在');
  activeFeeds.add(feedId);
  const checkedAt = new Date().toISOString();
  updateRssFeedFetchState(feedId, { last_checked_at: checkedAt, last_status: 'fetching', last_error: '' });
  try {
    const response = await fetchPublicRss(feed);
    if (response.status === 304) {
      updateRssFeedFetchState(feedId, { last_checked_at: checkedAt, last_success_at: checkedAt, last_status: 'not_modified', last_error: '', consecutive_failures: 0 });
      return { feedId, status: 'not_modified', newItems: 0, queuedTasks: 0, proxies: 0 };
    }

    let newItems = 0;
    let queuedTasks = 0;
    let proxies = 0;
    let topicFetches = 0;
    const listFeed = !isTopicFeedUrl(feed.url);
    // The per-IP budget is small, so the most promising posts must be read
    // first; posts that match nothing are never fetched at all.
    const parsedItems = parseRssItems(response.text);
    const orderedItems = listFeed
      ? [...parsedItems].sort((a, b) =>
          topicScore(`${b.title || ''}\n${b.content || ''}`) - topicScore(`${a.title || ''}\n${a.content || ''}`))
      : parsedItems;
    for (const item of orderedItems) {
      // The hash stays tied to the excerpt so an item is processed once; the
      // full topic body is only pulled for items we are actually going to parse.
      const summaryText = `${item.title || ''}\n${item.content || ''}`;
      const contentHash = crypto.createHash('sha256').update(summaryText).digest('hex');
      const saved = upsertRssFeedItem({ feedId, ...item, contentHash, status: 'pending' });
      if (!saved.isNew && !saved.changed && !['pending', 'error'].includes(saved.status)) continue;
      newItems++;
      try {
        let extractableText = summaryText;
        // Excerpt-only feeds hide the shared nodes; fetch the full topic when the
        // post looks like a sharing thread, within a per-run budget.
        if (listFeed && topicFetches < TOPIC_FETCH_LIMIT && topicScore(summaryText) > 0) {
          topicFetches++;
          if (topicFetches > 1) await new Promise(resolve => setTimeout(resolve, TOPIC_FETCH_DELAY_MS));
          const full = await fetchTopicContent(item.itemUrl);
          if (full) extractableText = `${summaryText}\n${full}`;
        }
        const directLines = extractProxyLinesFromRssContent(extractableText, feed.protocol);
        const subscriptionUrls = extractSubscriptionUrlsFromRssContent(extractableText);
        let subscriptionLines = [];
        if (subscriptionUrls.length) {
          // Resolve each public subscription through the same bounded, SSRF-safe
          // importer used by manual imports. A bad link never blocks proxies from
          // the rest of the post from being imported.
          const resolved = await resolveSubscriptionLinks(subscriptionUrls.join('\n'));
          subscriptionLines = resolved.proxyLines;
        }
        const lines = [...new Set([...directLines, ...subscriptionLines])];
        if (!lines.length) {
          updateRssFeedItem(saved.id, { extracted_count: 0, status: 'no_candidates', import_task_id: '', error: '' });
          continue;
        }
        const taskId = generateId();
        enqueueImport(taskId, makeChunks(lines, feed), { sourceType: 'rss', sourceRef: item.itemUrl, rssFeedItemId: saved.id });
        updateRssFeedItem(saved.id, { extracted_count: lines.length, status: 'queued', import_task_id: taskId, error: '' });
        queuedTasks++;
        proxies += lines.length;
      } catch (itemError) {
        updateRssFeedItem(saved.id, { status: 'error', error: String(itemError.message || 'RSS 项目导入失败').slice(0, 240) });
      }
    }
    updateRssFeedFetchState(feedId, { etag: response.etag, last_modified: response.lastModified, last_checked_at: checkedAt, last_success_at: checkedAt, last_status: 'success', last_error: '', consecutive_failures: 0 });
    return { feedId, status: 'success', newItems, queuedTasks, proxies };
  } catch (error) {
    const message = String(error?.message || 'RSS 抓取失败').replace(/[\r\n]+/g, ' ').slice(0, 240);
    const latest = getRssFeed(feedId);
    updateRssFeedFetchState(feedId, { last_checked_at: checkedAt, last_status: 'error', last_error: message, consecutive_failures: (latest?.consecutiveFailures || 0) + 1 });
    throw new Error(message);
  } finally {
    activeFeeds.delete(feedId);
  }
}
