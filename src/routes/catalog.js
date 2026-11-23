const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const config = require('../config');
const { query, tx } = require('../db');
const { HttpError, wrap, validate, z, paging, like, isoDate } = require('../utils/helpers');
const { authenticate, requirePerm } = require('../middleware/auth');
const { applyStock } = require('../services/stock');
const { alertLowStock } = require('../services/notify');
const { logActivity } = require('../services/activity');

const router = express.Router();
router.use(authenticate);

const money = z.number().min(0).max(100000000);

/* ---------------- Categories (Product Manager) ---------------- */
router.get('/categories', requirePerm('categories.read'), wrap(async (_req, res) => {
  const { rows } = await query(
    `SELECT c.category_id, c.category_name, c.description, COUNT(p.product_id)::int AS product_count
     FROM categories c LEFT JOIN products p ON p.category_id = c.category_id
     GROUP BY c.category_id ORDER BY c.category_name`
  );
  res.json({ items: rows });
}));

const categorySchema = z.object({
  category_name: z.string().trim().min(2).max(80),
  description: z.string().max(300).nullable().optional(),
});

router.post('/categories', requirePerm('categories.write'), validate(categorySchema), wrap(async (req, res) => {
  const { rows } = await query(
    'INSERT INTO categories (category_name, description) VALUES ($1, $2) RETURNING *',
    [req.body.category_name, req.body.description || null]
  );
  await logActivity(req, 'category.create', 'category', rows[0].category_id, { name: rows[0].category_name });
  res.status(201).json(rows[0]);
}));

router.put('/categories/:id', requirePerm('categories.write'), validate(categorySchema.partial()), wrap(async (req, res) => {
  const { rows } = await query(
    `UPDATE categories SET category_name = COALESCE($1, category_name), description = COALESCE($2, description)
     WHERE category_id = $3 RETURNING *`,
    [req.body.category_name ?? null, req.body.description ?? null, req.params.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Category not found');
  await logActivity(req, 'category.update', 'category', rows[0].category_id);
  res.json(rows[0]);
}));

router.delete('/categories/:id', requirePerm('categories.write'), wrap(async (req, res) => {
  const { rowCount } = await query('DELETE FROM categories WHERE category_id = $1', [req.params.id]);
  if (!rowCount) throw new HttpError(404, 'Category not found');
  await logActivity(req, 'category.delete', 'category', Number(req.params.id));
  res.json({ ok: true });
}));

/* ---------------- Suppliers (Purchase Manager) ---------------- */
router.get('/suppliers', requirePerm('suppliers.read'), wrap(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.q) { params.push(like(req.query.q)); where = `WHERE s.supplier_name ILIKE $1 OR s.email ILIKE $1 OR s.phone ILIKE $1`; }
  const { rows } = await query(
    `SELECT s.*, (SELECT COUNT(*)::int FROM purchase_orders po WHERE po.supplier_id = s.supplier_id) AS purchase_count
     FROM suppliers s ${where} ORDER BY s.supplier_name`, params
  );
  res.json({ items: rows });
}));

const supplierSchema = z.object({
  supplier_name: z.string().trim().min(2).max(120),
  contact_person: z.string().max(120).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  email: z.string().trim().email().nullable().optional().or(z.literal('')),
  address: z.string().max(300).nullable().optional(),
  is_active: z.boolean().optional(),
});

router.post('/suppliers', requirePerm('suppliers.write'), validate(supplierSchema), wrap(async (req, res) => {
  const b = req.body;
  const { rows } = await query(
    `INSERT INTO suppliers (supplier_name, contact_person, phone, email, address)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [b.supplier_name, b.contact_person || null, b.phone || null, b.email || null, b.address || null]
  );
  await logActivity(req, 'supplier.create', 'supplier', rows[0].supplier_id, { name: b.supplier_name });
  res.status(201).json(rows[0]);
}));

router.put('/suppliers/:id', requirePerm('suppliers.write'), validate(supplierSchema.partial()), wrap(async (req, res) => {
  const allowed = ['supplier_name', 'contact_person', 'phone', 'email', 'address', 'is_active'];
  const keys = allowed.filter((k) => req.body[k] !== undefined);
  if (!keys.length) throw new HttpError(400, 'Nothing to update');
  const params = keys.map((k) => (req.body[k] === '' ? null : req.body[k]));
  params.push(req.params.id);
  const { rows } = await query(
    `UPDATE suppliers SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE supplier_id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) throw new HttpError(404, 'Supplier not found');
  await logActivity(req, 'supplier.update', 'supplier', rows[0].supplier_id, { fields: keys });
  res.json(rows[0]);
}));

router.delete('/suppliers/:id', requirePerm('suppliers.write'), wrap(async (req, res) => {
  try {
    const { rowCount } = await query('DELETE FROM suppliers WHERE supplier_id = $1', [req.params.id]);
    if (!rowCount) throw new HttpError(404, 'Supplier not found');
  } catch (err) {
    if (err.code === '23503') throw new HttpError(409, 'This supplier has purchase orders. Deactivate it instead.');
    throw err;
  }
  await logActivity(req, 'supplier.delete', 'supplier', Number(req.params.id));
  res.json({ ok: true });
}));

/* ---------------- Products (Product Manager) ---------------- */
const productSchema = z.object({
  sku: z.string().trim().min(1).max(40),
  product_name: z.string().trim().min(2).max(150),
  description: z.string().max(1000).nullable().optional(),
  category_id: z.number().int().positive().nullable().optional(),
  supplier_id: z.number().int().positive().nullable().optional(),
  unit_price: money,
  cost_price: money.default(0),
  quantity: z.number().int().min(0).max(10000000).default(0), // opening stock on create only
  reorder_level: z.number().int().min(0).max(100000).default(10),
  expiry_date: isoDate.nullable().optional(),
  is_active: z.boolean().optional(),
});

