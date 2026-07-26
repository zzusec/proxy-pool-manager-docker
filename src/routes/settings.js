import { getSetting, setSetting, getAdminSettings, setAdminSettings } from '../db.js';
import { hashPassword, secureEqual } from '../utils/crypto.js';
import { isSameOriginRequest } from '../utils/helpers.js';

export function setupSettingsRoutes(app) {
  // GET /api/settings/system
  app.get('/api/settings/system', (req, res) => {
    const checkInterval = parseInt(getSetting('checkInterval')) || 600;
    const autoClassify = getSetting('autoClassify') !== 'false';
    const testerConfigured = !!process.env.TESTER_URL;
    // Docker version always has built-in testing
    const builtInTester = true;
    res.json({ checkInterval, autoClassify, testerConfigured: testerConfigured || builtInTester, builtInTester });
  });

  // POST /api/settings/system
  app.post('/api/settings/system', (req, res) => {
    if (!isSameOriginRequest(req)) return res.status(403).json({ error: 'Forbidden' });

    const { checkInterval, autoClassify } = req.body;
    if (checkInterval !== undefined) setSetting('checkInterval', String(parseInt(checkInterval) || 600));
    if (autoClassify !== undefined) setSetting('autoClassify', String(!!autoClassify));
    res.json({ ok: true });
  });

  // POST /api/account/password
  app.post('/api/account/password', async (req, res) => {
    if (!isSameOriginRequest(req)) return res.status(403).json({ error: 'Forbidden' });

    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: '请填写所有字段' });

    // Verify current password
    const adminSettings = getAdminSettings();
    const secret = process.env.SESSION_SECRET;

    if (adminSettings.passwordHash) {
      const hash = hashPassword(currentPassword, secret);
      if (!secureEqual(hash, adminSettings.passwordHash)) {
        return res.status(400).json({ error: '当前密码错误' });
      }
    } else {
      if (!secureEqual(currentPassword, process.env.ADMIN_PASSWORD)) {
        return res.status(400).json({ error: '当前密码错误' });
      }
    }

    if (confirmPassword && newPassword !== confirmPassword) {
      return res.status(400).json({ error: '两次输入的新密码不一致' });
    }

    // Store new password hash
    const newHash = hashPassword(newPassword, secret);
    setAdminSettings({ ...adminSettings, passwordHash: newHash });
    res.json({ ok: true });
  });
}
