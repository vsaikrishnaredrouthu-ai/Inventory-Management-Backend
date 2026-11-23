const express = require('express');
const { query, tx } = require('../db');
const { HttpError, wrap, validate, z, paging, like, isoDate } = require('../utils/helpers');
const { authenticate, requirePerm } = require('../middleware/auth');
const { createOrder } = require('../services/orders');
const { applyStock } = require('../services/stock');
const { alertLowStock } = require('../services/notify');
const { logActivity } = require('../services/activity');

const router = express.Router();
router.use(authenticate);

const TRANSITIONS = {
  pending: ['processing', 'cancelled'],
  processing: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

const itemsSchema = z.array(z.object({
  product_id: z.number().int().positive(),
  quantity: z.number().int().positive().max(1000000),
  unit_price: z.number().min(0).optional(),
})).min(1, 'Add at least one product');

router.get('/', requirePerm('orders.read'), wrap(async (req, res) => {
  const { page, limit, offset } = paging(req);
  const conds = [];
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  if (req.query.status) conds.push(`o.status = ${add(req.query.status)}`);
  if (req.query.q) {
    const p = add(like(req.query.q));
    conds.push(`(o.customer_name ILIKE ${p} OR o.customer_phone ILIKE ${p} OR CAST(o.order_id AS TEXT) = ${add(String(req.query.q).replace(/\D/g, '') || '-1')})`);
  }
  if (req.query.from) conds.push(`o.created_at::date >= ${add(req.query.from)}`);
  if (req.query.to) conds.push(`o.created_at::date <= ${add(req.query.to)}`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const base = `FROM orders o LEFT JOIN users u ON u.user_id = o.created_by ${where}`;
  const total = await query(`SELECT COUNT(*)::int AS n ${base}`, params);
  const items = await query(
    `SELECT o.*, u.full_name AS created_by_name,
            (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.order_id) AS item_count
     ${base} ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  res.json({ items: items.rows, total: total.rows[0].n, page, limit });
}));

router.get('/:id', requirePerm('orders.read'), wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT o.*, u.full_name AS created_by_name, s.payment_method, s.amount_paid, s.created_at AS paid_at
     FROM orders o LEFT JOIN users u ON u.user_id = o.created_by
     LEFT JOIN sales s ON s.order_id = o.order_id WHERE o.order_id = $1`, [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Order not found');
  const items = await query(
    `SELECT oi.*, p.product_name, p.sku FROM order_items oi JOIN products p ON p.product_id = oi.product_id
     WHERE oi.order_id = $1 ORDER BY oi.order_item_id`, [req.params.id]);
  res.json({ ...rows[0], items: items.rows });
}));

router.post(
  '/',
  requirePerm('orders.write'),
  validate(z.object({
    customer_name: z.string().trim().max(120).optional(),
    customer_phone: z.string().max(30).nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
    items: itemsSchema,
  })),
  wrap(async (req, res) => {
    const result = await tx((client) => createOrder(client, { ...req.body, userId: req.user.user_id, status: 'pending' }));
    await logActivity(req, 'order.create', 'order', result.orderId, { total: result.total });
    for (const pid of result.productIds) await alertLowStock(pid);
    res.status(201).json({ order_id: result.orderId, total: result.total });
  })
);

router.post(
  '/:id/status',
  requirePerm('orders.write'),
  validate(z.object({ status: z.enum(['processing', 'completed', 'cancelled']) })),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const next = req.body.status;
    const productIds = await tx(async (client) => {
      const cur = await client.query('SELECT status FROM orders WHERE order_id = $1 FOR UPDATE', [id]);
      if (!cur.rows[0]) throw new HttpError(404, 'Order not found');
      const from = cur.rows[0].status;
      if (!TRANSITIONS[from].includes(next)) {
        throw new HttpError(400, `An order cannot move from ${from} to ${next}`);
      }
      let ids = [];
      if (next === 'cancelled') {
        // Put the stock back and record it in stock history.
        const items = await client.query('SELECT product_id, quantity FROM order_items WHERE order_id = $1', [id]);
        for (const it of items.rows) {
          await applyStock(client, {
            productId: it.product_id, change: it.quantity, type: 'order_cancelled',
            userId: req.user.user_id, reason: `Order #${id} cancelled`, refType: 'order', refId: id,
          });
          ids.push(it.product_id);
        }
        await client.query("DELETE FROM sales WHERE order_id = $1", [id]);
      }
      await client.query('UPDATE orders SET status = $1, updated_at = now() WHERE order_id = $2', [next, id]);
      return ids;
    });
    await logActivity(req, 'order.status', 'order', id, { status: next });
    for (const pid of productIds) await alertLowStock(pid);
    res.json({ ok: true });
  })
);

module.exports = router;
