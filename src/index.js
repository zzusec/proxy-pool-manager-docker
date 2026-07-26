import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { initDb } from './db.js';
import { setupCron } from './services/scheduler.js';
import { requireAuth, requireAuthOrRedirect } from './middleware/auth.js';
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

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Database Init ──────────────────────────────────────────────────────────

initDb();

// ─── Static Files ────────────────────────────────────────────────────────────

// Serve static assets (lucide.min.js, etc.) — exclude dashboard.html (needs auth)
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

// Serve dashboard.html for all page routes (SPA)
const dashboardHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');

// ─── Routes ──────────────────────────────────────────────────────────────────

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

// Dashboard page (session auth)
app.get('/', requireAuthOrRedirect, (req, res) => {
  res.send(dashboardHtml);
});

// ─── Start Server ──────────────────────────────────────────────────────────

setupCron();

app.listen(PORT, () => {
  console.log(`[Proxy Pool Manager] Running on http://localhost:${PORT}`);
});