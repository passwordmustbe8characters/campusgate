'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runStudent } = require('./virtualStudent');
const { generateStudents } = require('../../db/seed/lib/studentData');

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const mean = (values) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

/**
 * Rush-hour load generator (FR-P8). `users` virtual students arrive spread
 * evenly over `rampSec` seconds, each signing in as a different seeded
 * student account (the first SEED_REGISTERED_STUDENTS records have accounts).
 * Returns { summary, rows } and can write a CSV per student.
 */
async function runRushHour({
  baseUrl, users, rampSec = 30, password, timeoutMs = 10000, maxRetries = 3, giveUpMs = 10 * 60 * 1000,
  firstAccount = 0, onProgress, extraHeaders = {},
}) {
  const accounts = generateStudents(firstAccount + users).slice(firstAccount).map((s) => s.matric_no);
  const started = Date.now();
  let done = 0;
  const rows = await Promise.all(accounts.map(async (identifier, i) => {
    await new Promise((r) => setTimeout(r, Math.round((i / users) * rampSec * 1000)));
    const arrivalMs = Date.now() - started;
    const rec = await runStudent({
      baseUrl, identifier, password, timeoutMs, maxRetries, giveUpMs, extraHeaders, userAgent: `CampusGate-loadtest/1 (student ${i})`,
    });
    done += 1;
    if (onProgress) onProgress(done, users);
    return { ...rec, arrivalMs };
  }));
  const wallSec = (Date.now() - started) / 1000;
  return { summary: summarize(rows, { users, rampSec, timeoutMs, maxRetries, wallSec }), rows };
}

function summarize(rows, params) {
  const ok = rows.filter((r) => r.outcome === 'success');
  const signIn = ok.map((r) => r.signInMs);
  const requests = rows.flatMap((r) => r.loginRequestMs);
  return {
    ...params,
    wallSec: Math.round(params.wallSec * 10) / 10,
    succeeded: ok.length,
    failed: rows.filter((r) => r.outcome === 'failed').length,
    gaveUp: rows.filter((r) => r.outcome === 'gave_up').length,
    successRatePct: Math.round((ok.length / rows.length) * 1000) / 10,
    signInMeanMs: mean(signIn),
    signInP95Ms: percentile(signIn, 95),
    loginRequestMeanMs: mean(requests),
    loginRequestP95Ms: percentile(requests, 95),
    timeouts: rows.reduce((s, r) => s + r.timeouts, 0),
    rateLimited: rows.reduce((s, r) => s + r.rateLimited, 0),
    httpErrors: rows.reduce((s, r) => s + r.httpErrors, 0),
    queuedStudents: rows.filter((r) => r.queued).length,
    queueWaitMeanMs: mean(rows.filter((r) => r.queued).map((r) => r.queueWaitMs)),
    signInsPerSec: Math.round((ok.length / params.wallSec) * 100) / 100,
  };
}

const CSV_COLUMNS = ['identifier', 'arrivalMs', 'outcome', 'signInMs', 'attempts', 'timeouts', 'rateLimited', 'queued', 'queueWaitMs', 'httpErrors', 'finalStatus'];

function writeCsv(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [CSV_COLUMNS.join(',')].concat(rows.map((r) => CSV_COLUMNS.map((c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))).join(',')));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

module.exports = { runRushHour, summarize, writeCsv, percentile };
