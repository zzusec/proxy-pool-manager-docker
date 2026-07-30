#!/usr/bin/env node
import 'dotenv/config';
import { getAdminSettings, initDb, setAdminSettings } from '../src/db.js';
import { hashAdminPassword } from '../src/utils/crypto.js';

const confirmation = '--confirm-reset-admin-password';

if (!process.argv.includes(confirmation)) {
  console.error(`Refusing to reset the administrator password. Re-run with ${confirmation}.`);
  process.exit(1);
}

if (!process.env.ADMIN_PASSWORD) {
  console.error('Refusing to reset the administrator password: ADMIN_PASSWORD is required.');
  process.exit(1);
}

initDb();
const adminSettings = getAdminSettings();
const passwordHash = await hashAdminPassword(process.env.ADMIN_PASSWORD);
setAdminSettings({ ...adminSettings, passwordHash });
console.log('Administrator password reset completed. Existing sessions remain valid until they expire or SESSION_SECRET changes.');
