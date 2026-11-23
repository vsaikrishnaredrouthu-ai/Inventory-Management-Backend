const express = require('express');
const { query, tx } = require('../db');
const { HttpError, wrap, validate, z, paging, like, isoDate } = require('../utils/helpers');
const { authenticate, requirePerm } = require('../middleware/auth');
const { applyStock } = require('../services/stock');
const { notifyByPermission } = require('../services/notify');
const { logActivity } = require('../services/activity');

const router = express.Router();
router.use(authenticate);

router.get('/', requirePerm('purchases.read'), wrap(async (req, res) => {
  const { page, limit, offset } = paging(req);
  const conds = [];
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  if (req.query.status) conds.push(`po.status = ${add(req.query.status)}`);
  if (req.query.q) conds.push(`s.supplier_name ILIKE ${add(like(req.query.q))}`);
  if (req.query.from) conds.push(`po.purchase_date >= ${add(req.query.from)}`);
  if (req.query.to) conds.push(`po.purchase_date <= ${add(req.query.to)}`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const base = `FROM purchase_orders po JOIN suppliers s ON s.supplier_id = po.supplier_id
                LEFT JOIN users u ON u.user_id = po.created_by ${where}`;
  const total = await query(`SELECT COUNT(*)::int AS n ${base}`, params);
  const items = await query(
    `SELECT po.*, s.supplier_name, u.full_name AS created_by_name,
            (SELECT COUNT(*)::int FROM purchase_items pi WHERE pi.purchase_id = po.purchase_id) AS item_count
     ${base} ORDER BY po.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  res.json({ items: items.rows, total: total.rows[0].n, page, limit });
}));

router.get('/:id', requirePerm('purchases.read'), wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT po.*, s.supplier_name, s.phone AS supplier_phone, u.full_name AS created_by_name
     FROM purchase_orders po JOIN suppliers s ON s.supplier_id = po.supplier_id
     LEFT JOIN users u ON u.user_id = po.created_by WHERE po.purchase_id = $1`, [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Purchase order not found');
  const items = await query(
    `SELECT pi.*, p.product_name, p.sku FROM purchase_items pi
     JOIN products p ON p.product_id = pi.product_id WHERE pi.purchase_id = $1 ORDER BY pi.purchase_item_id`,
    [req.params.id]);
  res.json({ ...rows[0], items: items.rows });
}));

const purchaseSchema = z.object({
  supplier_id: z.number().int().positive(),
  purchase_date: isoDate.optional(),
  notes: z.string().max(500).nullable().optional(),
  items: z.array(z.object({
    product_id: z.number().int().positive(),
    quantity: z.number().int().positive().max(10000000),
    unit_cost: z.number().min(0).max(100000000),
  })).min(1, 'Add at least one product'),
});

router.post('/', requirePerm('purchases.write'), validate(purchaseSchema), wrap(async (req, res) => {
  const b = req.body;
  const id = await tx(async (client) => {
    const sup = await client.query('SELECT supplier_id FROM suppliers WHERE supplier_id = $1 AND is_active', [b.supplier_id]);
    if (!sup.rows[0]) throw new HttpError(400, 'Choose an active supplier');
    const po = await client.query(
      `INSERT INTO purchase_orders (supplier_id, created_by, purchase_date, notes)
       VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),$4) RETURNING purchase_id`,
      [b.supplier_id, req.user.user_id, b.purchase_date || null, b.notes || null]);
    const purchaseId = po.rows[0].purchase_id;
    let total = 0;
    for (const it of b.items) {
      await client.query(
        `INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_cost) VALUES ($1,$2,$3,$4)`,
        [purchaseId, it.product_id, it.quantity, it.unit_cost]);
      total += it.quantity * it.unit_cost;
    }
    await client.query('UPDATE purchase_orders SET total_amount = $1 WHERE purchase_id = $2',
      [Math.round(total * 100) / 100, purchaseId]);
    return purchaseId;
  });
  await logActivity(req, 'purchase.create', 'purchase', id);
  res.status(201).json({ purchase_id: id });
}));

// Receiving adds the quantities to stock and writes purchase_received history rows.
router.post('/:id/receive', requirePerm('purchases.write'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  await tx(async (client) => {
    const po = await client.query('SELECT * FROM purchase_orders WHERE purchase_id = $1 FOR UPDATE', [id]);
    if (!po.rows[0]) throw new HttpError(404, 'Purchase order not found');
    if (po.rows[0].status !== 'pending') throw new HttpError(400, `This purchase is already ${po.rows[0].status}`);
    const items = await client.query('SELECT product_id, quantity FROM purchase_items WHERE purchase_id = $1', [id]);
    for (const it of items.rows) {
      await applyStock(client, {
        productId: it.product_id, change: it.quantity, type: 'purchase_received',
        userId: req.user.user_id, reason: `Purchase #${id} received`, refType: 'purchase', refId: id,
      });
    }
    await client.query(
      `UPDATE purchase_orders SET status = 'received', received_at = now(), received_by = $1 WHERE purchase_id = $2`,
      [req.user.user_id, id]);
  });
  await logActivity(req, 'purchase.receive', 'purchase', id);
  await notifyByPermission(['stock.read'], { title: `Purchase #${id} received`, message: 'Stock has been updated.', link: '/stock' });
  res.json({ ok: true });
}));

router.post('/:id/cancel', requirePerm('purchases.write'), wrap(async (req, res) => {
  const { rows } = await query('SELECT status FROM purchase_orders WHERE purchase_id = $1', [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Purchase order not found');
  if (rows[0].status !== 'pending') throw new HttpError(400, 'Only pending purchases can be cancelled');
  await query(`UPDATE purchase_orders SET status = 'cancelled' WHERE purchase_id = $1`, [req.params.id]);
  await logActivity(req, 'purchase.cancel', 'purchase', Number(req.params.id));
  res.json({ ok: true });
}));

module.exports = router;
