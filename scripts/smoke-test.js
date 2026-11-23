/**
 * End-to-end check against a running server (npm start in another terminal).
 * Requires demo data:  npm run db:demo
 *   API_URL=http://localhost:5000 npm test
 */
const API = process.env.API_URL || 'http://localhost:5000';
const PASS = 'Demo@1234';
let failures = 0;

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${extra}`}`);
  if (!cond) failures++;
}

async function login(email) {
  const r = await call('POST', '/auth/login', { body: { identifier: email, password: PASS } });
  if (r.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(r.data)}`);
  return r.data.token;
}

async function main() {
  const health = await call('GET', '/health');
  check('API health', health.status === 200, JSON.stringify(health));

  const owner = await login('owner@demo.local');
  const product = await login('product@demo.local');
  const sales = await login('sales@demo.local');
  const stock = await login('stock@demo.local');
  const purchase = await login('purchase@demo.local');
  const orders = await login('orders@demo.local');

  // Role-based access
  check('Sales manager cannot create a category', (await call('POST', '/categories', { token: sales, body: { category_name: 'Nope' } })).status === 403);
  check('Product manager cannot list users', (await call('GET', '/users', { token: product })).status === 403);
  check('Owner can list users', (await call('GET', '/users', { token: owner })).status === 200);
  check('Anonymous request is rejected', (await call('GET', '/products')).status === 401);
  check('Bad login is rejected', (await call('POST', '/auth/login', { body: { identifier: 'owner@demo.local', password: 'wrong' } })).status === 401);

  // Product catalogue
  const sku = `TEST-${Date.now()}`;
  const created = await call('POST', '/products', { token: product, body: {
    sku, product_name: 'Smoke test item', unit_price: 100, cost_price: 60, quantity: 10, reorder_level: 3,
  } });
  check('Product manager creates a product with opening stock', created.status === 201 && created.data.quantity === 10, JSON.stringify(created.data));
  const pid = created.data.product_id;
  check('Duplicate SKU is rejected with a clear message', (await call('POST', '/products', { token: product, body: {
    sku, product_name: 'Duplicate', unit_price: 1, cost_price: 1,
  } })).status === 409);

  // Order: stock goes down
  const order = await call('POST', '/orders', { token: orders, body: { customer_name: 'Test buyer', items: [{ product_id: pid, quantity: 4 }] } });
  check('Order manager creates an order', order.status === 201, JSON.stringify(order.data));
  let level = await call('GET', `/products/${pid}`, { token: stock });
  check('Ordering reduces stock to 6', level.data.quantity === 6, `got ${level.data.quantity}`);
  check('Ordering more than available is refused', (await call('POST', '/orders', { token: orders, body: {
    items: [{ product_id: pid, quantity: 999 }] } })).status === 400);

  // Cancelling returns the stock
  const cancel = await call('POST', `/orders/${order.data.order_id}/status`, { token: orders, body: { status: 'cancelled' } });
  check('Cancelling a pending order succeeds', cancel.status === 200, JSON.stringify(cancel.data));
  level = await call('GET', `/products/${pid}`, { token: stock });
  check('Cancelling restores stock to 10', level.data.quantity === 10, `got ${level.data.quantity}`);

  // Quick sale by sales manager
  const sale = await call('POST', '/sales', { token: sales, body: {
    payment_method: 'upi', amount_paid: 300, items: [{ product_id: pid, quantity: 3 }],
  } });
  check('Sales manager records a sale', sale.status === 201 && sale.data.total === 300, JSON.stringify(sale.data));
  check('Underpayment is refused', (await call('POST', '/sales', { token: sales, body: {
    payment_method: 'cash', amount_paid: 10, items: [{ product_id: pid, quantity: 1 }] } })).status === 400);

  // Stock adjustment and history
  const adj = await call('POST', '/stock/movements', { token: stock, body: { product_id: pid, type: 'adjustment', new_quantity: 5, reason: 'Count' } });
  check('Stock adjustment to counted quantity', adj.status === 201 && adj.data.after === 5, JSON.stringify(adj.data));
  const hist = await call('GET', `/stock/transactions?product_id=${pid}`, { token: stock });
  check('Stock history records the movements', hist.data.total >= 3, JSON.stringify(hist.data).slice(0, 200));

  // Purchase and receiving
  const sup = (await call('GET', '/suppliers', { token: purchase })).data.items[0];
  const po = await call('POST', '/purchases', { token: purchase, body: {
    supplier_id: sup.supplier_id, items: [{ product_id: pid, quantity: 20, unit_cost: 55 }],
  } });
  check('Purchase manager creates a purchase order', po.status === 201, JSON.stringify(po.data));
  const recv = await call('POST', `/purchases/${po.data.purchase_id}/receive`, { token: purchase });
  check('Receiving a purchase succeeds', recv.status === 200, JSON.stringify(recv.data));
  level = await call('GET', `/products/${pid}`, { token: stock });
  check('Receiving adds 20 to stock (5 + 20 = 25)', level.data.quantity === 25, `got ${level.data.quantity}`);
  check('Receiving twice is refused', (await call('POST', `/purchases/${po.data.purchase_id}/receive`, { token: purchase })).status === 400);

  // Owner: role change takes effect immediately
  const users = (await call('GET', '/users?q=orders', { token: owner })).data.items;
  const target = users.find((u) => u.email === 'orders@demo.local');
  const change = await call('PUT', `/users/${target.user_id}/role`, { token: owner, body: { role_key: 'stock_manager' } });
  check('Owner changes a user role', change.status === 200, JSON.stringify(change.data));
  const afterChange = await call('GET', '/orders', { token: orders });
  check('Previous role access is removed right away', afterChange.status === 403);
  await call('PUT', `/users/${target.user_id}/role`, { token: owner, body: { role_key: 'order_manager' } });

  // Reports and export
  const report = await call('GET', '/reports/sales?from=2026-01-01&to=2030-01-01', { token: owner });
  check('Sales report returns totals', report.status === 200 && report.data.totals.sales_count >= 1, JSON.stringify(report.data).slice(0, 200));
  const csv = await fetch(`${API}/api/reports/export?type=stock&from=2026-01-01&to=2030-01-01`, { headers: { authorization: `Bearer ${stock}` } });
  check('CSV export downloads', csv.status === 200 && (await csv.text()).startsWith('SKU,Product'));

  // Cleanup: products with history can't be deleted, so deactivate instead
  await call('PUT', `/products/${pid}`, { token: product, body: { is_active: false } });

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error('Smoke test crashed:', err.message);
  process.exitCode = 1;
});
