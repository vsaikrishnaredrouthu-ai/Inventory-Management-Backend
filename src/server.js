const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { ZodError } = require('zod');
const config = require('./config');
const { pool } = require('./db');
const { scanAlerts } = require('./services/notify');

const app = express();
// Always send full responses (200), never 304 Not Modified.
app.set('etag', false);
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
}));
app.use(morgan(config.isProd ? 'combined' : 'dev'));
app.use(express.json({ limit: '100kb' }));

fs.mkdirSync(config.uploadDir, { recursive: true });
app.use('/uploads', express.static(config.uploadDir, { maxAge: '7d' }));

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'up' });
  } catch {
    res.status(503).json({ status: 'error', database: 'down' });
  }
});

app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
}));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api', require('./routes/catalog'));
app.use('/api/stock', require('./routes/stock'));
app.use('/api/purchases', require('./routes/purchases'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api', require('./routes/reports'));
app.use('/api', require('./routes/common'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/shifts', require('./routes/shifts'));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Route not found' }));

// Serve the built React app from the same server when FRONTEND_DIST is set.
if (config.frontendDir) {
  app.use(express.static(config.frontendDir));
  app.get(/^\/(?!api|uploads).*/, (_req, res) => res.sendFile(path.join(config.frontendDir, 'index.html')));
}

function duplicateMessage(err) {
  const m = /Key \((\w+)\)=\((.*)\) already exists/.exec(err.detail || '');
  if (!m) return 'This record already exists';
  const field = { sku: 'SKU', email: 'Email', username: 'Username', category_name: 'Category name', role_name: 'Role' }[m[1]] || m[1];
  return `${field} "${m[2]}" is already in use`;
}

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: err.issues[0]?.message || 'Please check the form',
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON' });
  if (err.status) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image must be 2 MB or smaller' });
  if (err.code === '23505') return res.status(409).json({ error: duplicateMessage(err) });
  if (err.code === '23503') return res.status(409).json({ error: 'This record is linked to other records' });
  if (err.code === '23514') return res.status(400).json({ error: 'One of the values is outside the allowed range' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

const server = app.listen(config.port, () => {
  console.log(`Inventory API running on http://localhost:${config.port}`);
});

// Low-stock and expiry checks run on a timer as well as after each stock change.
scanAlerts().catch((e) => console.error('Alert scan failed:', e.message));
const timer = setInterval(() => scanAlerts().catch((e) => console.error('Alert scan failed:', e.message)),
  config.lowStockScanMinutes * 60 * 1000);

function shutdown() {
  clearInterval(timer);
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app;
