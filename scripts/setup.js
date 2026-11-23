/**
 * Creates the database tables and, with --demo, adds sample users and data.
 *
 *   npm run db:setup    -> tables and roles only
 *   npm run db:demo     -> tables + demo users + sample products/orders
 *
 * Demo logins (password for all: Demo@1234):
 *   owner@demo.local, product@demo.local, sales@demo.local,
 *   stock@demo.local, purchase@demo.local, orders@demo.local
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const DEMO = process.argv.includes('--demo');
const DEMO_PASSWORD = 'Demo@1234';

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL in your .env file first.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (process.env.DB_SSL || 'true').toLowerCase() === 'false' ? false : { rejectUnauthorized: false },
});

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Schema applied.');

  if (!DEMO) return;

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const roles = { owner: 'owner', product: 'product_manager', sales: 'sales_manager',
    stock: 'stock_manager', purchase: 'purchase_manager', orders: 'order_manager' };
  for (const [name, roleKey] of Object.entries(roles)) {
    await pool.query(
      `INSERT INTO users (full_name, username, email, role_id, password_hash)
       SELECT $1, $2, $3, role_id, $4 FROM roles WHERE role_key = $5
       ON CONFLICT DO NOTHING`,
      [`Demo ${name[0].toUpperCase() + name.slice(1)}`, name, `${name}@demo.local`, hash, roleKey]);
  }
  console.log('Demo users ready (password Demo@1234).');

  const { rows: existing } = await pool.query('SELECT COUNT(*)::int AS n FROM products');
  if (existing[0].n > 0) {
    console.log('Sample products already exist, skipping sample data.');
    return;
  }

  const cats = {};
  for (const name of ['Beverages', 'Snacks', 'Dairy', 'Household']) {
    const r = await pool.query('INSERT INTO categories (category_name) VALUES ($1) RETURNING category_id', [name]);
    cats[name] = r.rows[0].category_id;
  }
  const sup = await pool.query(
    `INSERT INTO suppliers (supplier_name, contact_person, phone, email, address)
     VALUES ('Fresh Farms Ltd', 'R. Mehta', '+91 98100 00001', 'orders@freshfarms.example', 'Pune'),
            ('Metro Wholesale', 'S. Iyer', '+91 98100 00002', 'sales@metro.example', 'Chennai')
     RETURNING supplier_id`);
  const [s1, s2] = sup.rows.map((r) => r.supplier_id);

  const products = [
    ['BEV-001', 'Mineral water 1L', 'Beverages', s2, 25, 12, 120, 30, null],
    ['BEV-002', 'Orange juice 1L', 'Beverages', s1, 90, 55, 8, 15, '2027-03-01'],
    ['SNK-001', 'Salted chips 150g', 'Snacks', s2, 40, 22, 60, 20, '2027-01-15'],
    ['SNK-002', 'Dark chocolate 100g', 'Snacks', s2, 120, 70, 4, 10, '2027-06-30'],
    ['DRY-001', 'Whole milk 1L', 'Dairy', s1, 68, 52, 35, 25, '2026-12-05'],
    ['DRY-002', 'Paneer 200g', 'Dairy', s1, 110, 80, 0, 10, '2026-11-28'],
    ['HOU-001', 'Dish soap 500ml', 'Household', s2, 85, 48, 42, 12, null],
  ];
  for (const [sku, name, cat, supId, price, cost, qty, reorder, expiry] of products) {
    const p = await pool.query(
      `INSERT INTO products (sku, product_name, category_id, supplier_id, unit_price, cost_price, quantity, reorder_level, expiry_date)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8) RETURNING product_id`,
      [sku, name, cats[cat], supId, price, cost, reorder, expiry]);
    if (qty > 0) {
      await pool.query(
        `INSERT INTO stock_transactions (product_id, transaction_type, quantity_change, quantity_after, reason)
         VALUES ($1,'initial',$2,$2,'Opening stock')`, [p.rows[0].product_id, qty]);
      await pool.query('UPDATE products SET quantity = $1 WHERE product_id = $2', [qty, p.rows[0].product_id]);
    }
  }
  console.log(`Sample data added: ${products.length} products, 4 categories, 2 suppliers.`);
}

main()
  .catch((err) => {
    console.error('Setup failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
