'use strict';

const { normalizeId, normalizeEmail, looksLikeEmail } = require('../services/identity');

const BUSY_MESSAGE = 'Sign-in is very busy right now, so you have been given a place in the waiting room.';

/** Staff and administrators skip the queue (FR-P3). Looked up only when the system is full. */
async function bypassesQueue(db, identifier) {
  if (typeof identifier !== 'string' || identifier.trim() === '' || identifier.length > 254) return false;
  const column = looksLikeEmail(identifier) ? 'users.email' : 'users.matric_or_staff_id';
  const value = looksLikeEmail(identifier) ? normalizeEmail(identifier) : normalizeId(identifier);
  const row = await db('users').join('roles', 'roles.id', 'users.role_id').where(column, value).first('roles.name as role');
  return Boolean(row && (row.role === 'staff' || row.role === 'admin'));
}

/**
 * Admission control in front of POST /auth/login (FR-P2, FR-P3).
 * The waiting room is skipped entirely when policies.queue_enabled is false
 * (the baseline for measurements). Otherwise a sign-in may start only with a
 * live admission pass: one already held, one taken now (room and nobody
 * waiting), or none needed (staff/admin). Everyone else gets 503 with
 * { queued: true }, and the page sends them to /waiting.
 *
 * Redis down: the waiting room cannot work, so sign-in is let through (fail
 * open) and logged; rate limits and lockout still apply.
 */
function requireAdmission({ waitingRoom, getPolicy, cookies, db }) {
  const middleware = async (req, res, next) => {
    const policy = await getPolicy();
    if (!policy.queue_enabled) return next();
    try {
      const held = req.cookies[cookies.names.admissionPass];
      if (held && (await waitingRoom.hasPass(held))) return next();
      const pass = await waitingRoom.tryEnter(policy);
      if (pass) {
        cookies.setAdmissionPass(res, pass);
        req.cookies[cookies.names.admissionPass] = pass;
        return next();
      }
    } catch (err) {
      req.log.warn({ event: 'waiting_room_unavailable', err }, 'waiting room unavailable; sign-in allowed');
      return next();
    }
    if (await bypassesQueue(db, (req.body || {}).identifier)) return next();
    req.log.info({ event: 'waiting_room_queued' }, 'sign-in sent to the waiting room');
    res.set('Retry-After', String(policy.queue_interval_sec));
    return res.status(503).json({ queued: true, error: BUSY_MESSAGE, redirect: '/waiting' });
  };
  middleware.requiresAdmission = true;
  return middleware;
}

module.exports = { requireAdmission, bypassesQueue, BUSY_MESSAGE };
