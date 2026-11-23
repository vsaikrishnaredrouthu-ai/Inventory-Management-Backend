const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db');
const { HttpError, wrap } = require('../utils/helpers');

const permCache = new Map(); // role_id -> { perms, at }
async function permissionsForRole(roleId) {
  const hit = permCache.get(roleId);
  if (hit && Date.now() - hit.at < 30000) return hit.perms;
  const { rows } = await query(
    `SELECT p.permission_key FROM role_permissions rp
     JOIN permissions p ON p.permission_id = rp.permission_id WHERE rp.role_id = $1`,
    [roleId]
  );
  const perms = rows.map((r) => r.permission_key);
  permCache.set(roleId, { perms, at: Date.now() });
  return perms;
}

/**
 * Verifies the JWT, then loads the user and role from the database on every
 * request. That means a role change or deactivation by the Owner takes effect
 * immediately: the old role's access is gone and the new role's access applies.
 */
const authenticate = wrap(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Please log in to continue');

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    throw new HttpError(401, 'Your session has expired. Please log in again.');
  }

  const { rows } = await query(
    `SELECT u.user_id, u.full_name, u.username, u.email, u.phone, u.is_active, u.role_id,
            u.last_login_at, u.created_at, r.role_key, r.role_name
     FROM users u JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = $1`,
    [payload.sub]
  );
  const user = rows[0];
  if (!user || !user.is_active) throw new HttpError(401, 'This account is not active');
  user.permissions = await permissionsForRole(user.role_id);
  req.user = user;
  next();
});

/** Allow the request if the user has ANY of the listed permissions. */
const requirePerm = (...keys) => (req, _res, next) => {
  if (keys.some((k) => req.user.permissions.includes(k))) return next();
  next(new HttpError(403, 'You do not have permission to do that'));
};

const can = (req, key) => req.user.permissions.includes(key);

module.exports = { authenticate, requirePerm, can, permissionsForRole };
