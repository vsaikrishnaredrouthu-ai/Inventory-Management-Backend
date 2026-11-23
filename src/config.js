const path = require('path');
require('dotenv').config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';

const jwtSecret = process.env.JWT_SECRET || (isProd ? '' : 'dev-only-secret-change-me');
if (!jwtSecret || jwtSecret.length < 16) {
  console.error('JWT_SECRET must be set (16+ characters). Add it to your .env file.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and add your Supabase connection string.');
  process.exit(1);
}

module.exports = {
  nodeEnv,
  isProd,
  port: parseInt(process.env.PORT, 10) || 5000,
  databaseUrl: process.env.DATABASE_URL,
  // Supabase requires SSL. Set DB_SSL=false only for a local Postgres.
  dbSsl: (process.env.DB_SSL || 'true').toLowerCase() !== 'false',
  jwtSecret,
  jwtExpires: process.env.JWT_EXPIRES || '8h',
  jwtRememberExpires: process.env.JWT_REMEMBER_EXPIRES || '30d',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',').map((s) => s.trim()).filter(Boolean),
  uploadDir: path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads')),
  // Optional: serve a built frontend (the "dist" folder) from this server.
  frontendDir: process.env.FRONTEND_DIST ? path.resolve(process.env.FRONTEND_DIST) : null,
  lowStockScanMinutes: parseInt(process.env.ALERT_SCAN_MINUTES, 10) || 60,
};
