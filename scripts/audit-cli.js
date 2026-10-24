'use strict';

// Audit log command line (FR-L3, FR-L4). Admin console screens come in Phase 6.
//   npm run audit -- verify
//   npm run audit -- search [filters] [--limit N]
//   npm run audit -- export --out FILE.csv [filters]
// Filters: --type EVENT  --user ID_OR_EMAIL  --from ISO_DATE  --to ISO_DATE  --success true|false  --ip ADDRESS
//
// Every run is itself recorded in the audit log (audit_verified / audit_exported),
// fail closed: if that record cannot be written, the command fails.

const fs = require('node:fs');
const pino = require('pino');
const { loadEnvFile } = require('../app/src/config');
const { createLogger } = require('../app/src/logger');
const { createCliAudit } = require('../app/src/audit/cliAudit');
const { verifyChain, readAnchor } = require('../app/src/audit/chain');
const { iterateRows, describeFilters } = require('../app/src/audit/query');
const { csvRow, EXPORT_COLUMNS } = require('../app/src/audit/csv');

const USAGE = [
  'Usage: npm run audit -- verify',
  '       npm run audit -- search [--type T] [--user ID|EMAIL] [--from ISO] [--to ISO] [--success true|false] [--ip IP] [--limit N]',
  '       npm run audit -- export --out FILE.csv [same filters]',
].join('\n');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (!flag.startsWith('--') || rest[i + 1] === undefined) throw new Error(`bad argument "${flag}"\n${USAGE}`);
    opts[flag.slice(2)] = rest[i + 1];
  }
  const filters = {
    type: opts.type,
    user: opts.user,
    from: opts.from,
    to: opts.to,
    ip: opts.ip,
    success: opts.success === undefined ? undefined : opts.success === 'true',
  };
  for (const d of ['from', 'to']) {
    if (filters[d] && Number.isNaN(Date.parse(filters[d]))) throw new Error(`--${d} must be a date like 2026-10-24 or 2026-10-24T10:00:00Z`);
  }
  return { command, opts, filters };
}

async function verify(cli) {
  const started = process.hrtime.bigint();
  const anchor = await readAnchor(cli.redis).catch(() => null);
  const result = await verifyChain(cli.db, cli.config.auditHmacKey, { anchor });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  await cli.audit.withCritical('audit_verified', {
    success: true,
    details: { actor: 'cli', ok: result.ok, checked: result.checked, reason: result.reason || 'none' },
  }, cli.ctx, async () => null);

  const lines = [`Checked ${result.checked} rows in ${Math.round(ms)} ms (anchor: ${anchor ? `seq ${anchor.seq}` : 'none recorded'}).`];
  if (result.ok) lines.push(`OK: the chain is intact up to seq ${result.lastSeq}.`);
  else lines.push(`BROKEN at seq ${result.firstBadSeq}: ${result.reason} (${result.detail}).`);
  return { code: result.ok ? 0 : 1, out: lines.join('\n') };
}

async function search(cli, filters, limit) {
  const out = [];
  for await (const row of iterateRows(cli.db, filters, { pageSize: Math.min(limit, 2000) })) {
    out.push([
      String(row.seq).padStart(6),
      row.occurred_at.toISOString(),
      row.event_type.padEnd(24),
      row.success ? 'ok  ' : 'FAIL',
      `user=${row.user_id ?? '-'}`,
      `ip=${row.ip ?? '-'}`,
      JSON.stringify(row.details),
    ].join('  '));
    if (out.length >= limit) break;
  }
  return { code: 0, out: out.length ? out.join('\n') : 'No matching audit rows.' };
}

async function exportCsv(cli, filters, outFile) {
  if (!outFile) return { code: 2, out: `--out FILE.csv is required\n${USAGE}` };
  const stream = fs.createWriteStream(outFile, { encoding: 'utf8' });
  const write = (chunk) => (stream.write(chunk) ? null : new Promise((r) => stream.once('drain', r)));
  let rows = 0;
  try {
    await write(csvRow(EXPORT_COLUMNS));
    for await (const row of iterateRows(cli.db, filters)) {
      await write(csvRow(EXPORT_COLUMNS.map((c) => row[c])));
      rows += 1;
    }
    await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));
    // Fail closed: an export that cannot be recorded is not kept.
    await cli.audit.withCritical('audit_exported', {
      success: true, details: { actor: 'cli', rows, filters: describeFilters(filters) },
    }, cli.ctx, async () => null);
  } catch (err) {
    stream.destroy();
    fs.rmSync(outFile, { force: true });
    throw err;
  }
  return { code: 0, out: `Exported ${rows} rows to ${outFile}.` };
}

async function main() {
  loadEnvFile();
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }
  const logger = createLogger({ level: process.env.LOG_LEVEL || 'info', destination: pino.destination(2) });
  const cli = createCliAudit({ logger });
  try {
    let result;
    if (parsed.command === 'verify') result = await verify(cli);
    else if (parsed.command === 'search') result = await search(cli, parsed.filters, Number(parsed.opts.limit || 50));
    else if (parsed.command === 'export') result = await exportCsv(cli, parsed.filters, parsed.opts.out);
    else result = { code: 2, out: USAGE };
    (result.code === 0 ? console.log : console.error)(result.out);
    process.exitCode = result.code;
  } finally {
    await cli.close();
  }
}

main().catch((err) => {
  console.error(`audit command failed: ${err.publicMessage || err.message}`);
  process.exit(1);
});
