import cron from 'node-cron';
import { getUnclassifiedProxies, upsertProxy, getCronState, setCronState, computeStats, getNextPendingChunk, getImportTask, getImportTaskState, updateImportChunk, updateImportSummary, proxyExists, getSetting, createProxyAndEnqueue, enqueueDueConnectivity, expandImportInputChunk } from '../db.js';
import { batchClassify } from './classifier.js';
import { wakeConnectivityWorker } from './connectivity.js';
import { parseProxyLine, generateId } from '../utils/helpers.js';
import { resolveSubscriptionLinks } from './subscription.js';

let cronJob = null;

export function setupCron() {
  const schedule = process.env.CRON_SCHEDULE || '*/10 * * * *';
  if (!cron.validate(schedule)) {
    console.error(`[CRON] Invalid schedule: ${schedule}`);
    return;
  }

  cronJob = cron.schedule(schedule, () => {
    runScheduledTasks();
  }, { runOnInit: false });

  // Resume durable work immediately after a container restart.
  processImportQueue().catch(e => console.error('[IMPORT] Resume error:', e.message));
  console.log(`[CRON] Scheduled: ${schedule}`);
}

export async function runScheduledTasks() {
  const state = getCronState();

  // Lock: skip if already running
  if (state.status === 'running') {
    console.log('[CRON] Skipping: already running');
    return;
  }

  setCronState({ status: 'running', last_run_at: new Date().toISOString() });

  try {
    // Task 1: Classify unclassified proxies
    const autoClassify = getSetting('autoClassify');
    if (autoClassify !== 'false') {
      const classifyBatchSize = Math.max(1, Math.min(parseInt(getSetting('classifyBatchSize')) || 200, 1000));
      const unclassified = getUnclassifiedProxies(classifyBatchSize);
      if (unclassified.length > 0) {
        console.log(`[CRON] Classifying ${unclassified.length} proxies...`);
        const classified = await batchClassify(unclassified);
        for (const p of classified) {
          upsertProxy(p);
        }
        setCronState({
          classify_count: classified.length,
          last_classify_at: new Date().toISOString(),
        });
        console.log(`[CRON] Classified ${classified.length} proxies`);
      } else {
        setCronState({ classify_count: 0 });
      }
    }

    // Task 2: Enqueue due proxies; the shared worker applies the same deletion and
    // persistence policy as manual jobs without blocking this cron round.
    const checkInterval = parseInt(getSetting('checkInterval')) || 600;
    const autoTestEnabled = getSetting('autoTestEnabled') !== 'false';
    const testBatchSize = Math.max(1, Math.min(parseInt(getSetting('testBatchSize')) || 20, 500));
    const enqueued = autoTestEnabled ? enqueueDueConnectivity(checkInterval, Math.max(testBatchSize, 200)) : 0;
    if (enqueued > 0) wakeConnectivityWorker();
    setCronState({
      test_count: enqueued,
      last_test_at: enqueued > 0 ? new Date().toISOString() : getCronState().last_test_at,
    });
    console.log(`[CRON] Enqueued ${enqueued} proxies for connectivity testing`);

    // Task 3: Process import queue
    await processImportQueue();

    setCronState({ status: 'idle', error: null });
  } catch (e) {
    console.error('[CRON] Error:', e.message);
    setCronState({ status: 'error', error: e.message });
  }

  // Recompute stats
  computeStats();
}

let importQueueProcessing = false;

export async function processImportQueue() {
  if (importQueueProcessing) return;
  importQueueProcessing = true;

  try {
    while (true) {
      const chunk = getNextPendingChunk();
      if (!chunk) break;
      updateImportChunk(chunk.id, { status: 'processing' });

      try {
        if (chunk.work_type === 'resolve_input') {
          const resolved = await resolveSubscriptionLinks(chunk.raw_text);
          const lines = resolved.proxyLines.filter(line => line.trim());
          if (!lines.length) {
            const detail = resolved.subscriptions.filter(item => !item.ok).map(item => item.error).join('；')
              || '未发现可导入的代理';
            throw new Error(detail);
          }
          expandImportInputChunk(chunk, lines, 200);
          console.log(`[IMPORT] Input resolved: ${lines.length} proxy lines`);
          await new Promise(resolve => setImmediate(resolve));
          continue;
        }

        const lines = chunk.raw_text.split(/\r?\n/).filter(line => line.trim());
        let imported = 0, duplicates = 0, errors = 0;

        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          const parsed = parseProxyLine(line);
          if (!parsed) { errors++; continue; }

          const protocol = parsed.protocol || chunk.protocol;
          if (chunk.skip_duplicates && proxyExists(parsed.ip, parsed.port, protocol)) {
            duplicates++;
            continue;
          }

          const saved = createProxyAndEnqueue({
            id: generateId(),
            ip: parsed.ip,
            port: parsed.port,
            protocol,
            username: parsed.username || '',
            password: parsed.password || '',
            extra: parsed.extra || {},
            source: chunk.source_type === 'subscription' ? 'subscription' : 'import',
            sourceRef: chunk.source_ref || '',
            tags: [],
            groupName: chunk.group_name || '',
            notes: parsed.name || '',
          }, chunk.source_type === 'subscription' ? 'subscription_import' : 'bulk_import');
          if (saved.inserted) imported++; else duplicates++;

          if ((index + 1) % 50 === 0) {
            wakeConnectivityWorker();
            await new Promise(resolve => setImmediate(resolve));
          }
        }
        if (imported > 0) wakeConnectivityWorker();

        updateImportChunk(chunk.id, { status: 'done', imported, duplicates, errors });
        const task = getImportTask(chunk.task_id);
        const taskState = getImportTaskState(chunk.task_id);
        if (task) {
          updateImportSummary(chunk.task_id, {
            imported: (task.imported || 0) + imported,
            duplicates: (task.duplicates || 0) + duplicates,
            errors: (task.errors || 0) + errors,
            status: taskState.terminal ? (taskState.hasErrors ? 'error' : 'done') : 'processing',
          });
        }
        console.log(`[IMPORT] Chunk done: ${imported} imported, ${duplicates} dupes, ${errors} errors`);
        await new Promise(resolve => setImmediate(resolve));
      } catch (error) {
        const message = String(error.message || '导入失败').slice(0, 240);
        updateImportChunk(chunk.id, { status: 'error', error_msg: message });
        updateImportSummary(chunk.task_id, { status: 'error' });
        console.error('[IMPORT] Error:', message);
      }
    }
  } finally {
    importQueueProcessing = false;
    if (getNextPendingChunk()) queueMicrotask(() => processImportQueue());
  }
}
