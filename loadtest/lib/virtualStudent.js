'use strict';

/**
 * One virtual student (FR-P8): behaves like a browser on the sign-in page.
 *   1. GET /login (cookies + CSRF token)
 *   2. POST /auth/login
 *        200 signed_in        -> GET /home, done
 *        503 { queued }       -> waiting room: join, poll /queue/status until admitted, then sign in again
 *        429 / other 503      -> wait Retry-After, try again
 *        timeout / network    -> wait a little, try again (an impatient student)
 *        401                  -> failed (wrong password or refused)
 *   Gives up after `maxRetries` retries or `giveUpMs` in total.
 * Every step is real HTTP to the real server: real bcrypt, database and Redis work.
 */
class CookieJar {
  constructor() { this.map = new Map(); }

  take(res) {
    for (const line of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '') this.map.delete(name);
      else this.map.set(name, value);
    }
  }

  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runStudent({ baseUrl, identifier, password, timeoutMs, maxRetries, giveUpMs, userAgent, pollMs = 3000, extraHeaders = {} }) {
  const jar = new CookieJar();
  const started = Date.now();
  const rec = {
    identifier, outcome: 'gave_up', attempts: 0, timeouts: 0, rateLimited: 0, queued: false,
    queueWaitMs: 0, signInMs: null, loginRequestMs: [], httpErrors: 0, finalStatus: null,
  };

  const call = async (path, { method = 'GET', body, csrf } = {}) => {
    const headers = { ...extraHeaders, Cookie: jar.header(), 'User-Agent': userAgent };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(`${baseUrl}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    jar.take(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML page */ }
    return { status: res.status, json, text, retryAfter: Number(res.headers.get('retry-after')) || 0 };
  };

  let csrf = null;
  const timeLeft = () => giveUpMs - (Date.now() - started);

  while (rec.attempts <= maxRetries && timeLeft() > 0) {
    try {
      if (!csrf) {
        const page = await call('/login');
        const m = /name="csrf-token" content="([^"]+)"/.exec(page.text);
        if (!m) throw Object.assign(new Error('no csrf token'), { kind: 'http' });
        csrf = m[1];
      }
      rec.attempts += 1;
      const t0 = Date.now();
      const res = await call('/auth/login', { method: 'POST', body: { identifier, password }, csrf });
      rec.loginRequestMs.push(Date.now() - t0);
      rec.finalStatus = res.status;

      if (res.status === 200 && res.json && res.json.status === 'signed_in') {
        rec.signInMs = Date.now() - started;
        rec.outcome = 'success';
        await call('/home').catch(() => {}); // login once: the portal home with the same token
        return rec;
      }
      if (res.status === 503 && res.json && res.json.queued) {
        rec.queued = true;
        rec.attempts -= 1; // being queued is not a failed attempt
        const q0 = Date.now();
        await call('/queue/join', { method: 'POST', body: {}, csrf });
        for (;;) {
          if (timeLeft() <= 0) return rec;
          await sleep(pollMs);
          const s = await call('/queue/status');
          if (s.json && s.json.state === 'admitted') break;
          if (s.json && s.json.state === 'expired') await call('/queue/join', { method: 'POST', body: {}, csrf });
        }
        rec.queueWaitMs += Date.now() - q0;
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        if (res.status === 429) rec.rateLimited += 1;
        await sleep(Math.min(timeLeft(), (res.retryAfter || 2) * 1000));
        continue;
      }
      if (res.status === 401) {
        rec.outcome = 'failed';
        return rec;
      }
      rec.httpErrors += 1;
      await sleep(1000);
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') rec.timeouts += 1;
      else rec.httpErrors += 1;
      await sleep(1000 + Math.random() * 1000); // impatient retry
    }
  }
  return rec;
}

module.exports = { runStudent, CookieJar };
