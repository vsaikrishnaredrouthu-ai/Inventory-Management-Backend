const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');
const { query } = require('../db');
const { HttpError, wrap, validate, z, passwordRule, emptyToNull } = require('../utils/helpers');
const { authenticate, permissionsForRole } = require('../middleware/auth');
const { logActivity } = require('../services/activity');

const router = express.Router();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function loadUser(id) {
  const { rows } = await query(
    `SELECT u.user_id, u.full_name, u.username, u.email, u.phone, u.is_active, u.role_id,
            u.preferences, u.last_login_at, u.created_at, r.role_key, r.role_name
     FROM users u JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = $1`,
    [id]
  );
  const user = rows[0];
  if (!user) return null;
  user.permissions = await permissionsForRole(user.role_id);
  return user;
}

// POST /api/auth/login  — email or username + password
router.post(
  '/login',
  validate(z.object({
    identifier: z.string().trim().min(1).max(200),
    password: z.string().min(1).max(200),
    remember: z.boolean().optional(),
  })),
  wrap(async (req, res) => {
    const { identifier, password, remember } = req.body;
    const { rows } = await query(
      `SELECT user_id, password_hash, is_active FROM users
       WHERE lower(email) = lower($1) OR lower(username) = lower($1)`,
      [identifier]
    );
    const row = rows[0];
    const ok = row && (await bcrypt.compare(password, row.password_hash));
    if (!ok) throw new HttpError(401, 'Incorrect email/username or password');
    if (!row.is_active) throw new HttpError(403, 'This account has been deactivated. Contact the Owner.');

    await query('UPDATE users SET last_login_at = now() WHERE user_id = $1', [row.user_id]);
    const token = jwt.sign({ sub: row.user_id }, config.jwtSecret, {
      expiresIn: remember ? config.jwtRememberExpires : config.jwtExpires,
    });
    const user = await loadUser(row.user_id);
    await logActivity(null, 'login', 'user', row.user_id, null, row.user_id);
    res.json({ token, user });
  })
);

router.post('/logout', authenticate, wrap(async (req, res) => {
  await logActivity(req, 'logout', 'user', req.user.user_id);
  res.json({ ok: true });
}));

router.get('/me', authenticate, wrap(async (req, res) => {
  res.json({ user: await loadUser(req.user.user_id) });
}));

router.put(
  '/profile',
  authenticate,
  validate(z.object({
    full_name: z.string().trim().min(2).max(120),
    email: z.string().trim().email(),
    username: z.string().regex(/^[a-zA-Z0-9_.]{3,30}$/, '3-30 letters, numbers, dots or underscores').nullable().optional(),
    phone: z.string().max(30).nullable().optional(),
  })),
  wrap(async (req, res) => {
    const b = req.body;
    await query(
      `UPDATE users SET full_name = $1, email = $2, username = $3, phone = $4, updated_at = now()
       WHERE user_id = $5`,
      [b.full_name, b.email, emptyToNull(b.username), emptyToNull(b.phone), req.user.user_id]
    );
    await logActivity(req, 'profile.update', 'user', req.user.user_id);
    res.json({ user: await loadUser(req.user.user_id) });
  })
);

router.put(
  '/preferences',
  authenticate,
  validate(z.object({
    theme: z.enum(['system', 'light', 'dark']).optional(),
    low_stock_alerts: z.boolean().optional(),
  })),
  wrap(async (req, res) => {
    await query(`UPDATE users SET preferences = preferences || $1::jsonb WHERE user_id = $2`,
      [JSON.stringify(req.body), req.user.user_id]);
    res.json({ user: await loadUser(req.user.user_id) });
  })
);

router.post(
  '/change-password',
  authenticate,
  validate(z.object({ current_password: z.string().min(1), new_password: passwordRule })),
  wrap(async (req, res) => {
    const { rows } = await query('SELECT password_hash FROM users WHERE user_id = $1', [req.user.user_id]);
    if (!(await bcrypt.compare(req.body.current_password, rows[0].password_hash))) {
      throw new HttpError(400, 'Your current password is not correct');
    }
    const hash = await bcrypt.hash(req.body.new_password, 10);
    await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE user_id = $2', [hash, req.user.user_id]);
    await logActivity(req, 'password.change', 'user', req.user.user_id);
    res.json({ ok: true });
  })
);

// Password reset without email: the token is shown in the server console (and
// returned in the response outside production so the demo works end to end).
// Replace with an email provider before going live.
router.post(
  '/forgot-password',
  validate(z.object({ email: z.string().trim().email() })),
  wrap(async (req, res) => {
    const { rows } = await query('SELECT user_id, is_active FROM users WHERE lower(email) = lower($1)', [req.body.email]);
    let devToken;
    if (rows[0] && rows[0].is_active) {
      const token = crypto.randomBytes(24).toString('hex');
      await query(
        `UPDATE users SET reset_token_hash = $1, reset_token_expires = now() + interval '30 minutes' WHERE user_id = $2`,
        [sha256(token), rows[0].user_id]
      );
      console.log(`[password-reset] token for ${req.body.email}: ${token}`);
      if (!config.isProd) devToken = token;
    }
    res.json({
      message: 'If that email is registered, a reset link has been sent. The link expires in 30 minutes.',
      ...(devToken ? { dev_token: devToken } : {}),
    });
  })
);

router.post(
  '/reset-password',
  validate(z.object({ token: z.string().min(10), password: passwordRule })),
  wrap(async (req, res) => {
    const { rows } = await query(
      `SELECT user_id FROM users WHERE reset_token_hash = $1 AND reset_token_expires > now()`,
      [sha256(req.body.token)]
    );
    if (!rows[0]) throw new HttpError(400, 'This reset link is invalid or has expired');
    const hash = await bcrypt.hash(req.body.password, 10);
    await query(
      `UPDATE users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL, updated_at = now()
       WHERE user_id = $2`,
      [hash, rows[0].user_id]
    );
    await logActivity(null, 'password.reset', 'user', rows[0].user_id, null, rows[0].user_id);
    res.json({ ok: true });
  })
);

module.exports = router;
