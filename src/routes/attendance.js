const express = require('express');
const { query } = require('../db');
const { HttpError, wrap } = require('../utils/helpers');
const { authenticate, requirePerm } = require('../middleware/auth');

// Owner check-in / check-out. Events are stored in activity_logs (no separate table).
// One day can have many sessions: check in, check out, check in again, and so on.
const router = express.Router();
router.use(authenticate, requirePerm('users.manage'));

const DAY = "(created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date";

async function todayState(userId) {
  const { rows } = await query(
    `SELECT action, created_at FROM activity_logs
     WHERE user_id = $1 AND action IN ('check_in', 'check_out') AND ${DAY}
     ORDER BY created_at`,
    [userId]
  );
  // Pair each check_in with the check_out that closes it.
  const sessions = [];
  let open = null;
  for (const r of rows) {
    if (r.action === 'check_in' && !open) open = r.created_at;
    else if (r.action === 'check_out' && open) {
      sessions.push({ check_in: open, check_out: r.created_at });
      open = null;
    }
  }
  if (open) sessions.push({ check_in: open, check_out: null });

  const closed = sessions.filter((s) => s.check_out);
  const minutes = Math.round(
    closed.reduce((sum, s) => sum + (new Date(s.check_out) - new Date(s.check_in)), 0) / 60000
  );
  const last = sessions[sessions.length - 1] || null;
  return {
    check_in: last ? last.check_in : null,   // start of the latest session
    check_out: last ? last.check_out : null, // end of the latest session (null while working)
    working: !!open,                         // true when checked in and not yet checked out
    sessions: sessions.length,
    minutes,                                 // total minutes worked today (closed sessions)
  };
}

router.get('/today', wrap(async (req, res) => {
  res.json({ item: await todayState(req.user.user_id) });
}));

router.post('/check-in', wrap(async (req, res) => {
  const state = await todayState(req.user.user_id);
  if (state.working) throw new HttpError(409, 'You are already checked in. Check out first.');
  await query(
    `INSERT INTO activity_logs (user_id, action, entity, ip_address) VALUES ($1, 'check_in', 'attendance', $2)`,
    [req.user.user_id, req.ip || null]
  );
  res.status(201).json({ item: await todayState(req.user.user_id) });
}));

router.post('/check-out', wrap(async (req, res) => {
  const state = await todayState(req.user.user_id);
  if (!state.working) throw new HttpError(409, 'Check in first');
  await query(
    `INSERT INTO activity_logs (user_id, action, entity, ip_address) VALUES ($1, 'check_out', 'attendance', $2)`,
    [req.user.user_id, req.ip || null]
  );
  res.json({ item: await todayState(req.user.user_id) });
}));

module.exports = router;
