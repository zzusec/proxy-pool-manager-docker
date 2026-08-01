import {
  backfillUntestedConnectivity,
  claimConnectivityItems,
  claimTestJobItems,
  completeConnectivityItem,
  completeTestJobItems,
  computeStats,
  deleteProxyById,
  enqueueConnectivity,
  finalizeTestJob,
  getNextConnectivityTestJob,
  getProxyById,
  getSetting,
  materializeTestJobSelection,
  proxyEndpointKey,
  recordExitIpObservation,
  retryConnectivityItem,
  upsertProxy,
} from '../db.js';
import { normalizeCountryCode } from '../utils/helpers.js';
import { testProxies } from './tester.js';

const yieldToIo = () => new Promise(resolve => setImmediate(resolve));
let workerRunning = false;
let workerWakePending = false;

/**
 * Persist one connectivity result through a single policy boundary. A stale
 * result is ignored when the endpoint changed while the network check ran.
 */
export function applyTestResult(proxy, result, expectedEndpointKey = null) {
  const current = getProxyById(proxy.id);
  if (!current) return { deleted: true, missing: true, outcome: 'missing' };

  const currentEndpointKey = proxyEndpointKey(current);
  if (expectedEndpointKey && currentEndpointKey !== expectedEndpointKey) {
    enqueueConnectivity(current.id, 'endpoint_changed_during_test');
    return { deleted: false, superseded: true, outcome: 'superseded' };
  }

  const outcome = result.outcome || (result.alive === true ? 'alive' : result.alive === false ? 'dead' : 'inconclusive');
  if (result.alive === false) {
    deleteProxyById(current.id);
    return { deleted: true, outcome };
  }

  const now = new Date().toISOString();
  current.lastTestOutcome = outcome;
  current.lastTestError = String(result.error || '').slice(0, 240);
  current.lastCheckAt = now;
  if (result.alive === true || result.alive === false) {
    current.alive = result.alive;
    current.exitIp = result.exitIp || null;
    current.responseTime = result.responseTime || null;
    current.anonymity = result.anonymity || null;
  }

  const observedCountry = normalizeCountryCode(result.country);
  if (observedCountry) {
    current.country = observedCountry;
    current.countryName = '';
    current.countrySource = 'observed';
  }
  current.updatedAt = now;
  upsertProxy(current);
  if (result.alive === true && result.exitIp) recordExitIpObservation(current.id, result.exitIp);
  completeConnectivityItem(current.id, currentEndpointKey);
  return { deleted: false, outcome };
}

async function processExplicitJobBatch() {
  const job = getNextConnectivityTestJob();
  if (!job) return false;

  const batchSize = Math.max(1, Math.min(Number.parseInt(getSetting('testBatchSize'), 10) || 20, 500));
  const proxyIds = claimTestJobItems(job.id, batchSize);
  if (!proxyIds.length) {
    finalizeTestJob(job.id);
    return true;
  }

  const proxies = proxyIds.map(getProxyById).filter(Boolean);
  const expectedById = new Map(proxies.map(proxy => [proxy.id, proxyEndpointKey(proxy)]));
  const tested = proxies.length ? await testProxies(proxies) : { results: [] };
  const resultById = new Map((tested.results || []).filter(item => item?.id).map(item => [item.id, item]));
  const completed = proxyIds.map(id => resultById.get(id) || ({ id, alive: null, outcome: 'inconclusive', error: '检测未返回结果' }));

  for (const item of completed) {
    const current = getProxyById(item.id);
    if (current) applyTestResult(current, item, expectedById.get(item.id));
  }
  completeTestJobItems(job.id, completed);
  finalizeTestJob(job.id);
  computeStats();
  return true;
}

async function processAutomaticBatch() {
  if (getSetting('autoTestEnabled') === 'false') return false;
  backfillUntestedConnectivity(500);

  const batchSize = Math.max(1, Math.min(Number.parseInt(getSetting('testBatchSize'), 10) || 20, 500));
  const items = claimConnectivityItems(batchSize);
  if (!items.length) return false;

  const proxies = [];
  const expectedById = new Map();
  for (const item of items) {
    const proxy = getProxyById(item.proxyId);
    if (!proxy) {
      completeConnectivityItem(item.proxyId, item.endpointKey);
      continue;
    }
    if (proxyEndpointKey(proxy) !== item.endpointKey) {
      enqueueConnectivity(proxy.id, 'endpoint_changed_before_test');
      continue;
    }
    proxies.push(proxy);
    expectedById.set(proxy.id, item.endpointKey);
  }

  try {
    const tested = proxies.length ? await testProxies(proxies) : { results: [] };
    const resultById = new Map((tested.results || []).filter(item => item?.id).map(item => [item.id, item]));
    for (const proxy of proxies) {
      const result = resultById.get(proxy.id) || { id: proxy.id, alive: null, outcome: 'inconclusive', error: '检测未返回结果' };
      applyTestResult(proxy, result, expectedById.get(proxy.id));
    }
    computeStats();
  } catch (error) {
    for (const proxy of proxies) {
      retryConnectivityItem(proxy.id, expectedById.get(proxy.id), error.message || '检测异常', 30);
    }
    console.error('[connectivity] Automatic batch error:', error.message);
    setTimeout(wakeConnectivityWorker, 30_000).unref?.();
  }
  return true;
}

export async function processConnectivityQueue() {
  if (workerRunning) {
    workerWakePending = true;
    return;
  }
  workerRunning = true;

  try {
    do {
      workerWakePending = false;
      const job = getNextConnectivityTestJob();
      if (job && job.selectionStatus !== 'done') {
        materializeTestJobSelection(job.id, 500);
        await yieldToIo();
        continue;
      }

      const explicitWorked = await processExplicitJobBatch();
      await yieldToIo();
      const automaticWorked = await processAutomaticBatch();
      if (!explicitWorked && !automaticWorked) break;
      await yieldToIo();
    } while (true);
  } catch (error) {
    const job = getNextConnectivityTestJob();
    if (job) finalizeTestJob(job.id, error.message || '检测失败');
    console.error('[connectivity] Worker error:', error.stack || error.message);
  } finally {
    workerRunning = false;
    if (workerWakePending || getNextConnectivityTestJob()) {
      setImmediate(() => processConnectivityQueue());
    }
  }
}

export function wakeConnectivityWorker() {
  workerWakePending = true;
  setImmediate(() => processConnectivityQueue());
}

export function startConnectivityWorker() {
  wakeConnectivityWorker();
}
