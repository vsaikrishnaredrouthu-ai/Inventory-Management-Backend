const { z } = require('zod');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Wrap async route handlers so rejected promises reach the error handler. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Validate req.body with a zod schema and replace it with the parsed value. */
const validate = (schema) => (req, _res, next) => {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return next(parsed.error);
  req.body = parsed.data;
  next();
};

function paging(req, max = 100) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(max, Math.max(1, parseInt(req.query.limit, 10) || 10));
  return { page, limit, offset: (page - 1) * limit };
}

/** Small helper to build WHERE clauses with positional parameters. */
function where() {
  const clauses = [];
  const params = [];
  return {
    add(sqlWithQ, value) {
      params.push(value);
      clauses.push(sqlWithQ.replace(/\?/g, `$${params.length}`));
    },
    raw(sql) { clauses.push(sql); },
    param(value) { params.push(value); return `$${params.length}`; },
    get sql() { return clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''; },
    params,
  };
}

const like = (q) => `%${String(q).trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const passwordRule = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password is too long')
  .regex(/[A-Za-z]/, 'Password needs at least one letter')
  .regex(/\d/, 'Password needs at least one number');

const emptyToNull = (v) => (v === '' || v === undefined ? null : v);

const csvEscape = (v) => {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(columns, rows) {
  const head = columns.map((c) => csvEscape(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c.key])).join(','));
  return [head, ...body].join('\n');
}

module.exports = { HttpError, wrap, validate, paging, where, like, isoDate, passwordRule, emptyToNull, toCsv, z };
