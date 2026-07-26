import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { initDb } from './db.js';
import { setupCron } from './services/scheduler.js';
import { requireAuth } from './middleware/auth.js';
import { requireApiKey } from './middleware/apikey.js';
import { setupAuthRoutes } from './routes/auth.js';
import { setupProxyRoutes } from './routes/proxies.js';
import { setupImportRoutes } from './routes/import.js';
import { setupStatsRoutes } from './routes/stats.js';
import { setupSettingsRoutes } from './routes/settings.js';
import { setupCronRoutes } from './routes/cron.js';
import { setupExternalApiRoutes } from './routes/external-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ─────────────────────────────────────────────────────────────

// Bulk imports can contain thousands of proxy lines; keep a bounded but practical request limit.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

// ─── Database Init ──────────────────────────────────────────────────────────

initDb();

// ─── Static Files ────────────────────────────────────────────────────────────

// Serve static assets (lucide.min.js, etc.) — exclude dashboard.html (needs auth)
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

// Serve dashboard.html for all page routes (SPA)
const dashboardHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');

// ─── Routes ──────────────────────────────────────────────────────────────────

// Container health check (does not expose application data).
app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true });
});

// Auth routes (public)
setupAuthRoutes(app);

// External API routes (API key auth)
app.use('/api/v1', requireApiKey);
setupExternalApiRoutes(app);

// Internal API routes (session auth)
app.use('/api', requireAuth);
setupProxyRoutes(app);
setupImportRoutes(app);
setupStatsRoutes(app);
setupSettingsRoutes(app);
setupCronRoutes(app);

// Dashboard page — always serve, let frontend JS check token
app.get('/', (req, res) => {
  res.send(dashboardHtml);
});

// ─── Start Server ──────────────────────────────────────────────────────────

setupCron();

app.listen(PORT, () => {
  console.log(`[Proxy Pool Manager] Running on http://localhost:${PORT}`);
});