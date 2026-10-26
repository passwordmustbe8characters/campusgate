'use strict';

const CHANNEL = 'cg:permissions:changed';

/**
 * Role-to-service permissions (FR-Z1), held IN MEMORY so a protected page
 * needs no database read to authorize a request (Phase 4 requires that).
 *
 * Every app process loads the map at start-up and reloads it when any process
 * announces a change on the Redis channel `cg:permissions:changed`
 * (clustering-safe: the map is never only in one process's memory).
 */
function createPermissions({ db, redis, logger }) {
  let map = null; // Map<roleName, Set<serviceKey>>
  let services = new Set();
  let subscriber = null;

  async function load() {
    const rows = await db('role_permissions')
      .join('roles', 'roles.id', 'role_permissions.role_id')
      .join('services', 'services.id', 'role_permissions.service_id')
      .select('roles.name as role', 'services.key as service');
    const next = new Map();
    for (const { role, service } of rows) {
      if (!next.has(role)) next.set(role, new Set());
      next.get(role).add(service);
    }
    services = new Set((await db('services').select('key')).map((s) => s.key));
    map = next;
    return map;
  }

  /** Load the map and subscribe to change notices. Call once at start-up. */
  async function start() {
    await load();
    if (typeof redis.duplicate === 'function') {
      subscriber = redis.duplicate();
      subscriber.on('error', (err) => logger.warn({ event: 'permissions_subscriber_error', err }, 'permission subscriber error'));
      subscriber.on('message', (channel) => {
        if (channel !== CHANNEL) return;
        load()
          .then(() => logger.info({ event: 'permissions_reloaded' }, 'permission map reloaded'))
          .catch((err) => logger.error({ event: 'permissions_reload_failed', err }, 'permission map reload failed'));
      });
      await subscriber.subscribe(CHANNEL);
    }
  }

  async function stop() {
    if (subscriber) await subscriber.quit().catch(() => subscriber.disconnect());
    subscriber = null;
  }

  /** Tell every app process (including this one) to reload. Call after committing a change. */
  async function announceChange() {
    await redis.publish(CHANNEL, String(Date.now()));
  }

  /** May this role use this service? Loads the map lazily if start() was not called. */
  async function can(role, service) {
    if (!map) await load();
    return Boolean(map.get(role) && map.get(role).has(service));
  }

  async function knownService(service) {
    if (!map) await load();
    return services.has(service);
  }

  return { start, stop, load, can, knownService, announceChange, CHANNEL };
}

/**
 * Express middleware: the signed-in user's role must be granted `service`.
 * Expects req.account (Phase 2 interim ticket; the JWT session from Phase 4).
 */
function requirePermission(permissions, service) {
  const middleware = async (req, res, next) => {
    if (!(await permissions.knownService(service))) {
      // A programming error (route asks for a service that does not exist): deny, loudly.
      req.log.error({ event: 'unknown_service', service }, 'route requires an unknown service');
      return res.status(403).json({ error: 'Forbidden' });
    }
    const role = req.account && req.account.role;
    if (!role) return res.status(401).json({ error: 'Please sign in again.', restart: true });
    // FR-Z4: a guest's session carries the services its voucher grants (signed, so it cannot be altered).
    const viaVoucher = role === 'guest' && Array.isArray(req.account.services) && req.account.services.includes(service);
    if (!viaVoucher && !(await permissions.can(role, service))) {
      req.log.info({ event: 'permission_denied', userId: req.account.userId, role, service }, 'permission denied');
      return res.status(403).json({ error: 'You do not have access to this service.' });
    }
    return next();
  };
  middleware.requiresService = service;
  return middleware;
}

module.exports = { createPermissions, requirePermission, CHANNEL };
