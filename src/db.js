const { Pool, types } = require('pg');
const config = require('./config');

// Return numbers as JS numbers and DATE columns as plain 'YYYY-MM-DD' strings.
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // NUMERIC
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // BIGINT (COUNT)
types.setTypeParser(1082, (v) => v); // DATE

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.dbSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => console.error('Unexpected database error', err.message));

const query = (text, params) => pool.query(text, params);

/** Run fn(client) inside a transaction; commits on success, rolls back on error. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
