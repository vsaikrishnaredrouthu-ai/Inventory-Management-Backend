const { pool } = require('../db');

/** Record who did what. Never throws, so logging can't break a request. */
async function logActivity(req, action, entity = null, entityId = null, details = null, userId = null) {
  try {
    const uid = userId ?? req?.user?.user_id ?? null;
    const ip = req?.ip || null;
    await pool.query(
      `INSERT INTO activity_logs (user_id, action, entity, entity_id, details, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uid, action, entity, entityId, details ? JSON.stringify(details) : null, ip]
    );
  } catch (err) {
    console.error('Activity log failed:', err.message);
  }
}

module.exports = { logActivity };
