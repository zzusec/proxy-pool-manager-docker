import { createSessionToken, verifyAdminPassword } from '../utils/crypto.js';
import { escapeHtml } from '../utils/helpers.js';

export function setupAuthRoutes(app) {
  // GET /login
  app.get('/login', (req, res) => {
    const error = req.query.error || '';
    const errorHtml = error ? `<p class="login-error">${escapeHtml(error)}</p>` : '';
    res.send(loginPageHtml(errorHtml));
  });

  // POST /login — browser clients use the returned bearer token for API requests.
  app.post('/login', express.json(), async (req, res) => {
    const { username, password } = req.body;
    res.set('Cache-Control', 'no-store');

    if (username !== process.env.ADMIN_USERNAME || !await verifyAdminPassword(password)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    return res.json({ ok: true, token: createSessionToken() });
  });
}

import express from 'express';

function loginPageHtml(errorHtml = '') {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>代理池管理 - 登录</title><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f5f5;color:#333;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}.login-card{background:#fff;border-radius:8px;padding:40px 36px;width:100%;max-width:360px;box-shadow:0 2px 12px rgba(0,0,0,.08)}.login-title{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:32px;font-size:20px;font-weight:600;color:#333}.login-icon{width:22px;height:22px;color:#07c160}.login-label{display:block;margin-bottom:6px;font-size:13px;color:#999;font-weight:400}.login-input{width:100%;padding:10px 12px;background:#f5f5f5;border:1px solid #e5e5e5;border-radius:6px;color:#333;font-size:14px;margin-bottom:20px;outline:none;transition:border-color .2s}.login-input:focus{border-color:#07c160;background:#fff}.login-btn{width:100%;padding:10px;background:#07c160;color:#fff;border:none;border-radius:6px;font-size:15px;cursor:pointer;font-weight:500;transition:background .2s}.login-btn:hover{background:#06ad56}.login-btn:disabled{background:#a0a0a0;cursor:not-allowed}.login-error{color:#fa5151;text-align:center;margin-bottom:16px;font-size:13px;padding:8px;background:#fff2f0;border-radius:6px}</style></head><body><div class="login-card"><h1 class="login-title"><svg class="login-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> 代理池管理</h1>${errorHtml}<form id="loginForm"><label class="login-label" for="username">用户名</label><input class="login-input" type="text" id="username" name="username" autocomplete="username" required autofocus><label class="login-label" for="password">密码</label><input class="login-input" type="password" id="password" name="password" autocomplete="current-password" required><button class="login-btn" type="submit">登 录</button></form></div><script>
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const btn = document.querySelector('.login-btn');
  btn.disabled = true;
  btn.textContent = '登录中...';
  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) {
      const errEl = document.querySelector('.login-error') || document.createElement('p');
      errEl.className = 'login-error';
      errEl.textContent = data.error || '登录失败';
      if (!document.querySelector('.login-error')) document.querySelector('.login-title').after(errEl);
      btn.disabled = false;
      btn.textContent = '登 录';
      return;
    }
    localStorage.setItem('proxy_pool_token', data.token);
    location.href = '/';
  } catch (err) {
    alert('登录失败: ' + err.message);
    btn.disabled = false;
    btn.textContent = '登 录';
  }
});
</script></body></html>`;
}
