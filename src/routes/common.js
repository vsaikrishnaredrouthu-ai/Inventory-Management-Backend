const express = require('express');
const { query } = require('../db');
const { HttpError, wrap, validate, z, paging, like } = require('../utils/helpers');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

/* ---------- Notifications ---------- */
router.get('/notifications', wrap(async (req, res) => {
  const { page, limit, offset } = paging(req);
  const unreadOnly = req.query.unread === '1' ? 'AND NOT is_read' : '';
  const items = await query(
    `SELECT * FROM notifications WHERE user_id = $1 ${unreadOnly}
     ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, [req.user.user_id]);
  const counts = await query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE NOT is_read)::int AS unread
     FROM notifications WHERE user_id = $1`, [req.user.user_id]);
  res.json({ items: items.rows, ...counts.rows[0], page, limit });
}));

router.post('/notifications/:id/read', wrap(async (req, res) => {
  await query('UPDATE notifications SET is_read = TRUE WHERE notification_id = $1 AND user_id = $2',
    [req.params.id, req.user.user_id]);
  res.json({ ok: true });
}));

router.post('/notifications/read-all', wrap(async (req, res) => {
  await query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND NOT is_read', [req.user.user_id]);
  res.json({ ok: true });
}));

/* ---------- Activity history (Owner sees everyone; others see their own) ---------- */
router.get('/activity', wrap(async (req, res) => {
  const { page, limit, offset } = paging(req);
  const isOwner = req.user.permissions.includes('users.manage');
  const params = [];
  const conds = [];
  if (!isOwner) { params.push(req.user.user_id); conds.push(`a.user_id = $${params.length}`); }
  if (req.query.q) { params.push(like(req.query.q)); conds.push(`(a.action ILIKE $${params.length} OR a.entity ILIKE $${params.length})`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const base = `FROM activity_logs a LEFT JOIN users u ON u.user_id = a.user_id ${where}`;
  const total = await query(`SELECT COUNT(*)::int AS n ${base}`, params);
  const items = await query(
    `SELECT a.log_id, a.action, a.entity, a.entity_id, a.details, a.ip_address, a.created_at, u.full_name AS user_name
     ${base} ORDER BY a.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  res.json({ items: items.rows, total: total.rows[0].n, page, limit });
}));

/* ---------- Help & support ---------- */
const FAQ = [
  { q: 'How do I log in?', a: 'Use your email or username with the password your Owner gave you. Tick "Remember me" to stay signed in for 30 days on this device.' },
  { q: 'I forgot my password. What now?', a: 'Use "Forgot password" on the login screen and follow the reset link. Links expire after 30 minutes.' },
  { q: 'Why can I not see some pages?', a: 'Each role only sees the modules assigned to it. Ask the Owner if you need access to something else.' },
  { q: 'How is stock updated?', a: 'Stock goes down when an order or sale is placed, and up when a purchase is received. Use the Stock page for manual stock in, stock out, damaged, expired and adjustments.' },
  { q: 'Why did I get a low-stock alert?', a: 'The quantity fell to or below the product reorder level. Alerts appear in Notifications.' },
  { q: 'Can I undo an order?', a: 'Cancelling a pending or processing order returns its stock automatically. Completed orders cannot be cancelled.' },
];

router.get('/help', wrap(async (_req, res) => {
  res.json({
    faq: FAQ,
    contact: { email: process.env.SUPPORT_EMAIL || 'support@example.com', hours: 'Mon-Sat, 9:00-18:00 IST' },
  });
}));

router.post('/support', validate(z.object({
  subject: z.string().trim().min(3).max(150),
  message: z.string().trim().min(10).max(2000),
})), wrap(async (req, res) => {
  const { rows } = await query(
    'INSERT INTO support_requests (user_id, subject, message) VALUES ($1,$2,$3) RETURNING request_id',
    [req.user.user_id, req.body.subject, req.body.message]);
  res.status(201).json({ request_id: rows[0].request_id });
}));

module.exports = router;
