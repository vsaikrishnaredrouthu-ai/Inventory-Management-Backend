const { HttpError } = require('../utils/helpers');
const { applyStock } = require('./stock');

/**
 * Create an order with its items and take the stock out, all inside the
 * caller's transaction. Used by Order Manager (status "pending") and by the
 * Sales Manager's quick sale (status "completed").
 */
async function createOrder(client, { customer_name, customer_phone, notes, items, userId, status = 'pending' }) {
  // Merge duplicate lines and lock rows in a stable order to avoid deadlocks.
  const merged = new Map();
  for (const it of items) {
    const prev = merged.get(it.product_id);
    if (prev) prev.quantity += it.quantity;
    else merged.set(it.product_id, { ...it });
  }
  const lines = [...merged.values()].sort((a, b) => a.product_id - b.product_id);

  const orderRes = await client.query(
    `INSERT INTO orders (customer_name, customer_phone, created_by, status, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING order_id`,
    [customer_name || 'Walk-in customer', customer_phone || null, userId, status, notes || null]
  );
  const orderId = orderRes.rows[0].order_id;

  let total = 0;
  for (const line of lines) {
    const pr = await client.query(
      `SELECT product_id, product_name, unit_price, cost_price, is_active FROM products WHERE product_id = $1`,
      [line.product_id]
    );
    const p = pr.rows[0];
    if (!p) throw new HttpError(404, `Product #${line.product_id} was not found`);
    if (!p.is_active) throw new HttpError(400, `"${p.product_name}" is inactive and cannot be sold`);

    await applyStock(client, {
      productId: p.product_id, change: -line.quantity, type: 'order', userId,
      reason: `Order #${orderId}`, refType: 'order', refId: orderId,
    });

    const price = line.unit_price ?? p.unit_price;
    total += price * line.quantity;
    await client.query(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price, unit_cost) VALUES ($1,$2,$3,$4,$5)`,
      [orderId, p.product_id, line.quantity, price, p.cost_price]
    );
  }
  total = Math.round(total * 100) / 100;
  await client.query(`UPDATE orders SET total_amount = $1 WHERE order_id = $2`, [total, orderId]);
  return { orderId, total, productIds: lines.map((l) => l.product_id) };
}

module.exports = { createOrder };
