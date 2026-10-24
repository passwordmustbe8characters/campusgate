'use strict';

const { normalizeId, normalizeEmail, looksLikeEmail } = require('./identity');

/**
 * Admin changes to policies, roles and permissions (FR-Z5).
 * Each change, its policy_history row and its audit event are written in ONE
 * transaction: if the audit event cannot be written (fail closed), nothing changes.
 * CLI only for now; the admin console (Phase 6) will call the same functions.
 */

class AdminChangeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdminChangeError';
  }
}

// Policy fields an admin may set, and how to read them from text.
const INT = (v) => {
  if (!/^\d+$/.test(String(v))) throw new AdminChangeError(`"${v}" is not a whole number`);
  return Number(v);
};
const BOOL = (v) => {
  if (v === 'true' || v === true) return true;
  if (v === 'false' || v === false) return false;
  throw new AdminChangeError(`"${v}" is not true or false`);
};
const POLICY_FIELDS = Object.freeze({
  min_length: INT,
  require_upper: BOOL,
  require_special: BOOL,
  max_attempts: INT,
  lockout_minutes: INT,
  session_timeout_min: INT,
  max_sessions: INT,
  queue_capacity: INT,
  queue_batch: INT,
  queue_interval_sec: INT,
});
// FR-A13: pinned to true by a CHECK constraint and deliberately not settable.
const NOT_SETTABLE = new Set(['require_2fa_admin', 'id', 'updated_by', 'updated_at']);

const CHECK_VIOLATION = '23514';

function parsePolicyChanges(pairs) {
  const changes = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new AdminChangeError(`expected key=value, got "${pair}"`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    if (NOT_SETTABLE.has(key)) throw new AdminChangeError(`"${key}" cannot be changed`);
    if (!POLICY_FIELDS[key]) throw new AdminChangeError(`unknown policy field "${key}" (allowed: ${Object.keys(POLICY_FIELDS).join(', ')})`);
    changes[key] = POLICY_FIELDS[key](raw);
  }
  if (Object.keys(changes).length === 0) throw new AdminChangeError('no changes given');
  return changes;
}

async function setPolicy(db, audit, pairs, ctx) {
  const changes = parsePolicyChanges(pairs);
  try {
    return await db.transaction(async (trx) => {
      const before = await trx('policies').where({ id: 1 }).forUpdate().first();
      const changed = Object.keys(changes).filter((k) => before[k] !== changes[k]);
      if (changed.length === 0) return { changed: [] };
      const after = await trx('policies').where({ id: 1 })
        .update({ ...changes, updated_at: trx.fn.now() }).returning('*').then((rows) => rows[0]);
      const pick = (row) => Object.fromEntries(changed.map((k) => [k, row[k]]));
      await trx('policy_history').insert({
        subject: 'policy', subject_id: '1', old_value: pick(before), new_value: pick(after),
        changed_fields: changed, actor: ctx.actor || 'cli',
      });
      await audit.recordCritical(trx, 'policy_changed', { success: true, details: { actor: ctx.actor || 'cli', fields: changed.join(',') } }, ctx);
      return { changed, before: pick(before), after: pick(after) };
    });
  } catch (err) {
    if (err.code === CHECK_VIOLATION) throw new AdminChangeError(`value out of the allowed range (${err.constraint || 'check constraint'})`);
    throw err;
  }
}

const byIdentifier = (identifier) =>
  looksLikeEmail(identifier) ? { 'users.email': normalizeEmail(identifier) } : { 'users.matric_or_staff_id': normalizeId(identifier) };

async function setRole(db, audit, identifier, roleName, ctx) {
  return db.transaction(async (trx) => {
    const role = await trx('roles').where({ name: roleName }).first('id', 'name');
    if (!role) throw new AdminChangeError(`unknown role "${roleName}"`);
    const user = await trx('users').join('roles', 'roles.id', 'users.role_id').where(byIdentifier(identifier))
      .forUpdate('users').first('users.id', 'users.matric_or_staff_id', 'roles.name as role');
    if (!user) throw new AdminChangeError(`no user found for "${identifier}"`);
    if (user.role === role.name) return { user, from: user.role, to: role.name, changed: false };

    await trx('users').where({ id: user.id }).update({ role_id: role.id });
    await trx('policy_history').insert({
      subject: 'user_role', subject_id: String(user.id), old_value: { role: user.role }, new_value: { role: role.name },
      changed_fields: ['role'], actor: ctx.actor || 'cli',
    });
    await audit.recordCritical(trx, 'role_changed', { userId: user.id, success: true, details: { actor: ctx.actor || 'cli', from: user.role, to: role.name } }, ctx);
    return { user, from: user.role, to: role.name, changed: true };
  });
}

async function changePermission(db, audit, action, roleName, serviceKey, ctx) {
  if (!['grant', 'revoke'].includes(action)) throw new AdminChangeError('action must be grant or revoke');
  return db.transaction(async (trx) => {
    const role = await trx('roles').where({ name: roleName }).first('id');
    if (!role) throw new AdminChangeError(`unknown role "${roleName}"`);
    const service = await trx('services').where({ key: serviceKey }).first('id');
    if (!service) throw new AdminChangeError(`unknown service "${serviceKey}"`);
    const keys = { role_id: role.id, service_id: service.id };
    const had = Boolean(await trx('role_permissions').where(keys).first('role_id'));
    if ((action === 'grant') === had) return { changed: false };

    if (action === 'grant') await trx('role_permissions').insert(keys);
    else await trx('role_permissions').where(keys).del();
    await trx('policy_history').insert({
      subject: 'role_permission', subject_id: `${roleName}:${serviceKey}`,
      old_value: { granted: had }, new_value: { granted: !had }, changed_fields: ['granted'], actor: ctx.actor || 'cli',
    });
    await audit.recordCritical(trx, 'permission_changed', { success: true, details: { actor: ctx.actor || 'cli', action, role: roleName, service: serviceKey } }, ctx);
    return { changed: true };
  });
}

async function listPermissions(db) {
  return db('role_permissions')
    .join('roles', 'roles.id', 'role_permissions.role_id')
    .join('services', 'services.id', 'role_permissions.service_id')
    .orderBy(['roles.name', 'services.key'])
    .select('roles.name as role', 'services.key as service');
}

async function policyHistory(db, { limit = 20 } = {}) {
  return db('policy_history').orderBy('id', 'desc').limit(limit);
}

module.exports = {
  setPolicy, setRole, changePermission, listPermissions, policyHistory, parsePolicyChanges,
  AdminChangeError, POLICY_FIELDS,
};
