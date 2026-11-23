const express = require('express');
const { query, tx } = require('../db');
const { HttpError, wrap, validate, z, paging, isoDate } = require('../utils/helpers');
const { authenticate, requirePerm } = require('../middleware/auth');
const { applyStock } = require('../services/stock');
const { alertLowStock } = require('../services/notify');
const { logActivity } = require('../services/activity');

const router = express.Router();
router.use(authenticate);

const LEVEL_SELECT = `
  SELECT p.product_id, p.sku, p.product_name, p.quantity, p.reorder_level, p.expiry_date,
         p.cost_price, p.unit_price, p.is_active, c.category_name, s.supplier_name,
         (p.quantity * p.cost_price)::float AS stock_value,
         CASE WHEN p.quantity = 0 THEN 'out' WHEN p.quantity <= p.reorder_level THEN 'low' ELSE 'ok' END AS stock_status,
         (p.expiry_date IS NOT NULL AND p.expiry_date <= CURRENT_DATE + INTERVAL '30 days') AS expiring
  FROM products p
  LEFT JOIN categories c ON c.category_id = p.category_id
  LEFT JOIN suppliers s ON s.supplier_id = p.supplier_id`;

// Current stock levels with filters, plus totals for the header cards.
router.get('/levels', requirePerm('stock.read'), wrap(async (req, res) => {
  const { page, limit, offset } = paging(req);
  const conds = ['p.is_active'];
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  if (req.query.q) {
    const p = add(`%${req.query.q}%`);
    conds.push(`(p.product_name ILIKE ${p} OR p.sku ILIKE ${p})`);
  }
  if (req.query.category_id) conds.push(`p.category_id = ${add(Number(req.query.category_id))}`);
  if (req.query.filter === 'low') conds.push(`p.quantity <= p.reorder_level`);
  if (req.query.filter === 'out') conds.push('p.quantity = 0');
  if (req.query.filter === 'expiring') conds.push(`p.expiry_date IS NOT NULL AND p.expiry_date <= CURRENT_DATE + INTERVAL '30 days'`);
  const where = `WHERE ${conds.join(' AND ')}`;

  const total = await query(`SELECT COUNT(*)::int AS n FROM products p ${where}`, params);
  const items = await query(`${LEVEL_SELECT} ${where} ORDER BY stock_status, p.product_name LIMIT ${limit} OFFSET ${offset}`, params);
  const totals = await query(`
    SELECT COUNT(*)::int AS products,
           COUNT(*) FILTER (WHERE quantity = 0)::int AS out_of_stock,
           COUNT(*) FILTER (WHERE quantity > 0 AND quantity <= reorder_level)::int AS low_stock,
           COALESCE(SUM(quantity * cost_price), 0)::float AS stock_value
    FROM products WHERE is_active`);
  res.json({ items: items.rows, total: total.rows[0].n, page, limit, totals: totals.rows[0] });
}));

// Stock history (the Stock History table in the ER diagram).
router.get('/transactions', requirePerm('stock.read'), wrap(async (req, res) => {
  const { page, limit, offset } = paging(req);
  const conds = [];
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  if (req.query.product_id) conds.push(`t.product_id = ${add(Number(req.query.product_id))}`);
  if (req.query.type) conds.push(`t.transaction_type = ${add(req.query.type)}`);
  if (req.query.from) conds.push(`t.created_at::date >= ${add(req.query.from)}`);
  if (req.query.to) conds.push(`t.created_at::date <= ${add(req.query.to)}`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const base = `FROM stock_transactions t JOIN products p ON p.product_id = t.product_id
                LEFT JOIN users u ON u.user_id = t.user_id ${where}`;
  const total = await query(`SELECT COUNT(*)::int AS n ${base}`, params);
  const items = await query(
    `SELECT t.*, p.product_name, p.sku, u.full_name AS user_name ${base}
     ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  res.json({ items: items.rows, total: total.rows[0].n, page, limit });
}));

const MOVEMENT_TYPES = {
  stock_in: { sign: 1, label: 'Stock in' },
  stock_out: { sign: -1, label: 'Stock out' },
  damaged: { sign: -1, label: 'Damaged' },
  expired: { sign: -1, label: 'Expired' },
  adjustment: { sign: 0, label: 'Adjustment' },
};

const movementSchema = z.object({
  product_id: z.number().int().positive(),
  type: z.enum(['stock_in', 'stock_out', 'damaged', 'expired', 'adjustment']),
  quantity: z.number().int().positive().max(10000000).optional(),
  new_quantity: z.number().int().min(0).max(10000000).optional(),
  reason: z.string().max(300).nullable().optional(),
}).superRefine((d, ctx) => {
  if (d.type === 'adjustment' && d.new_quantity === undefined) {
    ctx.addIssue({ code: 'custom', message: 'Enter the counted quantity for an adjustment', path: ['new_quantity'] });
  }
  if (d.type !== 'adjustment' && d.quantity === undefined) {
    ctx.addIssue({ code: 'custom', message: 'Enter a quantity', path: ['quantity'] });
  }
});

router.post('/movements', requirePerm('stock.write'), validate(movementSchema), wrap(async (req, res) => {
  const b = req.body;
  const result = await tx(async (client) => {
    // Lock the row first so the change is computed from the current quantity.
    const cur = await client.query('SELECT quantity FROM products WHERE product_id = $1 FOR UPDATE', [b.product_id]);
    if (!cur.rows[0]) throw new HttpError(404, 'Product not found');
    let change;
    if (b.type === 'adjustment') {
      change = b.new_quantity - cur.rows[0].quantity;
      if (change === 0) throw new HttpError(400, 'The counted quantity matches the current stock. Nothing to change.');
    } else {
      change = MOVEMENT_TYPES[b.type].sign * b.quantity;
    }
    return applyStock(client, {
      productId: b.product_id, change, type: b.type, userId: req.user.user_id,
      reason: b.reason || MOVEMENT_TYPES[b.type].label,
    });
  });
  await logActivity(req, 'stock.move', 'product', b.product_id, { type: b.type, change: result.after - result.before });
  await alertLowStock(b.product_id);
  res.status(201).json({ product_id: b.product_id, before: result.before, after: result.after });
}));

module.exports = router;
