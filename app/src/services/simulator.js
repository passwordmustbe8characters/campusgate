'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { randomToken } = require('./secrets');

const ROOT = path.join(__dirname, '..', '..', '..');
const K = { lock: 'cg:sim:lock', token: 'cg:sim:token', status: 'cg:sim:status' };
const MAX_USERS = 2000;
const MAX_RUN_SEC = 3600;

class SimulatorError extends Error {}

/**
 * "Simulate rush hour" (FR-P8): an admin launches the virtual-student load
 * generator (loadtest/run.js) against this running system, in a separate
 * process so it does not share this server's event loop. One run at a time
 * across all app processes (Redis lock). Refused in production.
 *
 * Every virtual student comes from this machine's IP, so the run gets a
 * one-time token (X-CampusGate-Simulation) that lets ITS requests past the
 * per-IP rate limit only; per-account limits, lockout and the waiting room
 * all still apply.
 */
function createSimulator({ redis, config, logger }) {
  async function start({ users, rampSec, actor }) {
    if (config.nodeEnv === 'production') throw new SimulatorError('The rush-hour simulator is disabled in production.');
    const n = Number(users);
    const ramp = Number(rampSec);
    if (!Number.isInteger(n) || n < 1 || n > MAX_USERS) throw new SimulatorError(`Number of students must be 1 to ${MAX_USERS}.`);
    if (!Number.isInteger(ramp) || ramp < 0 || ramp > 600) throw new SimulatorError('Arrival period must be 0 to 600 seconds.');
    if ((await redis.set(K.lock, actor, 'EX', MAX_RUN_SEC, 'NX')) !== 'OK') throw new SimulatorError('A simulation is already running.');

    const token = randomToken(24);
    await redis.set(K.token, token, 'EX', MAX_RUN_SEC);
    const status = { state: 'running', users: n, rampSec: ramp, startedAt: new Date().toISOString(), actor };
    await redis.set(K.status, JSON.stringify(status), 'EX', 24 * 3600);

    const child = spawn(process.execPath, [
      path.join(ROOT, 'loadtest', 'run.js'),
      '--url', `http://127.0.0.1:${config.port}`, '--users', String(n), '--ramp', String(ramp), '--sim-token', token,
    ], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {}); // progress lines
    child.on('exit', async (code) => {
      let summary = null;
      try { summary = JSON.parse(out); } catch { /* failed run */ }
      const done = { ...status, state: code === 0 && summary ? 'finished' : 'failed', finishedAt: new Date().toISOString(), summary };
      try {
        await redis.set(K.status, JSON.stringify(done), 'EX', 24 * 3600);
        await redis.del(K.token, K.lock);
      } catch (err) {
        logger.warn({ event: 'simulation_status_failed', err }, 'could not record simulation result');
      }
      logger.info({ event: 'simulation_finished', state: done.state, users: n }, 'rush-hour simulation finished');
    });
    logger.info({ event: 'simulation_started', users: n, rampSec: ramp }, 'rush-hour simulation started');
    return status;
  }

  async function status() {
    const raw = await redis.get(K.status);
    return raw ? JSON.parse(raw) : { state: 'idle' };
  }

  /** Is this the token of the run in progress? (one Redis read; only called when the header is present) */
  async function isRunToken(value) {
    if (typeof value !== 'string' || value.length > 64) return false;
    const current = await redis.get(K.token);
    return Boolean(current) && current === value;
  }

  return { start, status, isRunToken };
}

module.exports = { createSimulator, SimulatorError, MAX_USERS };
