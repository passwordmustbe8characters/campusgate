'use strict';

/**
 * Reads the single active policy row (id = 1).
 *
 * Read per request for now, so admin changes apply without a restart.
 * TODO(Phase 5): cache this row (e.g. in Redis or per process) with
 * invalidation on policy change, instead of one DB read per login.
 */
async function getPolicy(db) {
  const policy = await db('policies').where({ id: 1 }).first();
  if (!policy) throw new Error('policies row id=1 is missing; run migrations');
  return policy;
}

module.exports = { getPolicy };
