const { pool } = require('../db');

/**
 * Send a notification to every active user whose role has at least one of the
 * given permissions. If dedupeKey is set, a user won't get a second copy while
 * the first is still unread (stops low-stock alerts from piling up).
 */
async function notifyByPermission(perms, { title, message = null, type = 'info', link = null, dedupeKey = null }) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type, link, dedupe_key)
       SELECT DISTINCT u.user_id, $2::text, $3::text, $4::text, $5::text, $6::text
       FROM users u
       JOIN role_permissions rp ON rp.role_id = u.role_id
       JOIN permissions p ON p.permission_id = rp.permission_id
       WHERE u.is_active AND p.permission_key = ANY($1::text[])
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND is_read = FALSE DO NOTHING`,
      [perms, title, message, type, link, dedupeKey]
    );
  } catch (err) {
    console.error('Notify failed:', err.message);
  }
}

async function notifyUser(userId, { title, message = null, type = 'info', link = null }) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type, link) VALUES ($1,$2,$3,$4,$5)`,
      [userId, title, message, type, link]
    );
  } catch (err) {
    console.error('Notify failed:', err.message);
  }
}

const LOW_STOCK_AUDIENCE = ['stock.read', 'purchases.write'];
const EXPIRY_AUDIENCE = ['stock.read', 'products.write'];

async function alertLowStock(productId) {
  const { rows } = await pool.query(
    `SELECT product_id, product_name, quantity, reorder_level FROM products
     WHERE product_id = $1 AND is_active AND quantity <= reorder_level`,
    [productId]
  );
  if (!rows[0]) return;
  const p = rows[0];
  await notifyByPermission(LOW_STOCK_AUDIENCE, {
    title: p.quantity === 0 ? `Out of stock: ${p.product_name}` : `Low stock: ${p.product_name}`,
    message: `${p.quantity} left (reorder level ${p.reorder_level}).`,
    type: p.quantity === 0 ? 'danger' : 'warning',
    link: '/stock',
    dedupeKey: `low:${p.product_id}`,
  });
}

/** Periodic scan for low-stock and expiring products. */
async function scanAlerts() {
  const low = await pool.query(
    `SELECT product_id FROM products WHERE is_active AND quantity <= reorder_level`
  );
  for (const r of low.rows) await alertLowStock(r.product_id);

  const exp = await pool.query(
    `SELECT product_id, product_name, quantity, expiry_date FROM products
     WHERE is_active AND quantity > 0 AND expiry_date IS NOT NULL
       AND expiry_date <= CURRENT_DATE + INTERVAL '30 days'`
  );
  for (const p of exp.rows) {
    const expired = p.expiry_date < new Date().toISOString().slice(0, 10);
    await notifyByPermission(EXPIRY_AUDIENCE, {
      title: expired ? `Expired: ${p.product_name}` : `Expiring soon: ${p.product_name}`,
      message: `${p.quantity} units, expiry ${p.expiry_date}.`,
      type: expired ? 'danger' : 'warning',
      link: '/stock',
      dedupeKey: `exp:${p.product_id}`,
    });
  }
}

module.exports = { notifyByPermission, notifyUser, alertLowStock, scanAlerts };
