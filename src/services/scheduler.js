import cron from 'node-cron';
import { getUnclassifiedProxies, getProxiesToTest, upsertProxy, getCronState, setCronState, computeStats, getNextPendingChunk, updateImportChunk, updateImportSummary, proxyExists, getSetting } from '../db.js';
import { batchClassify } from './classifier.js';
import { testProxies } from './tester.js';
import { parseProxyLine, generateId } from '../utils/helpers.js';

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

  // Resume queued imports immediately after a container restart.
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

    // Task 2: Test proxies
    const checkInterval = parseInt(getSetting('checkInterval')) || 600;
    const autoTestEnabled = getSetting('autoTestEnabled') !== 'false';
    const testBatchSize = Math.max(1, Math.min(parseInt(getSetting('testBatchSize')) || 20, 1000));
    const toTest = autoTestEnabled ? getProxiesToTest(checkInterval, testBatchSize) : [];
    if (toTest.length > 0) {
      console.log(`[CRON] Testing ${toTest.length} proxies...`);
      const result = await testProxies(toTest);
      if (result.results) {
        for (const r of result.results) {
          if (!r.id || (r.alive !== true && r.alive !== false)) continue;
          const proxy = toTest.find(p => p.id === r.id);
          if (proxy) {
            proxy.alive = r.alive;
            proxy.exitIp = r.exitIp || null;
            proxy.responseTime = r.responseTime || null;
            proxy.anonymity = r.anonymity || null;
            proxy.lastCheckAt = new Date().toISOString();
            proxy.updatedAt = new Date().toISOString();
            upsertProxy(proxy);
          }
        }
        setCronState({
          test_count: toTest.length,
          last_test_at: new Date().toISOString(),
        });
        console.log(`[CRON] Tested ${toTest.length} proxies`);
      }
    } else {
      setCronState({ test_count: 0 });
    }

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

export async function processImportQueue() {
  const chunk = getNextPendingChunk();
  if (!chunk) return;

  updateImportChunk(chunk.id, { status: 'processing' });

  try {
    const lines = chunk.raw_text.split(/\r?\n/).filter(l => l.trim());
    let imported = 0, duplicates = 0, errors = 0;

    for (const line of lines) {
      const parsed = parseProxyLine(line);
      if (!parsed) { errors++; continue; }

      if (chunk.skip_duplicates && proxyExists(parsed.ip, parsed.port, parsed.protocol || chunk.protocol)) {
        duplicates++;
        continue;
      }

      const proxy = {
        id: generateId(),
        ip: parsed.ip,
        port: parsed.port,
        protocol: parsed.protocol || chunk.protocol,
        username: parsed.username || '',
        password: parsed.password || '',
        source: 'import',
        tags: [],
        groupName: chunk.group_name || '',
        notes: '',
      };

      upsertProxy(proxy);
      imported++;
    }

    updateImportChunk(chunk.id, { status: 'done', imported, duplicates, errors });

    // Update summary
    const { getImportQueue } = await import('../db.js');
    const queueData = getImportQueue();
    const task = queueData.tasks.find(t => t.taskId === chunk.task_id);
    if (task) {
      const allChunksDone = !getNextPendingChunk(); // simplified check
      updateImportSummary(chunk.task_id, {
        imported: (task.imported || 0) + imported,
        duplicates: (task.duplicates || 0) + duplicates,
        errors: (task.errors || 0) + errors,
        status: allChunksDone ? 'done' : 'processing',
      });
    }

    console.log(`[IMPORT] Chunk done: ${imported} imported, ${duplicates} dupes, ${errors} errors`);

    // Process next chunk immediately
    await processImportQueue();
  } catch (e) {
    updateImportChunk(chunk.id, { status: 'error', error_msg: e.message });
    updateImportSummary(chunk.task_id, { status: 'error' });
    console.error('[IMPORT] Error:', e.message);
  }
}
