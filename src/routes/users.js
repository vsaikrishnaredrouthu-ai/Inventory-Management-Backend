const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { HttpError, wrap, validate, z, passwordRule, paging, like, emptyToNull } = require('../utils/helpers');
const { authenticate, requirePerm } = require('../middleware/auth');
const { logActivity } = require('../services/activity');
const { notifyUser } = require('../services/notify');

// Owner-only: every route in this file needs users.manage.
const router = express.Router();
router.use(authenticate, requirePerm('users.manage'));

const ROLE_KEYS = ['owner', 'product_manager', 'sales_manager', 'stock_manager', 'purchase_manager', 'order_manager'];
const roleKey = z.enum(ROLE_KEYS);
const username = z.string().regex(/^[a-zA-Z0-9_.]{3,30}$/, '3-30 letters, numbers, dots or underscores');

async function roleFor(key) {
  const { rows } = await query('SELECT role_id, role_key, role_name FROM roles WHERE role_key = $1', [key]);
  if (!rows[0]) throw new HttpError(400, 'Unknown role');
  return rows[0];
}

router.get('/roles', wrap(async (_req, res) => {
  const { rows } = await query('SELECT role_id, role_key, role_name, description FROM roles ORDER BY role_id');
  res.json({ items: rows });
}));

router.get('/', wrap(async (req, res) => {
  const { page, limit, offset } = paging(req);
  const conds = [];
  const params = [];
  if (req.query.q) {
    params.push(like(req.query.q));
    const p = `$${params.length}`;
    conds.push(`(u.full_name ILIKE ${p} OR u.email ILIKE ${p} OR u.username ILIKE ${p})`);
  }
  if (req.query.role) { params.push(req.query.role); conds.push(`r.role_key = $${params.length}`); }
  if (req.query.status === 'active') conds.push('u.is_active');
  if (req.query.status === 'inactive') conds.push('NOT u.is_active');
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const base = `FROM users u JOIN roles r ON r.role_id = u.role_id ${where}`;

  const total = await query(`SELECT COUNT(*)::int AS n ${base}`, params);
  const items = await query(
    `SELECT u.user_id, u.full_name, u.username, u.email, u.phone, u.is_active, u.last_login_at, u.created_at,
            r.role_key, r.role_name ${base} ORDER BY u.full_name LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  res.json({ items: items.rows, total: total.rows[0].n, page, limit });
}));

router.post(
  '/',
  validate(z.object({
    full_name: z.string().trim().min(2).max(120),
    email: z.string().trim().email(),
    username: username.nullable().optional(),
    phone: z.string().max(30).nullable().optional(),
    role_key: roleKey,
    password: passwordRule,
  })),
  wrap(async (req, res) => {
    const b = req.body;
    const role = await roleFor(b.role_key);
    const hash = await bcrypt.hash(b.password, 10);
    const { rows } = await query(
      `INSERT INTO users (full_name, email, username, phone, role_id, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING user_id`,
      [b.full_name, b.email, emptyToNull(b.username), emptyToNull(b.phone), role.role_id, hash]
    );
    await logActivity(req, 'user.create', 'user', rows[0].user_id, { email: b.email, role: b.role_key });
    await notifyUser(rows[0].user_id, {
      title: 'Welcome to Inventory Management',
      message: `Your ${role.role_name} account is ready. Please change your password after your first login.`,
      link: '/profile',
    });
    res.status(201).json({ user_id: rows[0].user_id });
  })
);

router.put(
  '/:id',
  validate(z.object({
    full_name: z.string().trim().min(2).max(120).optional(),
    email: z.string().trim().email().optional(),
    username: username.nullable().optional(),
    phone: z.string().max(30).nullable().optional(),
  })),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const allowed = ['full_name', 'email', 'username', 'phone'];
    const keys = allowed.filter((k) => req.body[k] !== undefined);
    if (!keys.length) throw new HttpError(400, 'Nothing to update');
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const params = keys.map((k) => emptyToNull(req.body[k]));
    params.push(id);
    const { rowCount } = await query(
      `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $${params.length}`,
      params
    );
    if (!rowCount) throw new HttpError(404, 'User not found');
    await logActivity(req, 'user.update', 'user', id, { fields: keys });
    res.json({ ok: true });
  })
);

// Role change: the user's permissions come from their single role, so the old
// role's access is removed and the new role's access applies on their next request.
router.put(
  '/:id/role',
  validate(z.object({ role_key: roleKey })),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await query(
      `SELECT r.role_key FROM users u JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = $1`, [id]
    );
    if (!rows[0]) throw new HttpError(404, 'User not found');
    if (id === req.user.user_id && req.body.role_key !== 'owner') {
      throw new HttpError(400, 'You cannot remove your own Owner access');
    }
    const role = await roleFor(req.body.role_key);
    await query('UPDATE users SET role_id = $1, updated_at = now() WHERE user_id = $2', [role.role_id, id]);
    await logActivity(req, 'user.role_change', 'user', id, { from: rows[0].role_key, to: role.role_key });
    await notifyUser(id, { title: 'Your role was updated', message: `You now have the ${role.role_name} role.`, link: '/' });
    res.json({ ok: true });
  })
);

router.post(
  '/:id/status',
  validate(z.object({ is_active: z.boolean() })),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.user_id && !req.body.is_active) {
      throw new HttpError(400, 'You cannot deactivate your own account');
    }
    const { rowCount } = await query('UPDATE users SET is_active = $1, updated_at = now() WHERE user_id = $2',
      [req.body.is_active, id]);
    if (!rowCount) throw new HttpError(404, 'User not found');
    await logActivity(req, req.body.is_active ? 'user.activate' : 'user.deactivate', 'user', id);
    res.json({ ok: true });
  })
);

router.post(
  '/:id/reset-password',
  validate(z.object({ password: passwordRule })),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const hash = await bcrypt.hash(req.body.password, 10);
    const { rowCount } = await query(
      `UPDATE users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL, updated_at = now()
       WHERE user_id = $2`,
      [hash, id]
    );
    if (!rowCount) throw new HttpError(404, 'User not found');
    await logActivity(req, 'user.password_reset', 'user', id);
    await notifyUser(id, { title: 'Your password was reset by the Owner', message: 'Please log in with the new password.' });
    res.json({ ok: true });
  })
);

module.exports = router;
