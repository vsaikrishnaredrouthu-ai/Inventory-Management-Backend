const express = require('express');
const { query } = require('../db');
const { HttpError, wrap, toCsv } = require('../utils/helpers');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Work days follow India time, so a check-in late at night is recorded on the right day.
const TODAY = "(now() AT TIME ZONE 'Asia/Kolkata')::date";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const seesEveryone = (req) => req.user.permissions.includes('users.manage');

const SELECT = `
  SELECT a.shift_id, a.user_id, u.full_name, a.work_date, a.check_in, a.check_out,
         CASE WHEN a.check_out IS NULL THEN NULL
              ELSE ROUND((EXTRACT(EPOCH FROM (a.check_out - a.check_in)) / 3600)::numeric, 2)
         END AS hours
  FROM work_shifts a JOIN users u ON u.user_id = a.user_id`;

function listFilters(req) {
  const params = [];
  const conds = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  if (seesEveryone(req)) {
    if (req.query.user_id) conds.push(`a.user_id = ${add(Number(req.query.user_id))}`);
  } else {
    conds.push(`a.user_id = ${add(req.user.user_id)}`);
  }
  if (req.query.from) {
    if (!DATE_RE.test(req.query.from)) throw new HttpError(400, 'Use the from date as YYYY-MM-DD');
    conds.push(`a.work_date >= ${add(req.query.from)}`);
  }
  if (req.query.to) {
    if (!DATE_RE.test(req.query.to)) throw new HttpError(400, 'Use the to date as YYYY-MM-DD');
    conds.push(`a.work_date <= ${add(req.query.to)}`);
  }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

// Today's record for the signed-in user (null if not checked in yet).
router.get('/today', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT shift_id, work_date, check_in, check_out FROM work_shifts
     WHERE user_id = $1 AND work_date = ${TODAY}`, [req.user.user_id]);
  res.json({ item: rows[0] || null });
}));

router.post('/check-in', wrap(async (req, res) => {
  const { rows } = await query(
    `INSERT INTO work_shifts (user_id, work_date) VALUES ($1, ${TODAY})
     ON CONFLICT (user_id, work_date) DO NOTHING RETURNING shift_id, work_date, check_in, check_out`,
    [req.user.user_id]);
  if (!rows.length) throw new HttpError(409, 'You have already checked in today');
  res.status(201).json({ item: rows[0] });
}));

router.post('/check-out', wrap(async (req, res) => {
  const { rows } = await query(
    `UPDATE work_shifts SET check_out = now()
     WHERE user_id = $1 AND work_date = ${TODAY} AND check_out IS NULL
     RETURNING shift_id, work_date, check_in, check_out`,
    [req.user.user_id]);
  if (!rows.length) throw new HttpError(409, 'Check in first, or you have already checked out today');
  res.json({ item: rows[0] });
}));

// Owner sees everyone (optionally one person); other staff see only their own records.
router.get('/', wrap(async (req, res) => {
  const { where, params } = listFilters(req);
  const { rows } = await query(`${SELECT} ${where} ORDER BY a.work_date DESC, u.full_name LIMIT 500`, params);
  res.json({ items: rows, total: rows.length });
}));

router.get('/export', wrap(async (req, res) => {
  const { where, params } = listFilters(req);
  const { rows } = await query(`${SELECT} ${where} ORDER BY a.work_date DESC, u.full_name`, params);
  const csv = toCsv([
    { key: 'full_name', label: 'Name' },
    { key: 'work_date', label: 'Date' },
    { key: 'check_in', label: 'Check in' },
    { key: 'check_out', label: 'Check out' },
    { key: 'hours', label: 'Hours' },
  ], rows);
  res.attachment('work_shifts.csv').send(csv);
}));

module.exports = router;
