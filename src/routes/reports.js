const express = require('express');
const { query } = require('../db');
const { HttpError, wrap, validate, z, isoDate, toCsv } = require('../utils/helpers');
const { authenticate, requirePerm } = require('../middleware/auth');
const { logActivity } = require('../services/activity');

const router = express.Router();
router.use(authenticate);

const dateRange = (req) => {
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new HttpError(400, 'Dates must be in YYYY-MM-DD format');
  }
  if (from > to) throw new HttpError(400, 'The start date must be before the end date');
  return { from, to };
};

/* ---------- Dashboard: each role only receives the figures it may see ---------- */
router.get('/dashboard/summary', wrap(async (req, res) => {
  const perms = req.user.permissions;
  const has = (k) => perms.includes(k);
  const out = { role: req.user.role_name, stats: {}, charts: {}, lists: {} };

  if (has('products.read')) {
    const { rows } = await query(`
      SELECT COUNT(*) FILTER (WHERE is_active)::int AS products,
             COUNT(*) FILTER (WHERE is_active AND quantity = 0)::int AS out_of_stock,
             COUNT(*) FILTER (WHERE is_active AND quantity > 0 AND quantity <= reorder_level)::int AS low_stock,
             COALESCE(SUM(quantity * cost_price) FILTER (WHERE is_active), 0)::float AS stock_value
      FROM products`);
    Object.assign(out.stats, rows[0]);
    const low = await query(`
      SELECT product_id, product_name, sku, quantity, reorder_level FROM products
      WHERE is_active AND quantity <= reorder_level ORDER BY quantity ASC LIMIT 5`);
    out.lists.low_stock = low.rows;
  }

  if (has('sales.read')) {
    const { rows } = await query(`
      SELECT COALESCE(SUM(amount_paid) FILTER (WHERE created_at::date = CURRENT_DATE), 0)::float AS sales_today,
             COALESCE(SUM(amount_paid) FILTER (WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)), 0)::float AS sales_month,
             COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int AS sales_count_today
      FROM sales`);
    Object.assign(out.stats, rows[0]);
    const trend = await query(`
      SELECT to_char(d, 'DD Mon') AS day, COALESCE(SUM(s.amount_paid), 0)::float AS revenue
      FROM generate_series(CURRENT_DATE - 13, CURRENT_DATE, interval '1 day') AS d
      LEFT JOIN sales s ON s.created_at::date = d::date
      GROUP BY d ORDER BY d`);
    out.charts.sales_trend = trend.rows;
    const top = await query(`
      SELECT p.product_name AS name, SUM(oi.quantity)::int AS units,
             SUM(oi.quantity * oi.unit_price)::float AS revenue
      FROM order_items oi
      JOIN orders o ON o.order_id = oi.order_id
      JOIN products p ON p.product_id = oi.product_id
      WHERE o.status = 'completed' AND o.created_at >= now() - interval '30 days'
      GROUP BY p.product_name ORDER BY revenue DESC LIMIT 5`);
    out.charts.top_products = top.rows;
  }

  if (has('orders.read')) {
    const { rows } = await query(`SELECT COUNT(*) FILTER (WHERE status IN ('pending','processing'))::int AS open_orders FROM orders`);
    Object.assign(out.stats, rows[0]);
  }

  if (has('purchases.read')) {
    const { rows } = await query(`
      SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_purchases,
             COALESCE(SUM(total_amount) FILTER (WHERE status = 'received'
               AND date_trunc('month', purchase_date) = date_trunc('month', CURRENT_DATE)), 0)::float AS purchases_month
      FROM purchase_orders`);
    Object.assign(out.stats, rows[0]);
  }

  if (has('stock.read') || has('products.read')) {
    const cat = await query(`
      SELECT COALESCE(c.category_name, 'Uncategorised') AS name, SUM(p.quantity)::int AS units
      FROM products p LEFT JOIN categories c ON c.category_id = p.category_id
      WHERE p.is_active GROUP BY 1 ORDER BY 2 DESC`);
    out.charts.stock_by_category = cat.rows;
  }

  if (has('users.manage')) {
    const { rows } = await query(`SELECT COUNT(*)::int AS users, COUNT(*) FILTER (WHERE is_active)::int AS active_users FROM users`);
    Object.assign(out.stats, rows[0]);
  }

  const unread = await query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND NOT is_read', [req.user.user_id]);
  out.stats.unread_notifications = unread.rows[0].n;
  const recent = await query(
    `SELECT action, entity, created_at FROM activity_logs
     WHERE ($1::boolean OR user_id = $2) ORDER BY created_at DESC LIMIT 6`,
    [has('users.manage'), req.user.user_id]);
  out.lists.recent_activity = recent.rows;
  res.json(out);
}));

