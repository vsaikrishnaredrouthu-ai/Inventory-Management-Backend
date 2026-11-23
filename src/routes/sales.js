const express = require('express');
const { query, tx } = require('../db');
const { HttpError, wrap, validate, z, paging, like } = require('../utils/helpers');
const { authenticate, requirePerm } = require('../middleware/auth');
const { createOrder } = require('../services/orders');
const { alertLowStock } = require('../services/notify');
const { logActivity } = require('../services/activity');

const router = express.Router();
router.use(authenticate);

router.get('/', requirePerm('sales.read'), wrap(async (req, res) => {
  const { page, limit, offset } = paging(req);
  const conds = [];
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  if (req.query.payment_method) conds.push(`s.payment_method = ${add(req.query.payment_method)}`);
  if (req.query.q) conds.push(`o.customer_name ILIKE ${add(like(req.query.q))}`);
  if (req.query.from) conds.push(`s.created_at::date >= ${add(req.query.from)}`);
  if (req.query.to) conds.push(`s.created_at::date <= ${add(req.query.to)}`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const base = `FROM sales s JOIN orders o ON o.order_id = s.order_id
                LEFT JOIN users u ON u.user_id = s.sold_by ${where}`;
  const total = await query(`SELECT COUNT(*)::int AS n ${base}`, params);
  const items = await query(
    `SELECT s.*, o.customer_name, o.total_amount, u.full_name AS sold_by_name
     ${base} ORDER BY s.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  res.json({ items: items.rows, total: total.rows[0].n, page, limit });
}));

// Quick sale: creates a completed order, takes the stock out and records payment.
router.post(
  '/',
  requirePerm('sales.write'),
  validate(z.object({
    customer_name: z.string().trim().max(120).optional(),
    customer_phone: z.string().max(30).nullable().optional(),
    payment_method: z.enum(['cash', 'card', 'upi', 'bank_transfer']),
    amount_paid: z.number().min(0).max(100000000),
    notes: z.string().max(500).nullable().optional(),
    items: z.array(z.object({
      product_id: z.number().int().positive(),
      quantity: z.number().int().positive().max(1000000),
      unit_price: z.number().min(0).optional(),
    })).min(1, 'Add at least one product'),
  })),
  wrap(async (req, res) => {
    const b = req.body;
    const result = await tx(async (client) => {
      const order = await createOrder(client, { ...b, userId: req.user.user_id, status: 'completed' });
      if (b.amount_paid + 0.001 < order.total) {
        throw new HttpError(400, `Amount paid (${b.amount_paid}) is less than the total (${order.total})`);
      }
      await client.query(
        `INSERT INTO sales (order_id, sold_by, payment_method, amount_paid) VALUES ($1,$2,$3,$4)`,
        [order.orderId, req.user.user_id, b.payment_method, b.amount_paid]);
      return order;
    });
    await logActivity(req, 'sale.create', 'order', result.orderId, { total: result.total });
    for (const pid of result.productIds) await alertLowStock(pid);
    res.status(201).json({ order_id: result.orderId, total: result.total });
  })
);

module.exports = router;
