import { getCronState, setCronState } from '../db.js';
import { runScheduledTasks } from '../services/scheduler.js';
import { isSameOriginRequest } from '../utils/helpers.js';

export function setupCronRoutes(app) {
  // GET /api/cron/status
  app.get('/api/cron/status', (req, res) => {
    const state = getCronState();
    res.json({
      status: state.status,
      lastRunAt: state.last_run_at,
      lastClassifyAt: state.last_classify_at,
      lastTestAt: state.last_test_at,
      classifyCount: state.classify_count,
      testCount: state.test_count,
      error: state.error,
    });
  });

  // POST /api/cron/trigger
  app.post('/api/cron/trigger', (req, res) => {
    if (!isSameOriginRequest(req)) return res.status(403).json({ error: 'Forbidden' });

    // Run in background
    runScheduledTasks().catch(e => console.error('[cron-trigger] Error:', e.message));
    res.json({ ok: true, message: 'Cron triggered' });
  });
}