const PRODUCT_SELECT = `
  SELECT p.*, c.category_name, s.supplier_name,
         CASE WHEN p.quantity = 0 THEN 'out' WHEN p.quantity <= p.reorder_level THEN 'low' ELSE 'ok' END AS stock_status
  FROM products p
  LEFT JOIN categories c ON c.category_id = p.category_id
  LEFT JOIN suppliers s ON s.supplier_id = p.supplier_id`;

router.get('/products', requirePerm('products.read'), wrap(async (req, res) => {
  const { page, limit, offset } = paging(req);
  const conds = [];
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };

  if (req.query.q) {
    const p = add(like(req.query.q));
    conds.push(`(p.product_name ILIKE ${p} OR p.sku ILIKE ${p})`);
  }
  if (req.query.category_id) conds.push(`p.category_id = ${add(Number(req.query.category_id))}`);
  if (req.query.supplier_id) conds.push(`p.supplier_id = ${add(Number(req.query.supplier_id))}`);
  if (req.query.stock === 'out') conds.push('p.quantity = 0');
  if (req.query.stock === 'low') conds.push('p.quantity > 0 AND p.quantity <= p.reorder_level');
  if (req.query.stock === 'ok') conds.push('p.quantity > p.reorder_level');
  if (req.query.status === 'active') conds.push('p.is_active');
  if (req.query.status === 'inactive') conds.push('NOT p.is_active');

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const sortMap = { name: 'p.product_name', price: 'p.unit_price', quantity: 'p.quantity', newest: 'p.created_at' };
  const sort = sortMap[req.query.sort] || 'p.product_name';
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';

  const total = await query(`SELECT COUNT(*)::int AS n FROM products p ${where}`, params);
  const items = await query(`${PRODUCT_SELECT} ${where} ORDER BY ${sort} ${dir} LIMIT ${limit} OFFSET ${offset}`, params);
  res.json({ items: items.rows, total: total.rows[0].n, page, limit });
}));

router.get('/products/:id', requirePerm('products.read'), wrap(async (req, res) => {
  const { rows } = await query(`${PRODUCT_SELECT} WHERE p.product_id = $1`, [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Product not found');
  res.json(rows[0]);
}));

router.post('/products', requirePerm('products.write'), validate(productSchema), wrap(async (req, res) => {
  const b = req.body;
  const id = await tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO products (sku, product_name, description, category_id, supplier_id, unit_price, cost_price,
                             quantity, reorder_level, expiry_date, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10) RETURNING product_id`,
      [b.sku, b.product_name, b.description || null, b.category_id || null, b.supplier_id || null,
        b.unit_price, b.cost_price, b.reorder_level, b.expiry_date || null, b.is_active ?? true]
    );
    const productId = rows[0].product_id;
    if (b.quantity > 0) {
      await applyStock(client, { productId, change: b.quantity, type: 'initial', userId: req.user.user_id, reason: 'Opening stock' });
    }
    return productId;
  });
  await logActivity(req, 'product.create', 'product', id, { sku: b.sku });
  await alertLowStock(id);
  const { rows } = await query(`${PRODUCT_SELECT} WHERE p.product_id = $1`, [id]);
  res.status(201).json(rows[0]);
}));

router.put('/products/:id', requirePerm('products.write'), validate(productSchema.partial().omit({ quantity: true })), wrap(async (req, res) => {
  const allowed = ['sku', 'product_name', 'description', 'category_id', 'supplier_id', 'unit_price', 'cost_price',
    'reorder_level', 'expiry_date', 'is_active'];
  const keys = allowed.filter((k) => req.body[k] !== undefined);
  if (!keys.length) throw new HttpError(400, 'Nothing to update');
  const params = keys.map((k) => (req.body[k] === '' ? null : req.body[k]));
  params.push(req.params.id);
  const { rowCount } = await query(
    `UPDATE products SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now()
     WHERE product_id = $${params.length}`,
    params
  );
  if (!rowCount) throw new HttpError(404, 'Product not found');
  await logActivity(req, 'product.update', 'product', Number(req.params.id), { fields: keys });
  await alertLowStock(Number(req.params.id));
  const { rows } = await query(`${PRODUCT_SELECT} WHERE p.product_id = $1`, [req.params.id]);
  res.json(rows[0]);
}));

router.delete('/products/:id', requirePerm('products.write'), wrap(async (req, res) => {
  try {
    const { rowCount } = await query('DELETE FROM products WHERE product_id = $1', [req.params.id]);
    if (!rowCount) throw new HttpError(404, 'Product not found');
  } catch (err) {
    if (err.code === '23503') {
      throw new HttpError(409, 'This product has order or purchase history. Deactivate it instead.');
    }
    throw err;
  }
  await logActivity(req, 'product.delete', 'product', Number(req.params.id));
  res.json({ ok: true });
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new HttpError(400, 'Only PNG, JPG, WEBP or GIF images are allowed'));
  },
});

router.post('/products/:id/image', requirePerm('products.write'), upload.single('image'), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose an image to upload');
  const url = `/uploads/${req.file.filename}`;
  const { rowCount } = await query('UPDATE products SET image_url = $1, updated_at = now() WHERE product_id = $2',
    [url, req.params.id]);
  if (!rowCount) throw new HttpError(404, 'Product not found');
  await logActivity(req, 'product.image', 'product', Number(req.params.id));
  res.json({ image_url: url });
}));

module.exports = router;
