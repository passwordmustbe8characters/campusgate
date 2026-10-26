'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

/**
 * Start CampusGate (app/src/server.js) as a child process with the given
 * settings, and wait until /health answers. Returns { url, stop() }.
 * Used by calibrate and the experiments so each run has known settings.
 */
async function startServer({ port, workers = 1, env = {} }) {
  const child = spawn(process.execPath, [path.join(ROOT, 'app', 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      CLUSTER_WORKERS: String(workers),
      LOG_LEVEL: 'warn',
      // Every virtual student comes from this one machine: lift the per-IP limit for test runs.
      RATE_LIMIT_IP_PER_MIN: '1000000', // the configured maximum
      RATE_LIMIT_ACCOUNT_PER_MIN: '1000',
      ...env,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited during start-up (code ${child.exitCode})`);
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill('SIGTERM');
      throw new Error('server did not become healthy within 60 s');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (workers > 1) await new Promise((r) => setTimeout(r, 2000)); // let every worker finish starting
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 15000).unref();
  });
  return { url, stop };
}

module.exports = { startServer };
