import { computeStats } from '../db.js';

export function setupStatsRoutes(app) {
  // GET /api/stats
  app.get('/api/stats', (req, res) => {
    const stats = computeStats();
    // Convert snake_case keys to camelCase for API compatibility
    res.json({
      total: stats.total,
      alive: stats.alive,
      dead: stats.dead,
      untested: stats.untested,
      byType: stats.byType,
      byProtocol: stats.byProtocol,
      byCountry: stats.byCountry,
      lastCronRun: stats.lastCronRun,
      updatedAt: stats.updatedAt,
    });
  });
}
