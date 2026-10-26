'use strict';

const CHANNEL = 'cg:windows:changed';
const LAGOS_UTC_OFFSET_MIN = 60; // West Africa Time, no daylight saving

const toMinutes = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
};
const toClock = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Lagos date ("YYYY-MM-DD") and minute of day for a Date. */
function lagosNow(date) {
  const shifted = new Date(date.getTime() + LAGOS_UTC_OFFSET_MIN * 60000);
  return { day: shifted.toISOString().slice(0, 10), minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

/**
 * Access windows (FR-Z2), held IN MEMORY like the permission map, so checking
 * a request needs no database read. Every process reloads when an admin
 * changes a window (Redis pub/sub on cg:windows:changed).
 *
 * Rule for a service on a given (Lagos) day:
 *  - no windows today            -> open to everyone;
 *  - inside a window that matches the user's level and faculty -> open;
 *  - after the day's last window has closed -> open to everyone (catch-up);
 *  - otherwise closed, with the time the user's own window opens (if later
 *    today) or the catch-up time.
 */
function createAccessWindows({ db, redis, logger, now = () => new Date() }) {
  let windows = null;
  let subscriber = null;

  async function load() {
    const rows = await db('access_windows').join('services', 'services.id', 'access_windows.service_id')
      .select('access_windows.id', 'services.key as service', 'level', 'faculty',
        db.raw("to_char(on_date, 'YYYY-MM-DD') AS on_date"), db.raw("to_char(start_time, 'HH24:MI') AS start_time"),
        db.raw("to_char(end_time, 'HH24:MI') AS end_time"))
      .orderBy('start_time');
    windows = rows.map((w) => ({ ...w, start: toMinutes(w.start_time), end: toMinutes(w.end_time) }));
    return windows;
  }

  async function start() {
    await load();
    if (typeof redis.duplicate === 'function') {
      subscriber = redis.duplicate();
      subscriber.on('error', (err) => logger.warn({ event: 'windows_subscriber_error', err }, 'access-window subscriber error'));
      subscriber.on('message', (channel) => {
        if (channel !== CHANNEL) return;
        load().catch((err) => logger.error({ event: 'windows_reload_failed', err }, 'access-window reload failed'));
      });
      await subscriber.subscribe(CHANNEL);
    }
  }

  async function stop() {
    if (subscriber) await subscriber.quit().catch(() => subscriber.disconnect());
    subscriber = null;
  }

  const announceChange = () => redis.publish(CHANNEL, String(Date.now()));

  /** { open: true } or { open: false, message, opensAt }. account = { level, faculty }. */
  async function check(service, account) {
    if (!windows) await load();
    const { day, minute } = lagosNow(now());
    const today = windows.filter((w) => w.service === service && (w.on_date === null || w.on_date === day));
    if (today.length === 0) return { open: true };
    const matches = (w) => (w.level === null || w.level === account.level)
      && (w.faculty === null || (account.faculty && w.faculty.toLowerCase() === String(account.faculty).toLowerCase()));
    if (today.some((w) => matches(w) && minute >= w.start && minute < w.end)) return { open: true };
    const catchUp = Math.max(...today.map((w) => w.end));
    if (minute >= catchUp) return { open: true };
    const mine = today.filter((w) => matches(w) && w.start > minute).sort((a, b) => a.start - b.start)[0];
    const opensAt = toClock(mine ? Math.min(mine.start, catchUp) : catchUp);
    return {
      open: false,
      opensAt,
      message: mine && mine.start < catchUp
        ? `Your window for this service opens at ${opensAt} today (Lagos time).`
        : `This service is reserved for other groups right now. It opens to everyone at ${opensAt} today (Lagos time).`,
    };
  }

  return { start, stop, load, check, announceChange, CHANNEL };
}

/** Express middleware after requireSession: enforce the service's access windows. */
function requireWindow(accessWindows, service) {
  const middleware = async (req, res, next) => {
    const result = await accessWindows.check(service, { level: req.account.level, faculty: req.account.faculty });
    if (result.open) return next();
    req.log.info({ event: 'access_window_closed', userId: req.account.userId, service }, 'outside access window');
    if (req.method === 'GET') {
      return res.status(403).render('window-closed', { title: 'Not open yet', csrfToken: '', message: result.message, opensAt: result.opensAt });
    }
    return res.status(403).json({ error: result.message, opensAt: result.opensAt });
  };
  middleware.requiresWindow = service;
  return middleware;
}

module.exports = { createAccessWindows, requireWindow, lagosNow, CHANNEL };
