const { HttpError } = require('../utils/helpers');

/**
 * Change a product's quantity and write the stock_transactions row, inside the
 * caller's transaction. The product row is locked so two requests can't
 * oversell the same item.
 */
async function applyStock(client, { productId, change, type, userId, reason = null, refType = null, refId = null }) {
  const { rows } = await client.query(
    `SELECT product_id, product_name, quantity, is_active FROM products WHERE product_id = $1 FOR UPDATE`,
    [productId]
  );
  const p = rows[0];
  if (!p) throw new HttpError(404, `Product #${productId} was not found`);
  const after = p.quantity + change;
  if (after < 0) {
    throw new HttpError(400, `Not enough stock for "${p.product_name}" (available: ${p.quantity})`);
  }
  await client.query(`UPDATE products SET quantity = $1, updated_at = now() WHERE product_id = $2`, [after, productId]);
  await client.query(
    `INSERT INTO stock_transactions
       (product_id, user_id, transaction_type, quantity_change, quantity_after, reason, reference_type, reference_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [productId, userId, type, change, after, reason, refType, refId]
  );
  return { product: p, before: p.quantity, after };
}

module.exports = { applyStock };