/* ---------- Analytics & reports ---------- */
router.get('/reports/sales', requirePerm('sales.read'), wrap(async (req, res) => {
  const { from, to } = dateRange(req);
  const unit = req.query.group === 'month' ? 'month' : 'day';
  const trend = await query(`
    SELECT to_char(date_trunc('${unit}', s.created_at), 'YYYY-MM-DD') AS period,
           COUNT(*)::int AS sales_count, COALESCE(SUM(s.amount_paid), 0)::float AS revenue
    FROM sales s WHERE s.created_at::date BETWEEN $1 AND $2
    GROUP BY 1 ORDER BY 1`, [from, to]);
  const byPayment = await query(`
    SELECT payment_method, COUNT(*)::int AS sales_count, COALESCE(SUM(amount_paid), 0)::float AS revenue
    FROM sales WHERE created_at::date BETWEEN $1 AND $2 GROUP BY payment_method ORDER BY revenue DESC`, [from, to]);
  const totals = await query(`
    SELECT COUNT(*)::int AS sales_count, COALESCE(SUM(amount_paid), 0)::float AS revenue,
           COALESCE(SUM(amount_paid) / NULLIF(COUNT(*), 0), 0)::float AS average_sale
    FROM sales WHERE created_at::date BETWEEN $1 AND $2`, [from, to]);
  res.json({ from, to, group: unit, trend: trend.rows, by_payment: byPayment.rows, totals: totals.rows[0] });
}));

router.get('/reports/top-products', requirePerm('sales.read'), wrap(async (req, res) => {
  const { from, to } = dateRange(req);
  const { rows } = await query(`
    SELECT p.product_id, p.product_name, p.sku, SUM(oi.quantity)::int AS units,
           SUM(oi.quantity * oi.unit_price)::float AS revenue,
           SUM(oi.quantity * (oi.unit_price - oi.unit_cost))::float AS profit
    FROM order_items oi
    JOIN orders o ON o.order_id = oi.order_id
    JOIN products p ON p.product_id = oi.product_id
    WHERE o.status = 'completed' AND o.created_at::date BETWEEN $1 AND $2
    GROUP BY p.product_id, p.product_name, p.sku ORDER BY revenue DESC LIMIT 20`, [from, to]);
  res.json({ from, to, items: rows });
}));

router.get('/reports/purchases', requirePerm('purchases.read'), wrap(async (req, res) => {
  const { from, to } = dateRange(req);
  const { rows } = await query(`
    SELECT s.supplier_name, COUNT(po.purchase_id)::int AS purchases,
           COALESCE(SUM(po.total_amount), 0)::float AS total
    FROM purchase_orders po JOIN suppliers s ON s.supplier_id = po.supplier_id
    WHERE po.status = 'received' AND po.purchase_date BETWEEN $1 AND $2
    GROUP BY s.supplier_name ORDER BY total DESC`, [from, to]);
  res.json({ from, to, items: rows });
}));

router.get('/reports/stock', requirePerm('stock.read'), wrap(async (_req, res) => {
  const { rows } = await query(`
    SELECT p.sku, p.product_name, c.category_name, p.quantity, p.reorder_level,
           (p.quantity * p.cost_price)::float AS stock_value,
           CASE WHEN p.quantity = 0 THEN 'out' WHEN p.quantity <= p.reorder_level THEN 'low' ELSE 'ok' END AS status
    FROM products p LEFT JOIN categories c ON c.category_id = p.category_id
    WHERE p.is_active ORDER BY status, p.product_name`);
  res.json({ items: rows });
}));

