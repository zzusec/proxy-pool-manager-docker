// Throwaway probe: confirm the HTTP/2 dispatcher clears Cloudflare on linux.do
// where Node's HTTP/1.1-only global fetch gets challenged. Deliberately makes
// only two requests — linux.do rate-limits (429) under rapid probing.
import { Agent, fetch as h2Fetch } from 'undici';

const url = 'https://linux.do/latest.rss';
const headers = {
  Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9',
  'User-Agent': 'Proxy-Pool-Manager/1.0 (+public-rss)',
};

async function report(label, promise) {
  try {
    const res = await promise;
    const body = await res.text();
    const isChallenge = /Just a moment|challenge-platform/i.test(body);
    console.log(`${label}: status=${res.status} len=${body.length} ct=${res.headers.get('content-type')} challenge=${isChallenge} rss=${body.trimStart().startsWith('<?xml')}`);
    const items = (body.match(/<item>/g) || []).length;
    if (items) console.log(`  parsed <item> count=${items}`);
  } catch (error) {
    console.log(`${label}: ERROR ${error.message}`);
  }
}

const dispatcher = new Agent({ allowH2: true, connectTimeout: 10_000, headersTimeout: 15_000, bodyTimeout: 15_000 });
await report('global fetch (HTTP/1.1)', fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) }));
await report('undici allowH2     ', h2Fetch(url, { dispatcher, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) }));
await dispatcher.close();