/* ---------- CSV export (permission depends on the data type) ---------- */
const EXPORTS = {
  sales: {
    perm: 'sales.read',
    columns: [
      { key: 'sale_id', label: 'Sale ID' }, { key: 'created_at', label: 'Date' }, { key: 'customer_name', label: 'Customer' },
      { key: 'payment_method', label: 'Payment' }, { key: 'amount_paid', label: 'Amount paid' }, { key: 'sold_by', label: 'Sold by' },
    ],
    sql: `SELECT s.sale_id, s.created_at, o.customer_name, s.payment_method, s.amount_paid, u.full_name AS sold_by
          FROM sales s JOIN orders o ON o.order_id = s.order_id LEFT JOIN users u ON u.user_id = s.sold_by
          WHERE s.created_at::date BETWEEN $1 AND $2 ORDER BY s.created_at`,
  },
  orders: {
    perm: 'orders.read',
    columns: [
      { key: 'order_id', label: 'Order ID' }, { key: 'created_at', label: 'Created' }, { key: 'customer_name', label: 'Customer' },
      { key: 'status', label: 'Status' }, { key: 'total_amount', label: 'Total' },
    ],
    sql: `SELECT order_id, created_at, customer_name, status, total_amount FROM orders
          WHERE created_at::date BETWEEN $1 AND $2 ORDER BY created_at`,
  },
  purchases: {
    perm: 'purchases.read',
    columns: [
      { key: 'purchase_id', label: 'Purchase ID' }, { key: 'purchase_date', label: 'Date' }, { key: 'supplier_name', label: 'Supplier' },
      { key: 'status', label: 'Status' }, { key: 'total_amount', label: 'Total' },
    ],
    sql: `SELECT po.purchase_id, po.purchase_date, s.supplier_name, po.status, po.total_amount
          FROM purchase_orders po JOIN suppliers s ON s.supplier_id = po.supplier_id
          WHERE po.purchase_date BETWEEN $1 AND $2 ORDER BY po.purchase_date`,
  },
  stock: {
    perm: 'stock.read',
    dated: false,
    columns: [
      { key: 'sku', label: 'SKU' }, { key: 'product_name', label: 'Product' }, { key: 'quantity', label: 'Quantity' },
      { key: 'reorder_level', label: 'Reorder level' }, { key: 'stock_value', label: 'Stock value' },
    ],
    sql: `SELECT sku, product_name, quantity, reorder_level, (quantity * cost_price) AS stock_value
          FROM products WHERE is_active ORDER BY product_name`,
  },
  stock_history: {
    perm: 'stock.read',
    columns: [
      { key: 'created_at', label: 'When' }, { key: 'sku', label: 'SKU' }, { key: 'transaction_type', label: 'Type' },
      { key: 'quantity_change', label: 'Change' }, { key: 'quantity_after', label: 'Balance after' }, { key: 'reason', label: 'Reason' },
    ],
    sql: `SELECT t.created_at, p.sku, t.transaction_type, t.quantity_change, t.quantity_after, t.reason
          FROM stock_transactions t JOIN products p ON p.product_id = t.product_id
          WHERE t.created_at::date BETWEEN $1 AND $2 ORDER BY t.created_at`,
  },
};

router.get('/reports/export', wrap(async (req, res) => {
  const type = EXPORTS[req.query.type];
  if (!type) throw new HttpError(400, 'Choose a report type to export');
  if (!req.user.permissions.includes(type.perm) || !req.user.permissions.includes('reports.view')) {
    throw new HttpError(403, 'You do not have permission to export this report');
  }
  const { from, to } = dateRange(req);
  const { rows } = await query(type.sql, type.dated === false ? [] : [from, to]);
  await logActivity(req, 'report.export', req.query.type, null, { from, to, rows: rows.length });
  const filename = `${req.query.type}-${from}-to-${to}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCsv(type.columns, rows));
}));

module.exports = router;
